import { LLMRateLimitError, LLMUnavailableError } from '../llm/errors';
import { type LLMProvider } from '../llm/types';
import { type Logger, secondsSince } from '@mcp-llm/runtime';
import { type Metrics } from './metrics';

export interface LLMLabels {
  provider: string;
  model: string;
}

/** Wraps a provider to log failures and record request counts, latency, and token usage. Errors pass through unchanged. */
export function withLLMTelemetry(llm: LLMProvider, labels: LLMLabels, logger: Logger, metrics?: Metrics): LLMProvider {
  return {
    async chat(messages, tools) {
      const start = process.hrtime.bigint();
      try {
        const reply = await llm.chat(messages, tools);
        metrics?.llm.requests.inc({ ...labels, outcome: 'success' });
        if (reply.usage) {
          metrics?.llm.tokens.inc({ ...labels, type: 'prompt' }, reply.usage.promptTokens);
          metrics?.llm.tokens.inc({ ...labels, type: 'completion' }, reply.usage.completionTokens);
        }
        return reply;
      } catch (error) {
        metrics?.llm.requests.inc({ ...labels, outcome: 'error' });
        logger.warn({ ...labels, error: failureDetail(error) }, 'LLM request failed');
        throw error;
      } finally {
        metrics?.llm.duration.observe(labels, secondsSince(start));
      }
    },
    close: () => llm.close(),
  };
}

/** The provider's own wording for a failure; user-facing rate-limit and outage messages hide it. */
function failureDetail(error: unknown): string {
  if (error instanceof LLMRateLimitError) return `Rate limited: ${error.providerMessage}`;
  if (error instanceof LLMUnavailableError) return `Unavailable: ${error.providerMessage}`;
  return error instanceof Error ? error.message : String(error);
}
