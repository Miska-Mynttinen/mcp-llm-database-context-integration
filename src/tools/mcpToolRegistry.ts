import MCPClient, { type MCPClientOptions } from '@mcp-llm/mcp-client';
import { parseList, requireMcpAuthToken } from '@mcp-llm/runtime';
import { type ToolDefinition, type ToolRegistry } from './types';

export interface MCPServerConfig {
  name: string;
  url: string;
  /** Sent as a bearer token; must match the server's MCP_AUTH_TOKEN. */
  authToken?: string;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface RemoteToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RemoteResource {
  uri: string;
  mimeType?: string;
}

interface RemoteResourceContents {
  contents: Array<{ uri: string; text?: string }>;
}

/** The slice of an MCP client this registry needs. `MCPClient` in production, fakes in tests. */
export interface MCPToolClient {
  listTools(): Promise<{ tools: RemoteTool[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<RemoteToolResult | unknown>;
  /** Throws when the server does not serve resources. */
  listResources(): Promise<{ resources: RemoteResource[] }>;
  readResource(uri: string): Promise<RemoteResourceContents>;
  ping(options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

/** How many configured MCP servers answer a ping right now, and how many tools they registered. */
export interface MCPStatus {
  configured: number;
  connected: number;
  tools: number;
}

export interface MCPToolRegistry extends ToolRegistry {
  /** Pings every server that connected at startup; ones that failed then count as not connected. */
  status(): Promise<MCPStatus>;
  /**
   * The text of every text resource the servers listed at startup, such as the database schema
   * overview, for the model's system prompt. Cached for `CONTEXT_CACHE_TTL_MS`; a resource that fails
   * to read is logged and left out (and not cached), so this never throws.
   */
  readContext(): Promise<string>;
  close(): Promise<void>;
}

interface RegisteredTool {
  client: MCPToolClient;
  remoteName: string;
}

interface ContextResource {
  client: MCPToolClient;
  serverName: string;
  uri: string;
}

const MCP_PING_TIMEOUT_MS = 5000;
/** How long `readContext` reuses what it read: the schema rarely changes between chat turns. */
export const CONTEXT_CACHE_TTL_MS = 60_000;

const defaultClientFactory = (url: string, options: MCPClientOptions): MCPToolClient => new MCPClient(url, options);

/**
 * Connects to each MCP server and exposes its tools as `mcp_<server>_<tool>`.
 * Servers that fail to connect are skipped with a warning.
 */
/** The two log levels connection setup uses; satisfied by `console` and by the app logger. */
export interface ConnectionLogger {
  info(message: string): void;
  warn(message: string): void;
}

export async function connectMCPToolRegistry(
  configs: readonly MCPServerConfig[],
  createClient: (url: string, options: MCPClientOptions) => MCPToolClient = defaultClientFactory,
  logger: ConnectionLogger = console,
): Promise<MCPToolRegistry> {
  const clients: MCPToolClient[] = [];
  const routes = new Map<string, RegisteredTool>();
  const definitions: ToolDefinition[] = [];
  const contextResources: ContextResource[] = [];

  for (const config of configs) {
    const client = createClient(config.url, { authToken: config.authToken });
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const definition = toToolDefinition(config.name, tool);
        routes.set(definition.name, { client, remoteName: tool.name });
        definitions.push(definition);
      }

      clients.push(client);
      logger.info(`Registered ${tools.length} MCP tools from ${config.name}`);
      contextResources.push(...await listTextResources(client, config.name, logger));
    } catch (error) {
      await client.close().catch(() => undefined);
      logger.warn(`Unable to connect to MCP server ${config.name} at ${urlForLogs(config.url)}: ${errorMessage(error)}`);
    }
  }

  return {
    definitions,
    execute: async (name, args) => {
      const route = routes.get(name);
      if (!route) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      return unwrapToolResult(await route.client.callTool(route.remoteName, args));
    },
    status: async () => ({
      configured: configs.length,
      connected: await countAnsweringPing(clients),
      tools: definitions.length,
    }),
    readContext: createContextReader(contextResources, logger),
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    },
  };
}

/**
 * Reads MCP_SERVER_URLS and MCP_AUTH_TOKEN (normally from `.env.mcp`). Every server gets the same token.
 * Throws when servers are configured without a token of at least 32 characters.
 */
export function readMCPServerConfig(env: NodeJS.ProcessEnv = process.env): MCPServerConfig[] {
  const urls = parseList(env.MCP_SERVER_URLS);
  if (urls.length === 0) {
    return [];
  }
  const authToken = requireMcpAuthToken(env, 'when MCP_SERVER_URLS is set');
  return urls.map((url, index) => ({ name: `server_${index + 1}`, url, authToken }));
}

/** A server's tool as the LLM sees it: namespaced `mcp_<server>_<tool>`, described with the server name. */
function toToolDefinition(serverName: string, tool: RemoteTool): ToolDefinition {
  return {
    name: `mcp_${normalizeName(serverName)}_${normalizeName(tool.name)}`,
    description: `${serverName}: ${tool.description || tool.name}`,
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

/** Reads and joins the resources' text, reusing it for `CONTEXT_CACHE_TTL_MS` when every read succeeded. */
function createContextReader(resources: readonly ContextResource[], logger: ConnectionLogger): () => Promise<string> {
  let cached: { text: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.text;
    }
    const texts = await Promise.all(resources.map((resource) => readResourceText(resource, logger)));
    const text = texts.filter(Boolean).join('\n\n');
    // A failed read is retried on the next turn instead of cached.
    cached = texts.includes(undefined) ? undefined : { text, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS };
    return text;
  };
}

/** The server's text resources; a server that serves none (or cannot list them) has no context. */
async function listTextResources(client: MCPToolClient, serverName: string, logger: ConnectionLogger): Promise<ContextResource[]> {
  try {
    const { resources } = await client.listResources();
    return resources
      .filter((resource) => !resource.mimeType || resource.mimeType.startsWith('text/'))
      .map((resource) => ({ client, serverName, uri: resource.uri }));
  } catch (error) {
    logger.info(`MCP server ${serverName} serves no context resources: ${errorMessage(error)}`);
    return [];
  }
}

/** The resource's text, or `undefined` when it could not be read. */
async function readResourceText({ client, serverName, uri }: ContextResource, logger: ConnectionLogger): Promise<string | undefined> {
  try {
    const { contents } = await client.readResource(uri);
    return contents.map((content) => content.text ?? '').filter(Boolean).join('\n');
  } catch (error) {
    logger.warn(`Unable to read context resource ${uri} from MCP server ${serverName}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function countAnsweringPing(clients: readonly MCPToolClient[]): Promise<number> {
  const pings = await Promise.allSettled(clients.map((client) => client.ping({ timeout: MCP_PING_TIMEOUT_MS })));
  return pings.filter((ping) => ping.status === 'fulfilled').length;
}

/** Turns an MCP tool result into plain data, and MCP-level errors into thrown errors. */
function unwrapToolResult(raw: unknown): unknown {
  const result = raw as RemoteToolResult;
  const texts = (result?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);

  if (result?.isError) {
    throw new Error(texts.join('\n') || 'MCP tool reported an error');
  }
  if (texts.length !== 1) {
    return raw;
  }
  try {
    return JSON.parse(texts[0]);
  } catch {
    return texts[0];
  }
}

function normalizeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'server';
}

/** Origin and path only: credentials in the userinfo or query string never reach the logs. */
export function urlForLogs(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return '<invalid URL>';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
