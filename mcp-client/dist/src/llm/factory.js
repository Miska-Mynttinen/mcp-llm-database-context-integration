"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMFactory = void 0;
exports.initializeLLMProvider = initializeLLMProvider;
exports.getLLMProvider = getLLMProvider;
exports.closeLLMProvider = closeLLMProvider;
const openai_1 = require("./providers/openai");
const anthropic_1 = require("./providers/anthropic");
const ollama_1 = require("./providers/ollama");
/**
 * Factory for creating LLM provider instances
 */
class LLMFactory {
    static createFromEnv() {
        const providerType = (process.env.LLM_PROVIDER || 'ollama');
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
    static create(config) {
        const { provider, model, apiKey, baseUrl } = config;
        switch (provider) {
            case 'openai':
                if (!apiKey) {
                    throw new Error('OpenAI provider requires LLM_API_KEY environment variable');
                }
                return new openai_1.OpenAIProvider(apiKey, model);
            case 'anthropic':
                if (!apiKey) {
                    throw new Error('Anthropic provider requires LLM_API_KEY environment variable');
                }
                return new anthropic_1.AnthropicProvider(apiKey, model);
            case 'ollama':
                const ollamaUrl = baseUrl || 'http://localhost:11434';
                const ollamaModel = model || 'llama2';
                return new ollama_1.OllamaProvider(ollamaUrl, ollamaModel);
            default:
                throw new Error(`Unknown LLM provider: ${provider}`);
        }
    }
    static getDefaultModelForProvider(provider) {
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
    static validateConfig(config) {
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
exports.LLMFactory = LLMFactory;
/**
 * Global LLM provider instance
 */
let globalProvider = null;
function initializeLLMProvider(config) {
    if (globalProvider) {
        return globalProvider;
    }
    globalProvider = config ? LLMFactory.create(config) : LLMFactory.createFromEnv();
    return globalProvider;
}
function getLLMProvider() {
    if (!globalProvider) {
        globalProvider = LLMFactory.createFromEnv();
    }
    return globalProvider;
}
async function closeLLMProvider() {
    if (globalProvider) {
        await globalProvider.close();
        globalProvider = null;
    }
}
