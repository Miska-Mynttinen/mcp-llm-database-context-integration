export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  role: ChatRole
  content: string
}

const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check your connection and try again.'

// Mirrors MAX_MESSAGE_LENGTH in src/app.ts.
export const MAX_MESSAGE_LENGTH = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.content === 'string'
}

/** The server rejected the credentials or the token (HTTP 401); the user must log in again. */
export class UnauthorizedError extends Error {}

/** The server refused the request because a rate limit or daily AI limit is used up (HTTP 429). */
export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message)
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  const seconds = header?.trim() ? Number(header) : Number.NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Sends `token` as the bearer token when given; login and sign-up have none yet. */
async function requestJson(url: string, init: RequestInit = {}, token?: string): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch (error) {
    // Aborts are the caller's doing; anything else is the browser's opaque "Failed to fetch".
    if (init.signal?.aborted) throw error
    throw new Error(NETWORK_ERROR_MESSAGE)
  }
  const body: unknown = await res.json().catch(() => null)
  if (res.status === 401) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : 'Please log in again'
    throw new UnauthorizedError(message)
  }
  if (res.status === 429) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : 'Too many requests, please try again later'
    throw new RateLimitError(message, parseRetryAfter(res.headers.get('Retry-After')))
  }
  if (!isRecord(body)) {
    throw new Error(`Unexpected response from server (HTTP ${res.status})`)
  }
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`)
  }
  return body
}

export async function sendMessage(token: string, sessionId: string, message: string, signal?: AbortSignal): Promise<string> {
  const body = await requestJson('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
    signal,
  }, token)
  if (typeof body.answer !== 'string') {
    throw new Error('Server response did not include an answer')
  }
  return body.answer
}

export async function fetchHistory(token: string, sessionId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
  const body = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/history`, { signal }, token)
  const history = Array.isArray(body.history) ? body.history : []
  // Keep only the fields the UI renders; system messages are not shown.
  return history.filter(isChatMessage).map(({ role, content }) => ({ role, content }))
}

export type McpStatus = {
  /** Every configured MCP server answered a ping, and there is at least one. */
  ok: boolean
  configured: number
  connected: number
  tools: number
  checkedAt: string
}

export async function fetchMcpStatus(token: string, signal?: AbortSignal): Promise<McpStatus> {
  const { ok, configured, connected, tools, checkedAt } = await requestJson('/api/mcp/status', { signal }, token)
  if (typeof ok !== 'boolean' || typeof configured !== 'number' || typeof connected !== 'number'
    || typeof tools !== 'number' || typeof checkedAt !== 'string') {
    throw new Error('Server response did not include an MCP status')
  }
  return { ok, configured, connected, tools, checkedAt }
}

export type AuthUser = {
  id: string
  username: string
  role: 'user'
}

export type AuthResult = {
  token: string
  user: AuthUser
}

function toAuthResult(body: Record<string, unknown>): AuthResult {
  const { token, user } = body
  if (typeof token !== 'string' || !isRecord(user) || typeof user.id !== 'string' || typeof user.username !== 'string') {
    throw new Error('Server response did not include a login')
  }
  return { token, user: { id: user.id, username: user.username, role: 'user' } }
}

function postCredentials(url: string, username: string, password: string): Promise<Record<string, unknown>> {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

/** Exchanges credentials for a JWT. Throws `UnauthorizedError` for a wrong username or password. */
export async function login(username: string, password: string): Promise<AuthResult> {
  return toAuthResult(await postCredentials('/api/auth/login', username, password))
}

/** Creates a regular account and logs it in. Throws with the server's message for a taken or invalid name. */
export async function register(username: string, password: string): Promise<AuthResult> {
  return toAuthResult(await postCredentials('/api/auth/register', username, password))
}
