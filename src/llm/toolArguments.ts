import { type LLMToolCall } from './types';

/**
 * Builds a tool call from provider output whose arguments may be a JSON string (OpenAI),
 * an object (Anthropic, Ollama), or malformed. Malformed arguments become `argumentsError`.
 */
export function toToolCall(id: string, name: string, rawArguments: unknown): LLMToolCall {
  if (rawArguments === undefined || rawArguments === null || rawArguments === '') {
    return { id, name, arguments: {} };
  }

  let parsed: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return { id, name, arguments: {}, argumentsError: `Tool arguments are not valid JSON: ${rawArguments}` };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { id, name, arguments: {}, argumentsError: 'Tool arguments must be a JSON object' };
  }
  return { id, name, arguments: parsed as Record<string, unknown> };
}
