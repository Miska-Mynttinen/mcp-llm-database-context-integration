import { LLMRateLimitError, LLMUnavailableError, retryAfterSeconds } from '../errors';
import { toToolCall } from '../toolArguments';
import { type ChatReply, type LLMProvider, type Message, type ToolSpec } from '../types';

const RATE_LIMITED_STATUS = 429;
const FIRST_SERVER_ERROR_STATUS = 500;
/**
 * Context window requested per call. Ollama otherwise loads models with its own default (often
 * 4096 tokens) and silently cuts longer prompts: the system prompt, schema and tool results.
 */
export const DEFAULT_OLLAMA_CONTEXT_LENGTH = 8192;

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: unknown };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama /api/chat with native tool calling. Tool support depends on the model;
 * the factory wraps this adapter in the text protocol by default.
 */
export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly contextLength: number;

  constructor(
    baseUrl: string = 'http://localhost:11434',
    model: string = 'llama2',
    contextLength: number = DEFAULT_OLLAMA_CONTEXT_LENGTH,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.model = model;
    this.contextLength = contextLength;
  }

  async chat(messages: readonly Message[], tools: readonly ToolSpec[] = []): Promise<ChatReply> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(toOllamaMessage),
        stream: false,
        options: { num_ctx: this.contextLength },
        ...(tools.length > 0 ? { tools: tools.map(toOllamaTool) } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      if (response.status === RATE_LIMITED_STATUS) {
        throw new LLMRateLimitError(error, retryAfterSeconds(response.headers));
      }
      if (response.status >= FIRST_SERVER_ERROR_STATUS) {
        throw new LLMUnavailableError(`Ollama error: ${response.status} - ${error}`, retryAfterSeconds(response.headers));
      }
      throw new Error(`Ollama error: ${response.status} - ${error}`);
    }

    const data = await response.json() as OllamaChatResponse;
    const content = data.message?.content ?? '';
    // Ollama does not always issue call ids; results are matched by tool name instead.
    const toolCalls = (data.message?.tool_calls ?? []).map((call, index) =>
      toToolCall(call.id ?? `ollama-call-${index}`, call.function.name, call.function.arguments));

    if (!content && toolCalls.length === 0) {
      throw new Error('No response from Ollama');
    }

    return {
      content,
      toolCalls,
      usage: data.eval_count ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count,
        totalTokens: (data.prompt_eval_count || 0) + data.eval_count,
      } : undefined,
    };
  }

  async close(): Promise<void> {
    // No cleanup needed for HTTP-based provider
  }
}

function toOllamaTool(tool: ToolSpec) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function toOllamaMessage(message: Message): OllamaMessage {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_name: message.toolName, content: message.content };
  }
}
