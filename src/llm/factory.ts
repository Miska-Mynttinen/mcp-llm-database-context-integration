import { LLMProvider } from './types';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { OllamaProvider } from './providers/ollama';

export type LLMProviderType = 'openai' | 'anthropic' | 'ollama';

export interface LLMConfig {
  provider: LLMProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string; // For self-hosted providers like Ollama
}

/**
 * Factory for creating LLM provider instances
 */
export class LLMFactory {
  static createFromEnv(): LLMProvider {
    const providerType = (process.env.LLM_PROVIDER || 'ollama') as LLMProviderType;
    const model = process.env.LLM_MODEL || this.getDefaultModelForProvider(providerType);
    const apiKey = process.env.LLM_API_KEY;
    const baseUrl = process.env.LLM_BASE_URL;

    return this.create({
      provider: providerType,
      model,
      apiKey,
      baseUrl,
    });
  }

  static create(config: LLMConfig): LLMProvider {
    const { provider, model, apiKey, baseUrl } = config;

    switch (provider) {
      case 'openai':
        if (!apiKey) {
          throw new Error('OpenAI provider requires LLM_API_KEY environment variable');
        }
        return new OpenAIProvider(apiKey, model);

      case 'anthropic':
        if (!apiKey) {
          throw new Error('Anthropic provider requires LLM_API_KEY environment variable');
        }
        return new AnthropicProvider(apiKey, model);

      case 'ollama':
        const ollamaUrl = baseUrl || 'http://localhost:11434';
        const ollamaModel = model || 'llama2';
        return new OllamaProvider(ollamaUrl, ollamaModel);

      default:
        throw new Error(`Unknown LLM provider: ${provider}`);
    }
  }

  static getDefaultModelForProvider(provider: LLMProviderType): string {
    switch (provider) {
      case 'openai':
        return 'gpt-3.5-turbo';
      case 'anthropic':
        return 'claude-3-sonnet-20240229';
      case 'ollama':
        return 'llama2';
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  static validateConfig(config: LLMConfig): { valid: boolean; error?: string } {
    const { provider, apiKey } = config;

    // API key required for cloud providers
    if ((provider === 'openai' || provider === 'anthropic') && !apiKey) {
      return {
        valid: false,
        error: `${provider} requires an API key`,
      };
    }

    // Ollama doesn't require an API key but requires a running instance
    if (provider === 'ollama' && !config.baseUrl) {
      // This is okay - will use default localhost
    }

    return { valid: true };
  }
}

/**
 * Global LLM provider instance
 */
let globalProvider: LLMProvider | null = null;

export function initializeLLMProvider(config?: LLMConfig): LLMProvider {
  if (globalProvider) {
    return globalProvider;
  }

  globalProvider = config ? LLMFactory.create(config) : LLMFactory.createFromEnv();
  return globalProvider;
}

export function getLLMProvider(): LLMProvider {
  if (!globalProvider) {
    globalProvider = LLMFactory.createFromEnv();
  }
  return globalProvider;
}

export async function closeLLMProvider(): Promise<void> {
  if (globalProvider) {
    await globalProvider.close();
    globalProvider = null;
  }
}
