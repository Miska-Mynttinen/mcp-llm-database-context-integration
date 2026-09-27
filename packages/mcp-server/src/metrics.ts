import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { TOOL_DURATION_BUCKETS } from '@mcp-llm/runtime';

export interface McpServerMetrics {
  readonly registry: Registry;
  readonly activeSessions: Gauge;
  readonly requests: Counter<'status'>;
  readonly toolCalls: Counter<'tool' | 'outcome'>;
  readonly toolDuration: Histogram<'tool'>;
}

/** MCP server metrics on a private registry. Labels never carry session ids or query text. */
export function createMcpServerMetrics(): McpServerMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];

  return {
    registry,
    activeSessions: new Gauge({
      name: 'mcp_active_sessions',
      help: 'Open MCP sessions',
      registers,
    }),
    requests: new Counter({
      name: 'mcp_requests_total',
      help: 'Requests to /mcp by HTTP status code',
      labelNames: ['status'],
      registers,
    }),
    toolCalls: new Counter({
      name: 'mcp_tool_calls_total',
      help: 'MCP tool calls by tool name and outcome',
      labelNames: ['tool', 'outcome'],
      registers,
    }),
    toolDuration: new Histogram({
      name: 'mcp_tool_call_duration_seconds',
      help: 'MCP tool call duration by tool name',
      labelNames: ['tool'],
      buckets: [...TOOL_DURATION_BUCKETS],
      registers,
    }),
  };
}
