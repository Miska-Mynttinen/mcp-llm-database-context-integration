import { useEffect, useRef, useState, type FormEvent } from 'react'
import McpStatusBar from './McpStatusBar'
import Message from './Message'
import { createEntry, type Entry } from './entry'
import { MAX_MESSAGE_LENGTH, RateLimitError, UnauthorizedError, fetchHistory, getErrorMessage, sendMessage } from './api'
import { loginStore, type Login } from './login'
import { useMcpStatus } from './useMcpStatus'

const MS_PER_SECOND = 1000

/** Local wall-clock time, such as "14:05", when a rate limit lifts. */
function formatResetTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The server's message, plus when sending works again if the server said. */
function describeLimit(error: RateLimitError, blockedUntil: number | null): string {
  return blockedUntil === null
    ? error.message
    : `${error.message} You can send messages again at ${formatResetTime(blockedUntil)}.`
}

function composerPlaceholder(isLoading: boolean, blockedUntil: number | null): string {
  if (blockedUntil !== null) return `Limit reached — try again after ${formatResetTime(blockedUntil)}`
  if (isLoading) return 'Waiting for the answer…'
  return 'Ask a question about the database'
}

type ChatViewProps = {
  login: Login
  onLogout: () => void
  /** Called when the server rejects the token, so the user can log in again. */
  onSessionExpired: () => void
}

function ChatView({ login, onLogout, onSessionExpired }: ChatViewProps) {
  const { token, username } = login
  const [sessionId, setSessionId] = useState(() => loginStore.sessionId())
  const [entries, setEntries] = useState<Entry[]>([])
  const [question, setQuestion] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  /** While set, a rate limit or daily AI limit is used up and sending is disabled until this time. */
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingRequestRef = useRef<AbortController | null>(null)
  const isBlocked = blockedUntil !== null
  const isInputLocked = isLoading || isBlocked
  const mcpStatus = useMcpStatus(token, onSessionExpired)

  // Logging out mid-answer unmounts the view; drop the request instead of finishing it into nothing.
  useEffect(() => () => pendingRequestRef.current?.abort(), [])

  // Restore the conversation the server already holds for this tab's session.
  useEffect(() => {
    const controller = new AbortController()
    fetchHistory(token, sessionId, controller.signal)
      .then(history => {
        const restored = history.map(({ role, content }) => createEntry(role, content))
        // A message sent while history was loading takes precedence.
        setEntries(current => (current.length > 0 ? current : restored))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof UnauthorizedError) {
          onSessionExpired()
          return
        }
        const notice = createEntry('error', `Could not load earlier messages: ${getErrorMessage(error)}`)
        setEntries(current => [notice, ...current])
      })
    return () => controller.abort()
  }, [token, sessionId, onSessionExpired])

  // Re-enable sending once the limit resets.
  useEffect(() => {
    if (blockedUntil === null) return
    const timer = setTimeout(() => setBlockedUntil(null), Math.max(0, blockedUntil - Date.now()))
    return () => clearTimeout(timer)
  }, [blockedUntil])

  // Disabling the input while waiting drops its focus; give it back once the user can type again.
  useEffect(() => {
    if (!isInputLocked) inputRef.current?.focus()
  }, [isInputLocked])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, isLoading])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = question.trim()
    if (!message || isLoading || isBlocked) return

    setEntries(current => [...current, createEntry('user', message)])
    setQuestion('')
    setIsLoading(true)
    const controller = new AbortController()
    pendingRequestRef.current = controller
    try {
      const answer = await sendMessage(token, sessionId, message, controller.signal)
      setEntries(current => [...current, createEntry('assistant', answer)])
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof UnauthorizedError) {
        onSessionExpired()
        return
      }
      if (error instanceof RateLimitError) {
        const until = error.retryAfterSeconds === undefined ? null : Date.now() + error.retryAfterSeconds * MS_PER_SECOND
        setBlockedUntil(until)
        setEntries(current => [...current, createEntry('limit', describeLimit(error, until))])
        return
      }
      setEntries(current => [...current, createEntry('error', getErrorMessage(error))])
    } finally {
      pendingRequestRef.current = null
      setIsLoading(false)
    }
  }

  const handleNewConversation = () => {
    setSessionId(loginStore.newConversation())
    setEntries([])
  }

  const isEmpty = entries.length === 0 && !isLoading

  return (
    <main className="app">
      <header className="app-header">
        <h1>LLM Database Integration</h1>
        <div className="app-header-actions">
          {username && <span className="app-user">Signed in as <strong>{username}</strong></span>}
          <button
            type="button"
            className="button-secondary"
            onClick={handleNewConversation}
            disabled={isLoading || entries.length === 0}
          >
            New conversation
          </button>
          <button type="button" className="button-secondary" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      <McpStatusBar result={mcpStatus} />

      <section className="transcript" role="log" aria-label="Conversation">
        {isEmpty && <p className="transcript-empty">Ask a question about your database to get started.</p>}
        {entries.map(entry => <Message entry={entry} key={entry.id} />)}
        {isLoading && <p className="message message-pending">Thinking…</p>}
        <div ref={transcriptEndRef} />
      </section>

      <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
        <input
          ref={inputRef}
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder={composerPlaceholder(isLoading, blockedUntil)}
          aria-label="Question about the database"
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={isInputLocked}
          required
          autoFocus
        />
        <button type="submit" disabled={isInputLocked}>{isLoading ? 'Asking…' : 'Ask'}</button>
      </form>
    </main>
  )
}

export default ChatView
