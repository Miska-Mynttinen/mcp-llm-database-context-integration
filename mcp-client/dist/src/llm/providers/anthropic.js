"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicProvider = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
class AnthropicProvider {
    constructor(apiKey, model = 'claude-3-sonnet-20240229') {
        this.client = new sdk_1.default({ apiKey });
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
        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        });
        const content = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
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
    async chat(messages, model) {
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
                role: msg.role,
                content: msg.content,
            })),
        });
        const content = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
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
    async getAvailableModels() {
        return [
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
        ];
    }
    async close() {
        // Anthropic SDK doesn't require explicit cleanup
    }
    setModel(model) {
        this.model = model;
    }
}
exports.AnthropicProvider = AnthropicProvider;
