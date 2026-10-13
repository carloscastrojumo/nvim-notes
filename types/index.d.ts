export type NoteStatus = 'open' | 'queued' | 'sent' | 'question' | 'done'

export type ThreadEntry = { from: 'claude' | 'you'; text: string }

export type Note = {
  id: string
  file: string
  start: number
  end: number
  snippet: string
  text: string
  status: NoteStatus
  createdAt: string
  reply?: string
  resolvedAt?: string
  claimedBy?: string
  thread?: ThreadEntry[]
}

export type NotesFile = { version: 1; root: string; notes: Note[] }

export type Board = { path: string | null; notes: Note[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'nvim-notes': { board: Board; isWatching: boolean }
  }
}
