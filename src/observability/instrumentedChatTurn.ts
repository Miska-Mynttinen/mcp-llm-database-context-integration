import { type ChatTurn } from '../chat/chatTurn';
import { type Logger, type Outcome, secondsSince } from '@mcp-llm/runtime';
import { type Metrics } from './metrics';

/** Wraps a chat turn to log one line per successful turn (no content) and record outcome, duration, and tool usage. */
export function withChatTurnTelemetry(chat: ChatTurn, logger: Logger, metrics?: Metrics): ChatTurn {
  return {
    async handle(request) {
      const start = process.hrtime.bigint();
      const record = (outcome: Outcome): number => {
        const seconds = secondsSince(start);
        metrics?.chat.turns.inc({ outcome });
        metrics?.chat.duration.observe({ outcome }, seconds);
        return seconds;
      };

      try {
        const result = await chat.handle(request);
        const durationSeconds = record('success');
        metrics?.chat.toolSteps.observe(result.toolSteps.length);
        logger.info({
          durationSeconds,
          toolSteps: result.toolSteps.length,
          tools: result.toolSteps.map((step) => step.call.name),
          failedTools: result.toolSteps.filter((step) => !step.result.ok).length,
        }, 'Chat turn completed');
        return result;
      } catch (error) {
        // The HTTP layer logs the failure; only count it here.
        record('error');
        throw error;
      }
    },
    getHistory: (userId, sessionId, limit) => chat.getHistory(userId, sessionId, limit),
    clearSession: (userId, sessionId) => chat.clearSession(userId, sessionId),
  };
}
