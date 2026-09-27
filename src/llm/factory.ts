import { type LLMProvider } from './types';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic';
import { OllamaProvider } from './providers/ollama';
import { withTextToolProtocol } from './textToolProtocol';

export type LLMProviderType = 'openai' | 'anthropic' | 'ollama';

/** `native`: the provider's own tool-calling API. `text`: tools described in the prompt, JSON replies. */
export type ToolCallingMode = 'native' | 'text';

export interface LLMConfig {
  provider: LLMProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string; // Ollama host, or an OpenAI/Anthropic-compatible endpoint
  toolCalling?: ToolCallingMode;
  /** Ollama only: the context window in tokens (`num_ctx`). */
  contextLength?: number;
}

const DEFAULT_MODELS: Record<LLMProviderType, string> = {
  openai: 'gpt-3.5-turbo',
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  ollama: 'llama2',
};

// Ollama tool support depends on the model, so it defaults to the model-agnostic text protocol.
const DEFAULT_TOOL_CALLING: Record<LLMProviderType, ToolCallingMode> = {
  openai: 'native',
  anthropic: 'native',
  ollama: 'text',
};

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export function readLLMConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  const provider = (env.LLM_PROVIDER || 'ollama') as LLMProviderType;
  return {
    provider,
    model: env.LLM_MODEL || DEFAULT_MODELS[provider],
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL || undefined,
    toolCalling: parseToolCallingMode(env.LLM_TOOL_CALLING),
    contextLength: parseContextLength(env.LLM_CONTEXT_LENGTH),
  };
}

export function createLLMProvider(config: LLMConfig = readLLMConfigFromEnv()): LLMProvider {
  const provider = createBaseProvider(config);
  const mode = config.toolCalling ?? DEFAULT_TOOL_CALLING[config.provider];
  return mode === 'text' ? withTextToolProtocol(provider) : provider;
}

function createBaseProvider(config: LLMConfig): LLMProvider {
  const { provider, model, apiKey, baseUrl, contextLength } = config;

  switch (provider) {
    case 'openai':
      return new OpenAIProvider(requireApiKey(provider, apiKey), model, baseUrl);
    case 'anthropic':
      return new AnthropicProvider(requireApiKey(provider, apiKey), model, baseUrl);
    case 'ollama':
      return new OllamaProvider(baseUrl || DEFAULT_OLLAMA_URL, model || DEFAULT_MODELS.ollama, contextLength);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

function parseToolCallingMode(value: string | undefined): ToolCallingMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== 'native' && value !== 'text') {
    throw new Error(`LLM_TOOL_CALLING must be "native" or "text", got "${value}"`);
  }
  return value;
}

function parseContextLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error(`LLM_CONTEXT_LENGTH must be a positive whole number of tokens, got "${value}"`);
  }
  return tokens;
}

function requireApiKey(provider: LLMProviderType, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`${provider} provider requires LLM_API_KEY (set it in .env.llm)`);
  }
  return apiKey;
}
