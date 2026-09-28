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
  /** OpenAI only: the per-attempt request timeout in seconds. */
  timeoutSeconds?: number;
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
// With the SDK's 2 retries (and at most 1.5 s of backoff), a stalled call gives up after ~287 s:
// just under Node's default 300 s `requestTimeout`, so the client still gets the 503 message.
const DEFAULT_OPENAI_TIMEOUT_SECONDS = 95;
const MS_PER_SECOND = 1000;

export function readLLMConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  const provider = (env.LLM_PROVIDER || 'ollama') as LLMProviderType;
  return {
    provider,
    model: env.LLM_MODEL || DEFAULT_MODELS[provider],
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL || undefined,
    toolCalling: parseToolCallingMode(env.LLM_TOOL_CALLING),
    contextLength: parsePositiveInteger('LLM_CONTEXT_LENGTH', env.LLM_CONTEXT_LENGTH, 'tokens'),
    timeoutSeconds: parsePositiveInteger('LLM_TIMEOUT_SECONDS', env.LLM_TIMEOUT_SECONDS, 'seconds'),
  };
}

export function createLLMProvider(config: LLMConfig = readLLMConfigFromEnv()): LLMProvider {
  const provider = createBaseProvider(config);
  const mode = config.toolCalling ?? DEFAULT_TOOL_CALLING[config.provider];
  return mode === 'text' ? withTextToolProtocol(provider) : provider;
}

function createBaseProvider(config: LLMConfig): LLMProvider {
  const { provider, model, apiKey, baseUrl, contextLength, timeoutSeconds } = config;

  switch (provider) {
    case 'openai':
      return new OpenAIProvider(requireApiKey(provider, apiKey), model, baseUrl, {
        timeoutMs: (timeoutSeconds ?? DEFAULT_OPENAI_TIMEOUT_SECONDS) * MS_PER_SECOND,
      });
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

function parsePositiveInteger(name: string, value: string | undefined, unit: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive whole number of ${unit}, got "${value}"`);
  }
  return number;
}

function requireApiKey(provider: LLMProviderType, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`${provider} provider requires LLM_API_KEY (set it in .env.llm)`);
  }
  return apiKey;
}
