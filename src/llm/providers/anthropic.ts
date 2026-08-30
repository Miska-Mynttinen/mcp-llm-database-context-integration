import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, Message, CompletionResponse, ProviderCapabilities } from '../types';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-3-sonnet-20240229') {
    this.client = new Anthropic({ apiKey });
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
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');

    if (!content) {
      throw new Error('No content in Anthropic response');
    }

    return {
      content,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async chat(messages: Message[], model?: string): Promise<CompletionResponse> {
    const modelToUse = model || this.model;

    // Anthropic requires system prompts to be separate
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const system = systemMessages.map(m => m.content).join('\n');

    const response = await this.client.messages.create({
      model: modelToUse,
      max_tokens: 1024,
      system: system || undefined,
      messages: conversationMessages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
    });

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');

    if (!content) {
      throw new Error('No content in Anthropic response');
    }

    return {
      content,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async getAvailableModels(): Promise<string[]> {
    return [
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  async close(): Promise<void> {
    // Anthropic SDK doesn't require explicit cleanup
  }

  setModel(model: string): void {
    this.model = model;
  }
}
