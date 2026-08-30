"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
class MCPClient {
    constructor(llmProvider, mcpServerUrl) {
        this.conversationHistory = [];
        this.llmProvider = llmProvider;
        this.client = new index_js_1.Client({
            name: "database-mcp-client",
            version: "1.0.0",
        }, {
            capabilities: {},
        });
        const transport = new streamableHttp_js_1.StreamableHTTPClientTransport(new URL(mcpServerUrl));
        this.connection = this.client.connect(transport);
    }
    async getDatabaseContext(type) {
        await this.connection;
        const result = await this.client.request({
            method: "tools/call",
            params: {
                name: "database-context",
                arguments: { type },
            },
        }, types_js_1.CallToolRequestSchema);
        const content = result.content?.[0];
        if (!content || content.type !== 'text') {
            throw new Error('Invalid response from MCP server');
        }
        return content.text;
    }
    async executeQuery(query) {
        await this.connection;
        const result = await this.client.request({
            method: "tools/call",
            params: {
                name: "execute-sql-query",
                arguments: { query },
            },
        }, types_js_1.CallToolRequestSchema);
        const content = result.content?.[0];
        if (!content || content.type !== 'text') {
            throw new Error('Invalid response from MCP server');
        }
        return content.text;
    }
    async listTools() {
        await this.connection;
        return this.client.listTools();
    }
    async callTool(name, args) {
        await this.connection;
        return this.client.callTool({ name, arguments: args });
    }
    /**
     * Ask the LLM a question with database context
     * Uses conversation history for multi-turn interactions
     */
    async askLLM(question, context) {
        // Add user message to history
        this.conversationHistory.push({
            role: 'user',
            content: `Database context: ${context}\n\nQuestion: ${question}\n\nWhen a schema, relationship, or flow is easier to understand visually, include a valid Mermaid diagram in a fenced mermaid code block.`,
        });
        try {
            const response = await this.llmProvider.chat(this.conversationHistory);
            // Add assistant response to history
            this.conversationHistory.push({
                role: 'assistant',
                content: response.content,
            });
            return response.content;
        }
        catch (error) {
            // Remove the user message if the request failed
            this.conversationHistory.pop();
            throw error;
        }
    }
    /**
     * Clear conversation history
     */
    clearHistory() {
        this.conversationHistory = [];
    }
    /**
     * Get current conversation history
     */
    getHistory() {
        return [...this.conversationHistory];
    }
    async close() {
        await this.client.close();
    }
    /**
     * Set a system prompt for the conversation
     */
    setSystemPrompt(prompt) {
        // Remove existing system message if any
        this.conversationHistory = this.conversationHistory.filter(m => m.role !== 'system');
        // Add new system message at the beginning
        this.conversationHistory.unshift({
            role: 'system',
            content: prompt,
        });
    }
}
exports.default = MCPClient;
