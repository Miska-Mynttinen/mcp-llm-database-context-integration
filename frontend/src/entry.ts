import type { ChatRole } from './api'

export type EntryKind = ChatRole | 'error' | 'limit'

export type Entry = {
  id: number
  kind: EntryKind
  content: string
}

let nextEntryId = 0

export function createEntry(kind: EntryKind, content: string): Entry {
  return { id: nextEntryId++, kind, content }
}
