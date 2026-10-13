import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import type { Note, NotesFile } from '../types'

const PATH = '/repo/.git/claude-notes.json'
const TOOL = 'mcp__nvim-notes__resolve_note'

const note = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  file: 'src/app.go',
  start: 10,
  end: 12,
  snippet: 'func main() {}',
  text: `fix ${id}`,
  status: 'open',
  createdAt: '2026-10-13T10:00:00Z',
  ...over,
})

const fake = (on: On, notes: Note[] | undefined) => {
  const clock = mock.clock(on)
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let tick = 1
  const put = (list: Note[]) => {
    const file: NotesFile = { version: 1, root: '/repo', notes: list }
    files.set(PATH, { text: JSON.stringify(file), mtimeMs: tick++ })
  }
  const raw = (text: string) => files.set(PATH, { text, mtimeMs: tick++ })
  if (notes !== undefined) put(notes)
  const prompts: string[] = []
  const toasts: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', async () => ({ value: undefined as never }))
  on('session.id', async () => ({ value: 'this-session' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    if (e.argv.join(' ') !== 'git rev-parse --absolute-git-dir') throw new Error(`unexpected: ${e.argv.join(' ')}`)

    return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) }))
  on('fs.stat', async (_$, e) => {
    const file = files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } as never }
  })
  on('fs.read', async (_$, e) => {
    const file = files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: file.text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: tick++ })

    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'AskUserQuestion' }, async () => ({ result: 'answered in the dialog' }) as never)
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const stored = () => (JSON.parse(files.get(PATH)?.text ?? '{"notes":[]}') as NotesFile).notes

  return { clock, prompts, toasts, put, raw, stored }
}


const boot = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
}

const notes = ($: Engine, args = '') =>
  $.command.run({ command: 'notes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  for (let step = 0; step < 5; step++) await clock.advance(100)
}

const run = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, args = '') => {
  const ran = notes($, args)
  await settle(clock)

  return (await ran).text
}

const watching = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await boot($, clock)
  expect(await run($, clock, 'watch')).toBe(`This session now picks up notes queued from Neovim (${PATH}).`)
}

const BAND = {
  plugin: 'nvim-notes',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, bodyColumns: 100 } as unknown as RenderPropsOf['AbovePrompt'],
}

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text', text: /nvim notes/ }))?.text
  await ui.unmount()

  return text
}

test('a session that has not opted in shows nothing and picks up nothing', async ($, on) => {
  const f = fake(on, [note('a1'), note('b2', { status: 'queued' })])
  await boot($, f.clock)
  await f.clock.advance(3_000)

  expect(await bandText($)).toBeUndefined()
  expect(f.prompts).toHaveLength(0)
  expect(f.stored().map(one => one.status)).toEqual(['open', 'queued'])
})

test('/notes watch opts in: queued notes are sent without /notes, and only those', async ($, on) => {
  const f = fake(on, [note('a1')])
  await watching($, f.clock)
  expect(await bandText($)).toBe('✎ nvim notes: 1 open ')

  f.put([note('a1'), note('b2', { status: 'queued' }), note('c3', { status: 'queued' })])
  await f.clock.advance(1_500)
  await settle(f.clock)

  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0]).toContain('2 review notes')
  expect(f.prompts[0]).not.toContain('Note a1')
  expect(f.stored().map(one => one.status)).toEqual(['open', 'sent', 'sent'])
  expect(f.toasts).toContain('nvim-notes: sent 2 queued notes to Claude')

  await f.clock.advance(1_500)
  await settle(f.clock)
  expect(f.prompts).toHaveLength(1)
})

test('/notes unwatch stops the pickup and hides the band', async ($, on) => {
  const f = fake(on, [])
  await watching($, f.clock)
  expect(await run($, f.clock, 'unwatch')).toBe('This session no longer picks up notes from Neovim.')

  f.put([note('a1', { status: 'queued' })])
  await f.clock.advance(3_000)
  expect(f.prompts).toHaveLength(0)
  expect(await bandText($)).toBeUndefined()
})

test('a note another session claims first is not sent here', async ($, on) => {
  const f = fake(on, [note('a1'), note('b2')])
  await boot($, f.clock)

  const ran = notes($)
  await f.clock.advance(100)
  f.put(f.stored().map(one => (one.id === 'a1' ? { ...one, claimedBy: 'other-session' } : one)))
  await settle(f.clock)

  expect((await ran).text).toBe('Sent 1 note to Claude.')
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0]).toContain('### Note b2')
  expect(f.prompts[0]).not.toContain('Note a1')
})

test('/notes sends the open notes as one prompt and marks them sent, even without watch', async ($, on) => {
  const f = fake(on, [note('a1'), note('b2'), note('c3', { status: 'done', reply: 'ok' })])
  await boot($, f.clock)

  expect(await run($, f.clock)).toBe('Sent 2 notes to Claude.')
  expect(f.toasts).toEqual([])
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0]).toContain('### Note a1: src/app.go lines 10-12\nfix a1')
  expect(f.prompts[0]).toContain('### Note b2')
  expect(f.prompts[0]).not.toContain('Note c3')
  expect(f.prompts[0]).toContain(TOOL)
  expect(f.stored().map(one => one.status)).toEqual(['sent', 'sent', 'done'])
  expect(f.stored()[0]?.claimedBy).toBeDefined()
  expect(await run($, f.clock)).toBe('No open notes to send.')
})

test('resolve_note records the reply, and refuses an unknown id', async ($, on) => {
  const f = fake(on, [note('a1', { status: 'sent' })])
  await boot($, f.clock)

  const done = await $.tool.call({ tool: TOOL, id: 'a1', reply: 'added a 5s timeout' } as never)
  expect(done.deny).toBeUndefined()
  expect(f.stored()[0]).toMatchObject({ status: 'done', reply: 'added a 5s timeout' })

  const missing = await $.tool.call({ tool: TOOL, id: 'zz', reply: 'x' } as never)
  expect(missing.deny).toContain('no note with id zz')
})

test('a watching band counts notes picked up by the poll, and Send sends them', async ($, on) => {
  const f = fake(on, undefined)
  await watching($, f.clock)
  expect(await bandText($)).toBe('✎ nvim notes: watching ')

  f.put([note('a1'), note('b2', { status: 'sent' })])
  await f.clock.advance(1_500)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 open · 1 with Claude/ })).toBeDefined()
  await ui.press({ key: 'send' })
  await settle(f.clock)
  expect(f.prompts).toHaveLength(1)
  expect(f.toasts).toContain('Sent 1 note to Claude.')
  await ui.unmount()
})

test('a half-written file shows an error until it parses', async ($, on) => {
  const f = fake(on, [note('a1')])
  await watching($, f.clock)
  f.raw('{"root": "/repo", "notes": [')
  await f.clock.advance(1_500)
  expect(await bandText($)).toContain('claude-notes.json: ')

  f.put([note('a1')])
  await f.clock.advance(1_500)
  expect(await bandText($)).toBe('✎ nvim notes: 1 open ')
})

test('auto delivery sends once notes stop arriving', { options: { delivery: 'auto' } }, async ($, on) => {
  const f = fake(on, [])
  await watching($, f.clock)

  f.put([note('a1')])
  await f.clock.advance(1_500)
  f.put([note('a1'), note('b2')])
  await f.clock.advance(1_500)
  expect(f.prompts).toHaveLength(0)

  await f.clock.advance(4_000)
  await settle(f.clock)
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0]).toContain('2 review notes')
})

test('/notes reopen and clear', async ($, on) => {
  const f = fake(on, [note('a1', { status: 'sent', claimedBy: 'x' }), note('b2', { status: 'done' })])
  await boot($, f.clock)

  expect(await run($, f.clock, 'reopen')).toBe('1 open notes.')
  expect(f.stored()[0]?.claimedBy).toBeUndefined()
  expect(await run($, f.clock, 'clear')).toBe('Cleared 1 resolved notes.')
  expect(f.stored().map(one => one.id)).toEqual(['a1'])
  expect(await run($, f.clock, 'path')).toBe(PATH)
  expect(await run($, f.clock, 'list')).toContain('[open] a1')
})

const ASK = 'mcp__nvim-notes__ask_about_note'

const turn = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, text: string, answer: string, reason: 'answer' | 'aborted' = 'answer') => {
  await $.turn.start({ text, turnId: 't1' })
  await $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason } as never)
  await clock.advance(0)
}

test('ask_about_note puts the question on the note for Neovim', async ($, on) => {
  const f = fake(on, [note('a1', { status: 'sent' })])
  await boot($, f.clock)

  const asked = await $.tool.call({ tool: ASK, id: 'a1', question: 'Which timeout?' } as never)
  expect(asked.deny).toBeUndefined()
  expect(f.stored()[0]).toMatchObject({ status: 'question', thread: [{ from: 'claude', text: 'Which timeout?' }] })
  expect((await $.tool.call({ tool: ASK, id: 'zz', question: 'x' } as never)).deny).toContain('no note with id zz')
})

test('the question dialog is refused during a notes turn and allowed otherwise', async ($, on) => {
  const f = fake(on, [note('a1')])
  await boot($, f.clock)
  const allowed = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(allowed.deny).toBeUndefined()

  expect(await run($, f.clock)).toBe('Sent 1 note to Claude.')
  await $.turn.start({ text: f.prompts[0] ?? '', turnId: 't1' })
  const refused = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(refused.deny).toContain(ASK)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBeUndefined()
})

test('a notes turn that ends with notes untouched sends its last message to Neovim as the question', async ($, on) => {
  const f = fake(on, [note('a1'), note('b2'), note('c3')])
  await boot($, f.clock)
  expect(await run($, f.clock)).toBe('Sent 3 notes to Claude.')
  await $.tool.call({ tool: TOOL, id: 'a1', reply: 'done' } as never)
  await $.tool.call({ tool: ASK, id: 'b2', question: 'Which one?' } as never)

  await turn($, f.clock, f.prompts[0] ?? '', 'For c3: should this be async?')

  const [a1, b2, c3] = f.stored()
  expect(a1?.status).toBe('done')
  expect(b2).toMatchObject({ status: 'question', thread: [{ from: 'claude', text: 'Which one?' }] })
  expect(c3).toMatchObject({ status: 'question', thread: [{ from: 'claude', text: 'For c3: should this be async?' }] })
  expect(f.toasts).toContain('nvim-notes: 1 note waiting on your answer in Neovim')
})

test('an interrupted notes turn puts its untouched notes back to open', async ($, on) => {
  const f = fake(on, [note('a1')])
  await boot($, f.clock)
  await run($, f.clock)

  await turn($, f.clock, f.prompts[0] ?? '', '', 'aborted')

  expect(f.stored()[0]?.status).toBe('open')
  expect(f.stored()[0]?.claimedBy).toBeUndefined()
})

test('a turn that is not ours leaves the notes alone', async ($, on) => {
  const f = fake(on, [note('a1', { status: 'sent', claimedBy: 'other-session' })])
  await boot($, f.clock)

  await turn($, f.clock, '### Note a1: src/app.go line 3', 'something')

  expect(f.stored()[0]?.status).toBe('sent')
})

test('an answered question comes back to Claude with the exchange so far', async ($, on) => {
  const f = fake(on, [note('a1', { status: 'queued', thread: [{ from: 'claude', text: 'Which timeout?' }, { from: 'you', text: '5s' }] })])
  await watching($, f.clock)
  await f.clock.advance(1_500)
  await settle(f.clock)

  expect(f.prompts[0]).toContain('You asked:\n> Which timeout?\nThey answered:\n> 5s')
})

test('an answer sent while the earlier notes turn still runs is left to the next turn', async ($, on) => {
  const f = fake(on, [note('a1'), note('b2')])
  await watching($, f.clock)
  expect(await run($, f.clock)).toBe('Sent 2 notes to Claude.')
  await $.turn.start({ text: f.prompts[0] ?? '', turnId: 't1' })
  await $.tool.call({ tool: TOOL, id: 'a1', reply: 'done' } as never)
  await $.tool.call({ tool: ASK, id: 'b2', question: 'Which one?' } as never)

  const answered = f.stored().map(one => (one.id === 'b2' ? { ...one, status: 'queued' as const, thread: [...(one.thread ?? []), { from: 'you' as const, text: 'the first' }] } : one))
  f.put(answered)
  await f.clock.advance(1_500)
  await settle(f.clock)
  expect(f.prompts).toHaveLength(2)

  await $.turn.complete({ answer: 'Summary of turn one', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await f.clock.advance(0)
  const b2 = f.stored().find(one => one.id === 'b2')
  expect(b2?.status).toBe('sent')
  expect(b2?.thread?.at(-1)).toEqual({ from: 'you', text: 'the first' })

  await $.turn.start({ text: f.prompts[1] ?? '', turnId: 't2' })
  expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toContain(ASK)
})

test('parallel resolve_note calls all land', async ($, on) => {
  const f = fake(on, [note('a1', { status: 'sent' }), note('b2', { status: 'sent' }), note('c3', { status: 'sent' })])
  await boot($, f.clock)

  await Promise.all(['a1', 'b2', 'c3'].map(id => $.tool.call({ tool: TOOL, id, reply: `did ${id}` } as never)))

  expect(f.stored().map(one => one.status)).toEqual(['done', 'done', 'done'])
})

test('outside a git repository /notes watch says why', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', async () => ({ value: undefined as never }))
  on('session.id', async () => ({ value: 'this-session' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async () => ({
    value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await boot($, clock)

  expect(await run($, clock, 'watch')).toContain('not in a git repository')
  expect(await bandText($)).toBeUndefined()
})
