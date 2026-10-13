import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Board, Note, NotesFile, NoteStatus } from '../types'
import { NOTES_FILE, askAbout, buildPrompt, listText, noteIdsIn, parseNotes, resolveNote, serializeNotes, tally } from './model'

const TOOL = 'resolve_note'
const TOOL_ID = 'mcp__nvim-notes__resolve_note'
const ASK = 'ask_about_note'
const ASK_ID = 'mcp__nvim-notes__ask_about_note'
const POLL_MS = 1_500
const AUTO_SEND_MS = 4_000
const CLAIM_SETTLE_MS = 300

const boardAtom = atom({ plugin: 'nvim-notes', key: 'board' } as const, { path: null, notes: [], error: null } as Board)
const watchingAtom = atom({ plugin: 'nvim-notes', key: 'isWatching' } as const, false)

const mod: {
  path: string | undefined
  locateError: string | null
  cwd: string
  sessionId: string
  mtimeMs: number
  isAuto: boolean
  isWatching: boolean
  poller: Timer | undefined
  autoSend: Timer | undefined
  isSending: boolean
  notesTurn: { turnId: string; ids: Set<string> } | undefined
} = {
  path: undefined,
  locateError: null,
  cwd: '',
  sessionId: '',
  mtimeMs: -1,
  isAuto: false,
  isWatching: false,
  poller: undefined,
  autoSend: undefined,
  isSending: false,
  notesTurn: undefined,
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const setBoard = (
  $: EngineInterface,
  notes: readonly Note[],
  error: string | null,
) => update($, boardAtom, () => ({ path: mod.path ?? null, notes: [...notes], error }))

const locate = async ($: EngineInterface, cwd: string) => {
  const run = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'], { cwd })
  if (run.exitCode !== 0) throw new Error(`not in a git repository (${run.stderr.trim()})`)

  return `${run.stdout.trim()}/${NOTES_FILE}`
}

const requirePath = () => {
  if (mod.path === undefined) throw new Error(mod.locateError ?? 'the notes file is not located yet')

  return mod.path
}

const readFile = async ($: EngineInterface, path: string): Promise<NotesFile> => parseNotes(await $.fs.read(path))

const writeFile = async ($: EngineInterface, path: string, file: NotesFile) => {
  await $.fs.write(path, serializeNotes(file))
  mod.mtimeMs = (await $.fs.stat(path)).mtimeMs
  await setBoard($, file.notes, null)
}

// Tool calls can run in parallel; each read-modify-write of the notes file waits for the one before it.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)

  return run
}

const mutate = ($: EngineInterface, change: (notes: readonly Note[]) => Note[]) => serial(() => mutateNow($, change))

const mutateNow = async ($: EngineInterface, change: (notes: readonly Note[]) => Note[]) => {
  const path = requirePath()
  const file = await readFile($, path)
  const notes = change(file.notes)
  await writeFile($, path, { ...file, notes })

  return notes
}

// Another session may claim the same notes between our read and write; the read-back after a pause shows who won.
const claim = ($: EngineInterface, statuses: readonly NoteStatus[]) => serial(() => claimNow($, statuses))

const claimNow = async ($: EngineInterface, statuses: readonly NoteStatus[]) => {
  const path = requirePath()
  const file = await readFile($, path)
  const ids = new Set(file.notes.filter(note => statuses.includes(note.status)).map(note => note.id))
  if (ids.size === 0) return []
  const claimed = file.notes.map(note => (ids.has(note.id) ? { ...note, status: 'sent' as const, claimedBy: mod.sessionId } : note))
  await writeFile($, path, { ...file, notes: claimed })
  await $.clock.sleep(CLAIM_SETTLE_MS)
  const after = await readFile($, path)
  await setBoard($, after.notes, null)

  return after.notes.filter(note => ids.has(note.id) && note.status === 'sent' && note.claimedBy === mod.sessionId)
}

const send = async ($: EngineInterface, statuses: readonly NoteStatus[]) => {
  const won = await claim($, statuses)
  if (won.length === 0) return 0
  // A note sent again belongs to the turn that will read this prompt, not to one still running.
  for (const note of won) mod.notesTurn?.ids.delete(note.id)
  const root = (await readFile($, requirePath())).root
  const text = buildPrompt(won, root, mod.cwd, { resolve: TOOL_ID, ask: ASK_ID })
  const ids = new Set(won.map(note => note.id))
  // A command.run hook may not submit: the prompt would wait on the turn the command holds.
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch(async error => {
      // Back to open, not queued: a queued note would be picked up and fail again on the next poll.
      await mutate($, notes =>
        notes.map(note => {
          if (!ids.has(note.id) || note.claimedBy !== mod.sessionId) return note
          const { claimedBy: _, ...rest } = note

          return { ...rest, status: 'open' as const }
        }),
      ).catch(() => undefined)
      $.ui.toast(`nvim-notes: could not submit the notes: ${message(error)}`)
    })
  })

  return won.length
}

// Notes the turn neither resolved nor asked about: an ended answer is likely a question asked in the chat, so it goes to Neovim.
const settleTurn = async ($: EngineInterface, ids: ReadonlySet<string>, answer: string) => {
  let asked = 0
  await mutate($, notes =>
    notes.map(note => {
      if (!ids.has(note.id) || note.status !== 'sent' || note.claimedBy !== mod.sessionId) return note
      if (answer === '') {
        const { claimedBy: _, ...rest } = note

        return { ...rest, status: 'open' as const }
      }
      asked += 1

      return askAbout([note], note.id, answer)[0] ?? note
    }),
  )
  if (asked > 0) $.ui.toast(`nvim-notes: ${asked} note${asked === 1 ? '' : 's'} waiting on your answer in Neovim`)
}

const sendQueued = async ($: EngineInterface) => {
  if (mod.isSending) return
  mod.isSending = true
  try {
    const count = await send($, ['queued'])
    if (count > 0) $.ui.toast(`nvim-notes: sent ${count} queued note${count === 1 ? '' : 's'} to Claude`)
  } finally {
    mod.isSending = false
  }
}

const scheduleAutoSend = ($: EngineInterface, notes: readonly Note[]) => {
  mod.autoSend?.cancel()
  mod.autoSend = undefined
  if (!notes.some(note => note.status === 'open')) return
  mod.autoSend = $.clock.after(AUTO_SEND_MS, () => {
    mod.autoSend = undefined
    void send($, ['open', 'queued']).catch(error => $.ui.toast(`nvim-notes: auto-send failed: ${message(error)}`))
  })
}

const load = async ($: EngineInterface) => {
  const path = mod.path
  if (path === undefined || !mod.isWatching) return
  if (!(await $.fs.exists(path))) {
    if (mod.mtimeMs !== 0) {
      mod.mtimeMs = 0
      await setBoard($, [], null)
    }

    return
  }
  const { mtimeMs } = await $.fs.stat(path)
  if (mtimeMs === mod.mtimeMs) return
  let file: NotesFile
  try {
    file = await readFile($, path)
  } catch (error) {
    // Left unrecorded so the next poll reads it again: Neovim may be mid-write.
    await setBoard($, (await read($, boardAtom)).notes, `${path}: ${message(error)}`)

    return
  }
  mod.mtimeMs = mtimeMs
  await setBoard($, file.notes, null)
  if (file.notes.some(note => note.status === 'queued')) await sendQueued($)
  if (mod.isAuto) scheduleAutoSend($, file.notes)
}

const tick = async ($: EngineInterface) => {
  // /clear empties $.state without a new session.start; put the switch and the notes back.
  if (!(await read($, watchingAtom))) {
    await update($, watchingAtom, () => true)
    mod.mtimeMs = -1
  }
  await load($)
}

const stopWatching = () => {
  mod.poller?.cancel()
  mod.poller = undefined
  mod.autoSend?.cancel()
  mod.autoSend = undefined
}

const startWatching = async ($: EngineInterface) => {
  stopWatching()
  mod.mtimeMs = -1
  await load($)
  mod.poller = $.clock.every(POLL_MS, () => {
    void tick($).catch(error => setBoard($, [], message(error)))
  })
}

const start = async ($: EngineInterface, cwd: string) => {
  mod.cwd = cwd
  try {
    mod.path = await locate($, cwd)
    mod.locateError = null
  } catch (error) {
    mod.path = undefined
    mod.locateError = message(error)
  }
  if (mod.isWatching) await startWatching($)
}

const watch = async ($: EngineInterface) => {
  const path = requirePath()
  mod.isWatching = true
  await update($, watchingAtom, () => true)
  await startWatching($)

  return `This session now picks up notes queued from Neovim (${path}).`
}

const unwatch = async ($: EngineInterface) => {
  mod.isWatching = false
  stopWatching()
  await update($, watchingAtom, () => false)

  return 'This session no longer picks up notes from Neovim.'
}

const sendText = async ($: EngineInterface) => {
  const count = await send($, ['open', 'queued'])

  return count === 0 ? 'No open notes to send.' : `Sent ${count} note${count === 1 ? '' : 's'} to Claude.`
}

const runCommand = async ($: EngineInterface, args: string) => {
  const [verb = 'send'] = args.trim().split(/\s+/).filter(Boolean)
  if (verb === 'send') return sendText($)
  if (verb === 'watch') return watch($)
  if (verb === 'unwatch') return unwatch($)
  if (verb === 'list') return listText((await readFile($, requirePath())).notes)
  if (verb === 'reopen') {
    const notes = await mutate($, all =>
      all.map(note => {
        if (note.status !== 'sent') return note
        const { claimedBy: _, ...rest } = note

        return { ...rest, status: 'open' as const }
      }),
    )

    return `${tally(notes).open} open notes.`
  }
  if (verb === 'clear') {
    const before = (await readFile($, requirePath())).notes.length
    const notes = await mutate($, all => all.filter(note => note.status !== 'done'))

    return `Cleared ${before - notes.length} resolved notes.`
  }
  if (verb === 'path') return requirePath()

  return `Unknown subcommand "${verb}". Use send, watch, unwatch, list, reopen, clear or path.`
}

export const register: Register = (on, options) => {
  mod.isAuto = options.delivery === 'auto'

  on('session.start', async ($, e, next) => {
    mod.sessionId = await $.session.id()
    mod.isWatching = await read($, watchingAtom)
    await $.tool.register({
      name: TOOL,
      description:
        'Marks a review note the person left in Neovim as handled, with a one-line reply they will see next to the code. Call it once per note after making the change or answering it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The note id, as given in the "### Note <id>" heading.' },
          reply: { type: 'string', description: 'One line saying what was done, or the answer.' },
        },
        required: ['id', 'reply'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: ASK,
      description:
        'Asks the person a question about one of their Neovim review notes when it is unclear what they want. They answer from Neovim and the note comes back to you with the answer. Use it instead of asking in the chat, then carry on with the other notes.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The note id, as given in the "### Note <id>" heading.' },
          question: { type: 'string', description: 'The question, written so it makes sense on its own next to the code.' },
        },
        required: ['id', 'question'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'notes',
      description: 'Send the open Neovim notes to Claude (or: watch, unwatch, list, reopen, clear, path)',
      argumentHint: '[send|watch|unwatch|list|reopen|clear|path]',
    })
    await start($, e.cwd)

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const path = mod.path ?? (await locate($, e.cwd).catch(() => undefined))
    if (path === undefined) return result

    return { ...result, watchPaths: [...(result.watchPaths ?? []), path] }
  })

  on('classic.FileChanged', async ($, e, next) => {
    if (e.file_path === mod.path) await load($)

    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    await start($, e.new_cwd)

    return result
  })

  on('command.run', { command: 'notes' }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(
    (_$, _e, next) => ({ text: `nvim-notes: /notes failed: ${next.error.message ?? next.error.kind}` }),
  )

  on('tool.call', { tool: 'mcp__nvim-notes__resolve_note' }, async ($, e) => {
    const { id, reply } = e as unknown as { id?: unknown; reply?: unknown }
    if (typeof id !== 'string' || typeof reply !== 'string') return { deny: 'resolve_note needs a string id and reply' }
    const at = new Date(await $.clock.now()).toISOString()
    try {
      await mutate($, notes => resolveNote(notes, id, reply, at))
    } catch (error) {
      return { deny: message(error) }
    }

    return { result: `Note ${id} marked done.` }
  }).catch((_$, _e, next) => ({ deny: `resolve_note failed: ${next.error.message ?? next.error.kind}` }))

  on('tool.call', { tool: 'mcp__nvim-notes__ask_about_note' }, async ($, e) => {
    const { id, question } = e as unknown as { id?: unknown; question?: unknown }
    if (typeof id !== 'string' || typeof question !== 'string' || question.trim() === '') {
      return { deny: 'ask_about_note needs a string id and a question' }
    }
    try {
      await mutate($, notes => askAbout(notes, id, question.trim()))
    } catch (error) {
      return { deny: message(error) }
    }

    return { result: `Question on note ${id} sent to Neovim; carry on with the other notes.` }
  }).catch((_$, _e, next) => ({ deny: `ask_about_note failed: ${next.error.message ?? next.error.kind}` }))

  // A notes turn asks through ask_about_note, so the question reaches Neovim instead of a dialog nobody is watching.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (mod.notesTurn !== undefined && e.agentId === undefined) {
      return { deny: `You are working through Neovim notes; ask with ${ASK_ID} and the note id instead. The person answers from Neovim.` }
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const ids = new Set(noteIdsIn(e.text))
    const board = await read($, boardAtom)
    const isOurs = board.notes.some(note => ids.has(note.id) && note.status === 'sent' && note.claimedBy === mod.sessionId)
    mod.notesTurn = isOurs ? { turnId: e.turnId, ids } : undefined

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const turn = mod.notesTurn
    if (turn === undefined || e.agentId !== undefined || e.turnId !== turn.turnId) return done
    mod.notesTurn = undefined
    await settleTurn($, turn.ids, e.reason === 'answer' ? e.answer.trim() : '').catch(error =>
      $.ui.toast(`nvim-notes: could not update the notes after the turn: ${message(error)}`),
    )

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, watchingAtom))) return next(e)
    const board = await read($, boardAtom)
    const counts = tally(board.notes)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (board.error !== null) {
      return (
        <Box>
          <Text color="red">nvim notes: {board.error}</Text>
        </Box>
      )
    }
    const parts = [
      counts.open > 0 ? `${counts.open} open` : '',
      counts.queued > 0 ? `${counts.queued} queued` : '',
      counts.sent > 0 ? `${counts.sent} with Claude` : '',
      counts.question > 0 ? `${counts.question} waiting on you in Neovim` : '',
    ].filter(Boolean)

    return (
      <Box>
        <Text color="yellow">✎ nvim notes: {parts.length === 0 ? 'watching' : parts.join(' · ')} </Text>
        {counts.open > 0 && (
          <Button
            key="send"
            label={`Send ${counts.open}`}
            onPress={() => {
              void sendText($).then(
                text => $.ui.toast(text),
                error => $.ui.toast(`nvim-notes: ${message(error)}`),
              )
            }}
          />
        )}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') stopWatching()

    return next(e)
  })
}
