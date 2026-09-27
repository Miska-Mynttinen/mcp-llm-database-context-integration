import type { McpStatusResult } from './useMcpStatus'

function formatCheckedAt(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function toolCount(tools: number): string {
  return `${tools} ${tools === 1 ? 'tool' : 'tools'}`
}

function describe({ state, status }: McpStatusResult): string {
  if (state === 'checking') return 'Checking MCP server…'
  if (!status) return 'MCP server unreachable: the app server could not be reached'
  if (status.configured === 0) return 'No MCP server configured: answers cannot use the database'
  if (state === 'connected') return `MCP server connected · ${toolCount(status.tools)}`
  if (state === 'degraded') return `MCP servers: ${status.connected} of ${status.configured} connected · ${toolCount(status.tools)}`
  return 'MCP server unreachable: answers cannot use the database'
}

type McpStatusBarProps = {
  result: McpStatusResult
}

function McpStatusBar({ result }: McpStatusBarProps) {
  return (
    <div className={`mcp-status mcp-status-${result.state}`} role="status" title={result.error}>
      <span className="mcp-status-dot" aria-hidden="true" />
      <span className="mcp-status-text">{describe(result)}</span>
      {result.status && (
        <span className="mcp-status-checked">Checked {formatCheckedAt(result.status.checkedAt)}</span>
      )}
    </div>
  )
}

export default McpStatusBar
