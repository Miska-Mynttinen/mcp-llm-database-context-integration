import { type Logger } from '@mcp-llm/runtime';
import { type ChatTurn } from '../chat/chatTurn';
import { type LLMProvider } from '../llm/types';
import { type Tools } from '../tools/types';
import { type Metrics } from './metrics';
import { type LLMLabels, withLLMTelemetry } from './instrumentedLLM';
import { withToolTelemetry } from './instrumentedTools';
import { withChatTurnTelemetry } from './instrumentedChatTurn';

/** Identifies the client behind a rejected request; never content. */
export interface RejectionFields {
  ip?: string;
  path?: string;
}

/**
 * Logs and metrics for the app. Every decorator always logs; metrics are recorded only when
 * `metrics` is set, so turning metrics off never silences a log line.
 */
export interface Telemetry {
  readonly logger: Logger;
  /** Set when metrics are on; `GET /metrics` serves its registry. */
  readonly metrics?: Metrics;
  llm(provider: LLMProvider, labels: LLMLabels): LLMProvider;
  tools(tools: Tools): Tools;
  chat(turn: ChatTurn): ChatTurn;
  /** Records and logs a request rejected with 429 by a request rate limit. */
  rateLimited(limiter: string, fields: RejectionFields): void;
  /** Records and logs a chat turn refused because a daily token budget (`user`, `ip` or `global`) is spent. */
  budgetRefused(budget: string, fields: RejectionFields): void;
}

export function createTelemetry(logger: Logger, metrics?: Metrics): Telemetry {
  return {
    logger,
    metrics,
    llm: (provider, labels) => withLLMTelemetry(provider, labels, logger, metrics),
    tools: (tools) => withToolTelemetry(tools, logger, metrics),
    chat: (turn) => withChatTurnTelemetry(turn, logger, metrics),
    rateLimited(limiter, fields) {
      metrics?.rateLimit.rejections.inc({ limiter });
      logger.warn({ limiter, ...fields }, 'Rate limit exceeded');
    },
    budgetRefused(budget, fields) {
      metrics?.tokenBudget.rejections.inc({ budget });
      logger.warn({ budget, ...fields }, 'Token budget exceeded');
    },
  };
}
