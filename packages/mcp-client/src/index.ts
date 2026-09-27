import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLIENT_INFO = { name: "database-mcp-client", version: "1.0.0" };
const SESSION_NOT_FOUND = 404;

export interface MCPClientOptions {
  /** Sent as `Authorization: Bearer <token>` on every request; the database MCP server requires it. */
  authToken?: string;
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === SESSION_NOT_FOUND;
}

/**
 * Streamable HTTP connection to one MCP server. Connects on first use. When the server
 * has dropped the session (idle timeout or restart), it starts a new one and retries once.
 */
export default class MCPClient {
  private readonly serverUrl: URL;
  private readonly requestInit: RequestInit | undefined;
  private session: Promise<Client> | undefined;

  constructor(mcpServerUrl: string, options: MCPClientOptions = {}) {
    this.serverUrl = new URL(mcpServerUrl);
    this.requestInit = options.authToken
      ? { headers: { Authorization: `Bearer ${options.authToken}` } }
      : undefined;
  }

  async listTools() {
    return this.withSession((client) => client.listTools());
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return this.withSession((client) => client.callTool({ name, arguments: args }));
  }

  async listResources() {
    return this.withSession((client) => client.listResources());
  }

  async readResource(uri: string) {
    return this.withSession((client) => client.readResource({ uri }));
  }

  /** Round-trips a ping, reconnecting first when the server dropped the session. */
  async ping(options: { timeout?: number } = {}) {
    return this.withSession((client) => client.ping(options));
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    const client = await session?.catch(() => undefined);
    await client?.close();
  }

  private connect(): Promise<Client> {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const session = client
      .connect(new StreamableHTTPClientTransport(this.serverUrl, { requestInit: this.requestInit }))
      .then(() => client);
    // A failed connect must not stick: the next call tries again.
    session.catch(() => {
      if (this.session === session) {
        this.session = undefined;
      }
    });
    return session;
  }

  private getSession(): Promise<Client> {
    this.session ??= this.connect();
    return this.session;
  }

  private async withSession<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const session = this.getSession();
    const client = await session;
    try {
      return await operation(client);
    } catch (error) {
      if (!isSessionExpired(error)) {
        throw error;
      }
      if (this.session === session) {
        this.session = undefined;
        client.close().catch(() => undefined);
      }
      return operation(await this.getSession());
    }
  }
}
