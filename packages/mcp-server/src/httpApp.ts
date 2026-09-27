import { randomUUID } from "crypto";
import type { Express } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type UntrustedDatabase } from '@mcp-llm/database';
import { type Logger } from '@mcp-llm/runtime';
import { createDatabaseMcpServer } from './server';
import { type McpServerMetrics } from './metrics';
import { type McpAccessConfig, rejectForeignOrigins, requireServiceToken, sendJsonRpcError } from './access';

const MAX_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const JSON_RPC_INTERNAL_ERROR = -32603;

export interface McpHttpAppDeps {
  database: UntrustedDatabase;
  access: McpAccessConfig;
  /** Host headers accepted on /mcp (DNS-rebinding protection). */
  allowedHosts: readonly string[];
  metrics: McpServerMetrics;
  logger: Logger;
  /** Sessions with no request for this long are closed; their clients get 404 and start a new one. */
  sessionIdleTimeoutMs: number;
}

export interface McpHttpApp {
  readonly app: Express;
  /** Stops the idle sweep and closes every session. Call before closing the HTTP server: open streams keep it alive. */
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActivityAt: number;
}

/**
 * The MCP server's HTTP app: `/mcp` (Streamable HTTP, one MCP server per session, service-token
 * protected) and `/metrics`. Built from injected dependencies; does not listen or touch process state.
 */
export function createMcpHttpApp(deps: McpHttpAppDeps): McpHttpApp {
  const { metrics, logger } = deps;
  const sessions = new Map<string, Session>();
  const trackSessionCount = () => metrics.activeSessions.set(sessions.size);
  const idleSweep = startIdleSessionSweep(sessions, deps.sessionIdleTimeoutMs, logger);

  // Binds all interfaces (needed in a container) but rejects unknown Host headers.
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: [...deps.allowedHosts] });
  // Web pages may not call the server at all; /metrics stays open to Prometheus, /mcp needs the app's token.
  app.use(rejectForeignOrigins(deps.access.allowedOrigins));

  // Express 4 ignores returned promises; each async handler here catches its own errors.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', metrics.registry.contentType).send(await metrics.registry.metrics());
    } catch (error) {
      logger.error({ err: error }, 'Failed to render metrics');
      res.status(500).end();
    }
  });

  const openSession = async (): Promise<StreamableHTTPServerTransport> => {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, lastActivityAt: Date.now() });
        trackSessionCount();
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        trackSessionCount();
      }
    };
    await createDatabaseMcpServer(deps.database, metrics).connect(transport);
    return transport;
  };

  app.all('/mcp', (_req, res, next) => {
    res.on('finish', () => metrics.requests.inc({ status: String(res.statusCode) }));
    next();
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  }, requireServiceToken(deps.access.authToken), async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;

    try {
      if (sessionId && !session) {
        // Per the Streamable HTTP spec, 404 tells the client to start a new session.
        sendJsonRpcError(res, 404, 'Session not found');
        return;
      }
      if (session && sessionId) {
        sessions.set(sessionId, { ...session, lastActivityAt: Date.now() });
      }
      const transport = session?.transport ?? (isInitializeRequest(req.body) ? await openSession() : undefined);
      if (!transport) {
        sendJsonRpcError(res, 400, 'Bad Request: missing MCP session');
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error }, 'MCP request failed');
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, 'Internal server error', JSON_RPC_INTERNAL_ERROR);
      }
    }
  });

  return {
    app,
    async close() {
      clearInterval(idleSweep);
      await Promise.all([...sessions.values()].map(({ transport }) => transport.close()));
    },
  };
}

/**
 * Closes sessions with no request for `idleTimeoutMs`, so clients that disappear without
 * a DELETE don't leak. Clients of an expired session get 404 and start a new one.
 */
function startIdleSessionSweep(sessions: Map<string, Session>, idleTimeoutMs: number, logger: Logger): NodeJS.Timeout {
  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const { transport, lastActivityAt } of sessions.values()) {
      if (lastActivityAt < cutoff) {
        logger.info({ sessionId: transport.sessionId }, 'Closing idle MCP session');
        transport.close().catch((error) => logger.error({ err: error }, 'Failed to close idle MCP session'));
      }
    }
  }, Math.min(idleTimeoutMs, MAX_SESSION_SWEEP_INTERVAL_MS));
  sweep.unref();
  return sweep;
}
