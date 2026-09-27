import { memo } from 'react'
import MessageContent from './MessageContent'
import type { Entry, EntryKind } from './entry'

const ROLE_LABELS: Record<EntryKind, string> = {
  user: 'You',
  assistant: 'Assistant',
  error: 'Error',
  limit: 'Limit reached',
}

type MessageProps = {
  entry: Entry
}

// Memoized so typing in the composer does not re-render the whole transcript.
const Message = memo(function Message({ entry }: MessageProps) {
  return (
    <article className={`message message-${entry.kind}`} role={entry.kind === 'limit' ? 'status' : undefined}>
      <span className="message-role">{ROLE_LABELS[entry.kind]}</span>
      {entry.kind === 'assistant'
        ? <MessageContent content={entry.content} />
        : <p className="message-text">{entry.content}</p>}
    </article>
  )
})

export default Message
