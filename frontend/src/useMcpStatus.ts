import { useEffect, useState } from 'react'
import { UnauthorizedError, fetchMcpStatus, getErrorMessage, type McpStatus } from './api'

const MCP_STATUS_POLL_MS = 30_000

export type McpConnectionState = 'checking' | 'connected' | 'degraded' | 'disconnected'

export type McpStatusResult = {
  state: McpConnectionState
  status?: McpStatus
  /** Why the status could not be fetched, when it could not. */
  error?: string
}

function stateOf(status: McpStatus): McpConnectionState {
  if (status.ok) return 'connected'
  return status.connected > 0 ? 'degraded' : 'disconnected'
}

/** Polls whether the backend can reach its MCP servers. */
export function useMcpStatus(token: string, onSessionExpired: () => void): McpStatusResult {
  const [result, setResult] = useState<McpStatusResult>({ state: 'checking' })

  useEffect(() => {
    let controller: AbortController | null = null

    const check = () => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      fetchMcpStatus(token, current.signal)
        .then(status => setResult({ state: stateOf(status), status }))
        .catch((error: unknown) => {
          if (current.signal.aborted) return
          if (error instanceof UnauthorizedError) {
            onSessionExpired()
            return
          }
          // The backend being unreachable leaves the MCP server just as unusable.
          setResult({ state: 'disconnected', error: getErrorMessage(error) })
        })
    }

    check()
    const timer = setInterval(check, MCP_STATUS_POLL_MS)
    return () => {
      clearInterval(timer)
      controller?.abort()
    }
  }, [token, onSessionExpired])

  return result
}
