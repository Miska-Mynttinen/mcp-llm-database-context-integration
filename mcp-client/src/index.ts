import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider, Message } from '../../src/llm/types';

export default class MCPClient {
  private client: Client;
  private llmProvider: LLMProvider;
  private connection: Promise<void>;
  private conversationHistory: Message[] = [];

  constructor(llmProvider: LLMProvider, mcpServerUrl: string) {
    this.llmProvider = llmProvider;
    this.client = new Client(
      {
        name: "database-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl));
    this.connection = this.client.connect(transport);
  }

  async getDatabaseContext(type: 'schema' | 'tables') {
    await this.connection;
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "database-context",
          arguments: { type },
        },
      },
      CallToolRequestSchema
    );
    const content = (result as any).content?.[0];
    if (!content || content.type !== 'text') {
      throw new Error('Invalid response from MCP server');
    }
    return content.text;
  }

  async executeQuery(query: string) {
    await this.connection;
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "execute-sql-query",
          arguments: { query },
        },
      },
      CallToolRequestSchema
    );
    const content = (result as any).content?.[0];
    if (!content || content.type !== 'text') {
      throw new Error('Invalid response from MCP server');
    }
    return content.text;
  }

  async listTools() {
    await this.connection;
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    await this.connection;
    return this.client.callTool({ name, arguments: args });
  }

  /**
   * Ask the LLM a question with database context
   * Uses conversation history for multi-turn interactions
   */
  async askLLM(question: string, context: string) {
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
    } catch (error) {
      // Remove the user message if the request failed
      this.conversationHistory.pop();
      throw error;
    }
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get current conversation history
   */
  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Set a system prompt for the conversation
   */
  setSystemPrompt(prompt: string): void {
    // Remove existing system message if any
    this.conversationHistory = this.conversationHistory.filter(m => m.role !== 'system');
    // Add new system message at the beginning
    this.conversationHistory.unshift({
      role: 'system',
      content: prompt,
    });
  }
}