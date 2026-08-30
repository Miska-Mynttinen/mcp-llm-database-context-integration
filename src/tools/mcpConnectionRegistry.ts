import MCPClient from '../../mcp-client/src/index';
import { LLMProvider } from '../llm/types';
import { ToolDefinition } from './types';

interface RegisteredTool {
  client: MCPClient;
  remoteName: string;
  description: string;
}

export interface MCPServerConfig {
  name: string;
  url: string;
}

export class MCPConnectionRegistry {
  private readonly clients: MCPClient[] = [];
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly llmProvider: LLMProvider) {}

  async initialize(configs: MCPServerConfig[]): Promise<{
    definitions: ToolDefinition[];
    execute: (name: string, args: Record<string, any>) => Promise<any>;
  }> {
    for (const config of configs) {
      await this.registerServer(config);
    }

    return {
      definitions: [...this.tools.keys()].map((name) => ({
        name,
        description: this.tools.get(name)!.description,
        inputSchema: this.toolSchemas.get(name) || { type: 'object', properties: {} },
      })),
      execute: (name, args) => this.execute(name, args),
    };
  }

  private readonly toolSchemas = new Map<string, Record<string, any>>();

  private async registerServer(config: MCPServerConfig): Promise<void> {
    const client = new MCPClient(this.llmProvider, config.url);

    try {
      const result = await client.listTools();
      const serverPrefix = this.normalizeName(config.name);

      for (const tool of result.tools) {
        const name = `mcp_${serverPrefix}_${this.normalizeName(tool.name)}`;
        this.tools.set(name, {
          client,
          remoteName: tool.name,
          description: `${config.name}: ${tool.description || tool.name}`,
        });
        this.toolSchemas.set(name, tool.inputSchema as Record<string, any>);
      }

      this.clients.push(client);
      console.log(`Registered ${result.tools.length} MCP tools from ${config.name}`);
    } catch (error) {
      await client.close().catch(() => undefined);
      console.warn(`Unable to connect to MCP server ${config.name} at ${config.url}: ${this.errorMessage(error)}`);
    }
  }

  private async execute(name: string, args: Record<string, any>): Promise<any> {
    const registeredTool = this.tools.get(name);
    if (!registeredTool) {
      throw new Error(`Unknown MCP tool: ${name}`);
    }

    return registeredTool.client.callTool(registeredTool.remoteName, args);
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close().catch(() => undefined)));
    this.clients.length = 0;
    this.tools.clear();
    this.toolSchemas.clear();
  }

  private normalizeName(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || 'server';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function readMCPServerConfig(): MCPServerConfig[] {
  const raw = process.env.MCP_SERVER_URLS || '';

  return raw
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url, index) => ({
      name: `server_${index + 1}`,
      url,
    }));
}
