import { expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { askAbout, buildPrompt, displayPath, listText, noteIdsIn, parseNotes, resolveNote, serializeNotes, tally, withStatus } from './model'

const note = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  file: 'src/app.go',
  start: 10,
  end: 12,
  snippet: 'func main() {\n}',
  text: 'add a timeout here',
  status: 'open',
  createdAt: '2026-10-13T10:00:00Z',
  ...over,
})

test('parses what it serializes', async () => {
  const file = { version: 1 as const, root: '/repo', notes: [note('a1'), note('b2', { status: 'done', reply: 'did it' })] }

  expect(parseNotes(serializeNotes(file))).toEqual(file)
})

test('rejects a note with an unknown status', async () => {
  const text = JSON.stringify({ root: '/repo', notes: [{ ...note('a1'), status: 'later' }] })

  expect(() => parseNotes(text)).toThrow('unknown status')
})

test('rejects a half-written file', async () => {
  expect(() => parseNotes('{"root": "/repo", "notes": [')).toThrow()
})

test('the prompt names each note, its place, its snippet and the tool', async () => {
  const prompt = buildPrompt([note('a1'), note('b2', { start: 3, end: 3, snippet: '' })], '/repo', '/repo', { resolve: 'mcp__x__resolve', ask: 'mcp__x__ask' })

  expect(prompt).toContain('2 review notes')
  expect(prompt).toContain('### Note a1: src/app.go lines 10-12\nadd a timeout here\n```\nfunc main() {\n}\n```')
  expect(prompt).toContain('### Note b2: src/app.go line 3\nadd a timeout here')
  expect(prompt).toContain('call mcp__x__resolve')
  expect(prompt).toContain('call mcp__x__ask with its id and your question instead of asking in the chat')
})

test('a snippet holding a fence gets a longer one', async () => {
  const prompt = buildPrompt([note('a1', { snippet: 'x = ```y```' })], '/repo', '/repo', { resolve: 't', ask: 'a' })

  expect(prompt).toContain('````\nx = ```y```\n````')
})

test('paths are shown from the session directory', async () => {
  expect(displayPath('/repo', '/repo', 'a/b.go')).toBe('a/b.go')
  expect(displayPath('/repo', '/repo/a', 'a/b.go')).toBe('../a/b.go')
  expect(displayPath('/repo', '/elsewhere', 'a/b.go')).toBe('/repo/a/b.go')
})

test('resolving marks one note done with its reply', async () => {
  const notes = resolveNote([note('a1'), note('b2')], 'b2', 'added it', '2026-10-13T11:00:00Z')

  expect(notes.map(one => one.status)).toEqual(['open', 'done'])
  expect(notes[1]?.reply).toBe('added it')
  expect(() => resolveNote(notes, 'zz', 'x', '')).toThrow('no note with id zz')
})

test('status changes and counts', async () => {
  const notes = withStatus([note('a1'), note('b2'), note('c3', { status: 'done' })], new Set(['a1']), 'sent')

  expect(tally(notes)).toEqual({ open: 1, queued: 0, sent: 1, question: 0, done: 1 })
  expect(listText([])).toBe('No notes from Neovim.')
  expect(listText(notes)).toContain('[sent] a1  src/app.go:10  add a timeout here')
})

test('a thread is parsed, kept and shown to Claude', async () => {
  const thread = [
    { from: 'claude' as const, text: 'Which timeout?' },
    { from: 'you' as const, text: '5 seconds\nfor every call' },
  ]
  const file = { version: 1 as const, root: '/repo', notes: [note('a1', { status: 'queued', thread })] }

  expect(parseNotes(serializeNotes(file))).toEqual(file)
  const prompt = buildPrompt(file.notes, '/repo', '/repo', { resolve: 'r', ask: 'a' })
  expect(prompt).toContain('Earlier on this note:\nYou said:\n> Which timeout?\nThey said:\n> 5 seconds\n> for every call')
  expect(noteIdsIn(prompt)).toEqual(['a1'])
})

test('a malformed thread is rejected', async () => {
  const text = JSON.stringify({ root: '/repo', notes: [{ ...note('a1'), thread: [{ from: 'bot', text: 'x' }] }] })

  expect(() => parseNotes(text)).toThrow('malformed thread')
})

test('asking about a note sets it to question and appends to its thread', async () => {
  const notes = askAbout([note('a1', { status: 'sent' }), note('b2')], 'a1', 'Which timeout?')

  expect(notes[0]).toMatchObject({ status: 'question', thread: [{ from: 'claude', text: 'Which timeout?' }] })
  expect(notes[1]?.status).toBe('open')
  expect(() => askAbout(notes, 'zz', 'q')).toThrow('no note with id zz')
  expect(() => askAbout([note('d1', { status: 'done' })], 'd1', 'q')).toThrow('already done')
  expect(listText(notes)).toContain('[question] a1')
  expect(listText(notes)).toContain('? Which timeout?')
})

test('a long question is cut without splitting a character', async () => {
  const question = `${'x'.repeat(3999)}😀😀`
  const [asked] = askAbout([note('a1', { status: 'sent' })], 'a1', question)
  const text = asked?.thread?.[0]?.text ?? ''

  expect(text.startsWith(`${'x'.repeat(3999)}😀\n… (cut`)).toBe(true)
  expect(serializeNotes({ version: 1, root: '/r', notes: asked ? [asked] : [] })).not.toContain('\\ud83d')
})
