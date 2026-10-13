import type { Note, NotesFile, NoteStatus, ThreadEntry } from '../types'

export const NOTES_FILE = 'claude-notes.json'
const STATUSES: readonly NoteStatus[] = ['open', 'queued', 'sent', 'question', 'done']
const MAX_SNIPPET_LINES = 80
const MAX_QUESTION_CHARS = 4000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isThreadEntry = (entry: unknown): entry is ThreadEntry =>
  isRecord(entry) && (entry.from === 'claude' || entry.from === 'you') && typeof entry.text === 'string'

const toThread = (raw: unknown, id: string) => {
  if (raw === undefined) return {}
  if (!Array.isArray(raw) || !raw.every(isThreadEntry)) throw new Error(`note ${id} has a malformed thread`)

  return { thread: raw.map(entry => ({ from: entry.from, text: entry.text })) }
}

const toNote = (raw: unknown, index: number): Note => {
  if (!isRecord(raw)) throw new Error(`note ${index} is not an object`)
  const { id, file, start, end, snippet, text, status, createdAt, reply, resolvedAt, claimedBy, thread } = raw
  if (typeof id !== 'string' || id === '') throw new Error(`note ${index} has no id`)
  if (typeof file !== 'string' || file === '') throw new Error(`note ${id} has no file`)
  if (typeof start !== 'number' || typeof end !== 'number') throw new Error(`note ${id} has no line range`)
  if (typeof text !== 'string') throw new Error(`note ${id} has no text`)
  if (typeof status !== 'string' || !STATUSES.includes(status as NoteStatus)) {
    throw new Error(`note ${id} has an unknown status ${String(status)}`)
  }

  return {
    id,
    file,
    start,
    end,
    snippet: typeof snippet === 'string' ? snippet : '',
    text,
    status: status as NoteStatus,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    ...(typeof reply === 'string' ? { reply } : {}),
    ...(typeof resolvedAt === 'string' ? { resolvedAt } : {}),
    ...(typeof claimedBy === 'string' ? { claimedBy } : {}),
    ...toThread(thread, id),
  }
}

export const parseNotes = (text: string): NotesFile => {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || !Array.isArray(raw.notes)) throw new Error('expected {"notes": [...]}')
  if (typeof raw.root !== 'string') throw new Error('expected a "root" path')

  return { version: 1, root: raw.root, notes: raw.notes.map(toNote) }
}

export const serializeNotes = (file: NotesFile) => `${JSON.stringify(file, null, 2)}\n`

const fenceFor = (snippet: string) => {
  const longest = Math.max(2, ...[...snippet.matchAll(/`+/g)].map(match => match[0].length))

  return '`'.repeat(longest + 1)
}

const trimSnippet = (snippet: string) => {
  const lines = snippet.split('\n')
  if (lines.length <= MAX_SNIPPET_LINES) return snippet

  return [...lines.slice(0, MAX_SNIPPET_LINES), `… ${lines.length - MAX_SNIPPET_LINES} more lines`].join('\n')
}

export const displayPath = (root: string, cwd: string, file: string) => {
  if (cwd === root) return file
  if (cwd.startsWith(`${root}/`)) {
    const depth = cwd.slice(root.length + 1).split('/').length

    return `${'../'.repeat(depth)}${file}`
  }

  return `${root}/${file}`
}

const lineRange = (note: Note) => (note.start === note.end ? `line ${note.start}` : `lines ${note.start}-${note.end}`)

const quote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n')

const threadText = (thread: readonly ThreadEntry[] | undefined) => {
  if (thread === undefined || thread.length === 0) return ''
  const entries = thread.map(entry => `${entry.from === 'claude' ? 'You asked' : 'They answered'}:\n${quote(entry.text)}`)

  return `\n\nEarlier on this note:\n${entries.join('\n')}`
}

export type PromptTools = { resolve: string; ask: string }

export const buildPrompt = (notes: readonly Note[], root: string, cwd: string, tools: PromptTools) => {
  const header = [
    `I left ${notes.length === 1 ? 'a review note' : `${notes.length} review notes`} on the code in Neovim.`,
    'Work through each one: make the change it asks for, or answer it if it is a question.',
    'Line numbers are from when the note was written; if the code has moved, find it by the snippet.',
    `When a note is handled, call ${tools.resolve} with its id and a one-line reply saying what you did.`,
    `If a note is unclear and you need my input, call ${tools.ask} with its id and your question instead of asking in the chat, then carry on with the other notes; I answer from Neovim.`,
  ].join(' ')
  const bodies = notes.map(note => {
    const fence = fenceFor(note.snippet)
    const snippet = note.snippet === '' ? '' : `\n${fence}\n${trimSnippet(note.snippet)}\n${fence}`

    return `### Note ${note.id}: ${displayPath(root, cwd, note.file)} ${lineRange(note)}\n${note.text}${snippet}${threadText(note.thread)}`
  })

  return [header, ...bodies].join('\n\n')
}

export const noteIdsIn = (prompt: string) => [...prompt.matchAll(/^### Note ([0-9a-f]+):/gm)].map(match => match[1] ?? '')

// Cut on code points: half a surrogate pair is JSON Neovim refuses to read.
const capQuestion = (text: string) => {
  const chars = [...text]
  if (chars.length <= MAX_QUESTION_CHARS) return text

  return `${chars.slice(0, MAX_QUESTION_CHARS).join('')}\n… (cut; the rest is in the Claude session)`
}

export const askAbout = (notes: readonly Note[], id: string, question: string) => {
  const note = notes.find(one => one.id === id)
  if (note === undefined) throw new Error(`no note with id ${id}`)
  if (note.status === 'done') throw new Error(`note ${id} is already done`)

  return notes.map(one =>
    one.id === id
      ? { ...one, status: 'question' as const, thread: [...(one.thread ?? []), { from: 'claude' as const, text: capQuestion(question) }] }
      : one,
  )
}

export const withStatus = (notes: readonly Note[], ids: ReadonlySet<string>, status: NoteStatus) =>
  notes.map(note => (ids.has(note.id) ? { ...note, status } : note))

export const resolveNote = (notes: readonly Note[], id: string, reply: string, at: string) => {
  if (!notes.some(note => note.id === id)) throw new Error(`no note with id ${id}`)

  return notes.map(note => (note.id === id ? { ...note, status: 'done' as const, reply, resolvedAt: at } : note))
}

export const tally = (notes: readonly Note[]) => ({
  open: notes.filter(note => note.status === 'open').length,
  queued: notes.filter(note => note.status === 'queued').length,
  sent: notes.filter(note => note.status === 'sent').length,
  question: notes.filter(note => note.status === 'question').length,
  done: notes.filter(note => note.status === 'done').length,
})

export const listText = (notes: readonly Note[]) => {
  if (notes.length === 0) return 'No notes from Neovim.'

  return notes
    .map(note => {
      const asked = note.status === 'question' ? note.thread?.at(-1)?.text.split('\n')[0] : undefined
      const reply = asked !== undefined ? `\n    ? ${asked}` : note.reply === undefined ? '' : `\n    ↳ ${note.reply}`

      return `[${note.status}] ${note.id}  ${note.file}:${note.start}  ${note.text.split('\n')[0]}${reply}`
    })
    .join('\n')
}
