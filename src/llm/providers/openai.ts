import OpenAI from 'openai';
import { LLMMalformedToolCallError, LLMRateLimitError, LLMUnavailableError, retryAfterSeconds } from '../errors';
import { toToolCall } from '../toolArguments';
import { type ChatReply, type LLMProvider, type Message, type ToolSpec } from '../types';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export interface OpenAIProviderOptions {
  /** Per-attempt HTTP timeout. The SDK's own default is 10 minutes, which leaves chats hanging. */
  timeoutMs?: number;
  /** Retries after a timeout, connection error, 429 or 5xx. The SDK default is 2. */
  maxRetries?: number;
}

/**
 * OpenAI Chat Completions with native function calling. Also works with
 * OpenAI-compatible servers via `baseUrl`. Tool calls are echoed back as received, which keeps
 * the thought signatures Gemini 3 attaches to them and requires on the next request.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string = 'gpt-3.5-turbo', baseUrl?: string, options: OpenAIProviderOptions = {}) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: options.timeoutMs, maxRetries: options.maxRetries });
    this.model = model;
  }

  async chat(messages: readonly Message[], tools: readonly ToolSpec[] = []): Promise<ChatReply> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      // The API rejects an empty `tools` array, so omit it instead.
      ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
    }).catch(rethrowProviderError);

    const choice = response.choices[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => toToolCall(call.id, call.function.name, call.function.arguments));

    // Whitespace-only text would reach the user as a blank answer, so it counts as no text.
    if (!message?.content?.trim() && toolCalls.length === 0) {
      // Gemini reports a blocked native call with a non-standard finish_reason, so compare it as a string.
      const finishReason = String(choice?.finish_reason ?? 'none');
      if (finishReason.includes('MALFORMED_FUNCTION_CALL')) {
        throw new LLMMalformedToolCallError(finishReason);
      }
      throw new Error(`OpenAI-compatible response had no text (finish_reason: ${finishReason})`);
    }

    return {
      content: message?.content ?? '',
      toolCalls,
      // The raw calls, echoed back unchanged on the next tool step (see `assistantToolCalls`).
      ...(toolCalls.length > 0 ? { providerState: message?.tool_calls } : {}),
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async close(): Promise<void> {
    // OpenAI SDK doesn't require explicit cleanup
  }
}

/** Rate limits and outages become typed errors with user-safe messages; the rest pass through. */
function rethrowProviderError(error: unknown): never {
  if (error instanceof OpenAI.RateLimitError) {
    throw new LLMRateLimitError(error.message, retryAfterSeconds(error.headers));
  }
  // The SDK uses InternalServerError for every status >= 500 (overloaded, unavailable, ...).
  if (error instanceof OpenAI.InternalServerError) {
    throw new LLMUnavailableError(error.message, retryAfterSeconds(error.headers));
  }
  // No response at all: a timeout (APIConnectionTimeoutError is a subclass) or a dropped connection.
  if (error instanceof OpenAI.APIConnectionError) {
    throw new LLMUnavailableError(error.message);
  }
  throw error;
}

function toOpenAITool(tool: ToolSpec): ChatTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function toOpenAIMessage(message: Message): ChatMessageParam {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      if (!message.toolCalls?.length) {
        return { role: 'assistant', content: message.content };
      }
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: assistantToolCalls(message),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

/**
 * The calls as the provider sent them when available: they may carry fields the SDK doesn't type,
 * such as Gemini's `extra_content.google.thought_signature`, which must be sent back.
 */
function assistantToolCalls(message: Extract<Message, { role: 'assistant' }>): ChatToolCall[] {
  if (Array.isArray(message.providerState)) {
    return message.providerState as ChatToolCall[];
  }
  return (message.toolCalls ?? []).map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}
