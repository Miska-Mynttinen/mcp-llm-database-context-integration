import OpenAI from 'openai';
import { LLMProvider, Message, CompletionResponse, ProviderCapabilities } from '../types';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'gpt-3.5-turbo') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsChatCompletion: true,
      supportsStreaming: true,
      supportsImageInput: true,
      supportsToolUse: true,
    };
  }

  async complete(prompt: string): Promise<CompletionResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    return {
      content,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async chat(messages: Message[], model?: string): Promise<CompletionResponse> {
    const modelToUse = model || this.model;

    const response = await this.client.chat.completions.create({
      model: modelToUse,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    return {
      content,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async getAvailableModels(): Promise<string[]> {
    // For now, return common OpenAI models
    // In production, could list from API
    return [
      'gpt-4',
      'gpt-4-turbo-preview',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k',
    ];
  }

  async close(): Promise<void> {
    // OpenAI SDK doesn't require explicit cleanup
  }

  setModel(model: string): void {
    this.model = model;
  }
}
