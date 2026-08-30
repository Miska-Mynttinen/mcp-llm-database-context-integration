"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIProvider = void 0;
const openai_1 = __importDefault(require("openai"));
class OpenAIProvider {
    constructor(apiKey, model = 'gpt-3.5-turbo') {
        this.client = new openai_1.default({ apiKey });
        this.model = model;
    }
    getCapabilities() {
        return {
            supportsChatCompletion: true,
            supportsStreaming: true,
            supportsImageInput: true,
            supportsToolUse: true,
        };
    }
    async complete(prompt) {
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
    async chat(messages, model) {
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
    async getAvailableModels() {
        // For now, return common OpenAI models
        // In production, could list from API
        return [
            'gpt-4',
            'gpt-4-turbo-preview',
            'gpt-3.5-turbo',
            'gpt-3.5-turbo-16k',
        ];
    }
    async close() {
        // OpenAI SDK doesn't require explicit cleanup
    }
    setModel(model) {
        this.model = model;
    }
}
exports.OpenAIProvider = OpenAIProvider;
