/**
 * LLM Provider abstraction. Each adapter translates these provider-neutral shapes
 * to its own wire protocol (native tool calling, or the text protocol for models without it).
 */

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMToolCall {
  /** Provider-issued id linking the call to its result message. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the provider returned arguments that could not be parsed; the call must not run. */
  argumentsError?: string;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: LLMToolCall[];
  /**
   * The provider's own representation of this reply (e.g. Anthropic content blocks with
   * thinking), echoed back unchanged within the same turn. Opaque to callers.
   */
  providerState?: unknown;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ChatReply {
  /** The model's text. May be empty when it only calls tools. */
  content: string;
  toolCalls: LLMToolCall[];
  providerState?: unknown;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMProvider {
  /**
   * Sends the conversation. When `tools` is non-empty the model may reply with tool calls;
   * the caller runs them and continues with `assistant` + `tool` messages.
   */
  chat(messages: readonly Message[], tools?: readonly ToolSpec[]): Promise<ChatReply>;

  /**
   * Close/cleanup resources
   */
  close(): Promise<void>;
}
