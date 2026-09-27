import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { TOOL_DURATION_BUCKETS } from '@mcp-llm/runtime';

// Seconds. LLM calls and chat turns are slow; HTTP and tool calls span both ends.
const HTTP_DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const LLM_DURATION_BUCKETS = [0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120];
const TOOL_STEP_BUCKETS = [0, 1, 2, 3, 4, 6, 8, 12];

export interface Metrics {
  readonly registry: Registry;
  readonly http: {
    requests: Counter<'method' | 'route' | 'status'>;
    duration: Histogram<'method' | 'route'>;
  };
  readonly chat: {
    turns: Counter<'outcome'>;
    duration: Histogram<'outcome'>;
    toolSteps: Histogram<never>;
  };
  readonly llm: {
    requests: Counter<'provider' | 'model' | 'outcome'>;
    duration: Histogram<'provider' | 'model'>;
    tokens: Counter<'provider' | 'model' | 'type'>;
  };
  readonly tools: {
    calls: Counter<'tool' | 'outcome'>;
    duration: Histogram<'tool'>;
  };
  readonly rateLimit: {
    rejections: Counter<'limiter'>;
  };
  readonly tokenBudget: {
    rejections: Counter<'budget'>;
  };
}

/**
 * Creates the app's metrics on a private registry, so each app instance (and each test)
 * has its own series. Labels never carry session ids, user ids, or message content.
 */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];

  return {
    registry,
    http: {
      requests: new Counter({
        name: 'http_requests_total',
        help: 'HTTP requests by method, route template, and status code',
        labelNames: ['method', 'route', 'status'],
        registers,
      }),
      duration: new Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration by method and route template',
        labelNames: ['method', 'route'],
        buckets: HTTP_DURATION_BUCKETS,
        registers,
      }),
    },
    chat: {
      turns: new Counter({
        name: 'chat_turns_total',
        help: 'Chat turns by outcome',
        labelNames: ['outcome'],
        registers,
      }),
      duration: new Histogram({
        name: 'chat_turn_duration_seconds',
        help: 'Chat turn duration, including every LLM and tool call',
        labelNames: ['outcome'],
        buckets: LLM_DURATION_BUCKETS,
        registers,
      }),
      toolSteps: new Histogram({
        name: 'chat_turn_tool_steps',
        help: 'Tool calls made in one successful chat turn',
        buckets: TOOL_STEP_BUCKETS,
        registers,
      }),
    },
    llm: {
      requests: new Counter({
        name: 'llm_requests_total',
        help: 'LLM requests by provider, model, and outcome',
        labelNames: ['provider', 'model', 'outcome'],
        registers,
      }),
      duration: new Histogram({
        name: 'llm_request_duration_seconds',
        help: 'LLM request duration by provider and model',
        labelNames: ['provider', 'model'],
        buckets: LLM_DURATION_BUCKETS,
        registers,
      }),
      tokens: new Counter({
        name: 'llm_tokens_total',
        help: 'Tokens reported by the provider, by type (prompt or completion)',
        labelNames: ['provider', 'model', 'type'],
        registers,
      }),
    },
    tools: {
      calls: new Counter({
        name: 'tool_calls_total',
        help: 'Tool calls by tool name and outcome',
        labelNames: ['tool', 'outcome'],
        registers,
      }),
      duration: new Histogram({
        name: 'tool_call_duration_seconds',
        help: 'Tool call duration by tool name',
        labelNames: ['tool'],
        buckets: [...TOOL_DURATION_BUCKETS],
        registers,
      }),
    },
    rateLimit: {
      rejections: new Counter({
        name: 'rate_limit_rejections_total',
        help: 'Requests rejected with 429 by rate limiter',
        labelNames: ['limiter'],
        registers,
      }),
    },
    tokenBudget: {
      rejections: new Counter({
        name: 'token_budget_rejections_total',
        help: 'Chat turns refused because a daily token budget (user, ip or global) is spent',
        labelNames: ['budget'],
        registers,
      }),
    },
  };
}
