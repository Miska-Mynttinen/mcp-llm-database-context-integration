import { LLMProvider, Message, CompletionResponse, ProviderCapabilities } from '../types';

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama2') {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.model = model;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsChatCompletion: true,
      supportsStreaming: true,
      supportsImageInput: false,
      supportsToolUse: false,
    };
  }

  async complete(prompt: string): Promise<CompletionResponse> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;

    if (!data.response) {
      throw new Error('No response from Ollama');
    }

    return {
      content: data.response,
      usage: data.eval_count ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count,
        totalTokens: (data.prompt_eval_count || 0) + data.eval_count,
      } : undefined,
    };
  }

  async chat(messages: Message[], model?: string): Promise<CompletionResponse> {
    const modelToUse = model || this.model;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelToUse,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;

    if (!data.message?.content) {
      throw new Error('No response from Ollama');
    }

    return {
      content: data.message.content,
      usage: data.eval_count ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count,
        totalTokens: (data.prompt_eval_count || 0) + data.eval_count,
      } : undefined,
    };
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as any;
      return data.models?.map((m: any) => m.name) || [];
    } catch {
      // If Ollama is not running, return empty list
      return [];
    }
  }

  async close(): Promise<void> {
    // No cleanup needed for HTTP-based provider
  }

  setModel(model: string): void {
    this.model = model;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
}
