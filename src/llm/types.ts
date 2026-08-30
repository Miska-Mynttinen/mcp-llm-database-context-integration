/**
 * LLM Provider abstraction - defines interface for all LLM providers
 */

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ProviderCapabilities {
  supportsChatCompletion: boolean;
  supportsStreaming: boolean;
  supportsImageInput: boolean;
  supportsToolUse: boolean;
}

export interface LLMProvider {
  /**
   * Get capabilities of this provider
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Send a single completion request
   * @param prompt The prompt/question
   * @returns Completion response
   */
  complete(prompt: string): Promise<CompletionResponse>;

  /**
   * Send a chat completion request with conversation history
   * @param messages Array of messages in conversation
   * @param model Optional model override
   * @returns Completion response
   */
  chat(messages: Message[], model?: string): Promise<CompletionResponse>;

  /**
   * Get available models for this provider
   * @returns Array of model identifiers
   */
  getAvailableModels(): Promise<string[]>;

  /**
   * Close/cleanup resources
   */
  close(): Promise<void>;
}
