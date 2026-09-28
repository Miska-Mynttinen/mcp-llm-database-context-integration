import Anthropic from '@anthropic-ai/sdk';
import { LLMRateLimitError, LLMUnavailableError, retryAfterSeconds } from '../errors';
import { toToolCall } from '../toolArguments';
import { type ChatReply, type LLMProvider, type Message, type ToolResultMessage, type ToolSpec } from '../types';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
// Non-streaming requests: keep responses under the SDK's HTTP timeout.
const MAX_TOKENS = 16000;
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Models documented to accept `fallbacks: "default"`, which re-runs a classifier refusal
// on the model Anthropic recommends for that refusal category.
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-fable-5-1']);
export const REFUSAL_ANSWER = 'The model declined to answer this request.';

/**
 * Anthropic Messages API with native tool use. Assistant replies are echoed back with
 * their original content blocks (including thinking blocks) while a turn's tool loop runs.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string = DEFAULT_ANTHROPIC_MODEL, baseUrl?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
    this.model = model;
  }

  async chat(messages: readonly Message[], tools: readonly ToolSpec[] = []): Promise<ChatReply> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const useFallback = SERVER_FALLBACK_MODELS.has(this.model);

    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: toAnthropicMessages(messages),
      ...(tools.length > 0 ? { tools: tools.map(toAnthropicTool) } : {}),
      ...(useFallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    }).catch(rethrowProviderError);

    const usage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    // A refusal can cut a tool_use off mid-input, so never run that reply's tools.
    if (response.stop_reason === 'refusal') {
      console.warn(`Anthropic refusal (category: ${response.stop_details?.category ?? 'unknown'})`);
      return { content: REFUSAL_ANSWER, toolCalls: [], usage };
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
    );
    if (response.stop_reason === 'max_tokens' && toolUses.length > 0) {
      throw new Error('Anthropic tool call was truncated at max_tokens');
    }

    const content = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = toolUses.map((block) => toToolCall(block.id, block.name, block.input));

    if (!content && toolCalls.length === 0) {
      throw new Error('No content in Anthropic response');
    }

    return { content, toolCalls, providerState: response.content, usage };
  }

  async close(): Promise<void> {
    // Anthropic SDK doesn't require explicit cleanup
  }
}

function toAnthropicTool(tool: ToolSpec): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.inputSchema, type: 'object' },
  };
}

/**
 * Converts the conversation (minus system messages). Consecutive tool results are sent
 * together in one user message, as the API expects for parallel tool calls.
 */
function toAnthropicMessages(messages: readonly Message[]): MessageParam[] {
  return messages.reduce<MessageParam[]>((converted, message) => {
    switch (message.role) {
      case 'system':
        return converted;
      case 'user':
        return [...converted, { role: 'user', content: message.content }];
      case 'assistant': {
        const content = assistantContent(message);
        return content.length > 0 ? [...converted, { role: 'assistant', content }] : converted;
      }
      case 'tool': {
        const block = toolResultBlock(message);
        const previous = converted[converted.length - 1];
        if (previous?.role === 'user' && Array.isArray(previous.content)
          && previous.content.every((part) => part.type === 'tool_result')) {
          return [...converted.slice(0, -1), { role: 'user', content: [...previous.content, block] }];
        }
        return [...converted, { role: 'user', content: [block] }];
      }
    }
  }, []);
}

function assistantContent(message: Extract<Message, { role: 'assistant' }>): ContentBlockParam[] {
  if (Array.isArray(message.providerState)) {
    return message.providerState as ContentBlockParam[];
  }

  const text: ContentBlockParam[] = message.content ? [{ type: 'text', text: message.content }] : [];
  const toolUses: ContentBlockParam[] = (message.toolCalls ?? []).map((call) => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: call.arguments,
  }));
  return [...text, ...toolUses];
}

function toolResultBlock(message: ToolResultMessage): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: message.content,
    ...(message.isError ? { is_error: true } : {}),
  };
}

/** Rate limits and outages become typed errors with user-safe messages; the rest pass through. */
function rethrowProviderError(error: unknown): never {
  if (error instanceof Anthropic.RateLimitError) {
    throw new LLMRateLimitError(error.message, retryAfterSeconds(error.headers));
  }
  // The SDK uses InternalServerError for every status >= 500 (overloaded, unavailable, ...).
  if (error instanceof Anthropic.InternalServerError) {
    throw new LLMUnavailableError(error.message, retryAfterSeconds(error.headers));
  }
  // No response at all: a timeout (APIConnectionTimeoutError is a subclass) or a dropped connection.
  if (error instanceof Anthropic.APIConnectionError) {
    throw new LLMUnavailableError(error.message);
  }
  throw error;
}
