import { type Tools } from '../tools/types';
import { type Logger, secondsSince } from '@mcp-llm/runtime';
import { type Metrics } from './metrics';

const UNKNOWN_TOOL_LABEL = 'unknown';
const MAX_LOGGED_ARGUMENT_CHARS = 2000;

/**
 * Wraps the tools to log failed calls and record each call's outcome and duration, including calls
 * rejected before reaching a tool (unparsed arguments, unknown names). Arguments are logged only
 * for failed calls, truncated.
 */
export function withToolTelemetry(tools: Tools, logger: Logger, metrics?: Metrics): Tools {
  const known = new Set(tools.definitions.map((definition) => definition.name));
  return {
    definitions: tools.definitions,
    async call(request, context) {
      const start = process.hrtime.bigint();
      const outcome = await tools.call(request, context);
      // Names come from the model; only defined tools get their own series.
      const name = known.has(request.name) ? request.name : UNKNOWN_TOOL_LABEL;
      metrics?.tools.calls.inc({ tool: name, outcome: outcome.ok ? 'success' : 'error' });
      metrics?.tools.duration.observe({ tool: name }, secondsSince(start));
      if (!outcome.ok) {
        logger.warn({ tool: name, error: outcome.error, arguments: argumentsForLog(request.arguments) }, 'Tool call failed');
      }
      return outcome;
    },
  };
}

function argumentsForLog(args: Record<string, unknown>): string {
  const text = JSON.stringify(args) ?? '';
  return text.length > MAX_LOGGED_ARGUMENT_CHARS ? `${text.slice(0, MAX_LOGGED_ARGUMENT_CHARS)}… (truncated)` : text;
}
