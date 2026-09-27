import OpenAI from 'openai';
import { LLMRateLimitError, retryAfterSeconds } from '../errors';
import { toToolCall } from '../toolArguments';
import { type ChatReply, type LLMProvider, type Message, type ToolSpec } from '../types';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * OpenAI Chat Completions with native function calling. Also works with
 * OpenAI-compatible servers via `baseUrl`.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string = 'gpt-3.5-turbo', baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
    this.model = model;
  }

  async chat(messages: readonly Message[], tools: readonly ToolSpec[] = []): Promise<ChatReply> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      // The API rejects an empty `tools` array, so omit it instead.
      ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
    }).catch(rethrowRateLimit);

    const message = response.choices[0]?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => toToolCall(call.id, call.function.name, call.function.arguments));

    if (!message?.content && toolCalls.length === 0) {
      throw new Error('No content in OpenAI response');
    }

    return {
      content: message?.content ?? '',
      toolCalls,
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

function rethrowRateLimit(error: unknown): never {
  if (error instanceof OpenAI.RateLimitError) {
    throw new LLMRateLimitError(error.message, retryAfterSeconds(error.headers));
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
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}
