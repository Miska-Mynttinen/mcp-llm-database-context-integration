import { connectDatabaseAdapter, createUntrustedDatabase, readDatabaseConfigFromEnv, readReadOnlyLoginFromEnv } from '@mcp-llm/database';
import { assertNoDevelopmentSecrets, createLogger, ENV_FILES, isProduction, loadEnvFiles, parseList } from '@mcp-llm/runtime';
import { createMcpHttpApp } from './httpApp';
import { createMcpServerMetrics } from './metrics';
import { readMcpAccessConfig } from './access';

const DEFAULT_PORT = 3001;
// Host headers accepted on /mcp (DNS-rebinding protection). `mcp-server` is the docker-compose service name.
const DEFAULT_ALLOWED_HOSTS = 'localhost,127.0.0.1,[::1],mcp-server';
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Settings shared with the chat app: DB_* and MCP_AUTH_TOKEN.
loadEnvFiles(process.cwd(), [ENV_FILES.database, ENV_FILES.mcp]);

// JSON logs to stdout, read by the monitoring stack's log shipper.
const logger = createLogger({ service: 'mcp-server', level: process.env.LOG_LEVEL });

function readSessionIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MCP_SESSION_IDLE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

/**
 * Connects as the read-only login (DB_READONLY_USER) when one is set, so the database itself
 * keeps untrusted SQL away from the app tables; otherwise as DB_USER, with only the SQL guard.
 * SQLite has no logins, so its connection refuses writes instead (it still sees the app tables).
 */
async function connectUntrustedReader() {
  const config = {
    ...readDatabaseConfigFromEnv(),
    readOnly: true,
    onBackgroundError: (error: Error) => logger.error({ err: error }, 'Database connection error outside a query'),
  };
  const readOnlyLogin = readReadOnlyLoginFromEnv();
  if (readOnlyLogin) {
    logger.info({ user: readOnlyLogin.user }, 'Connecting as the read-only database login');
    return connectDatabaseAdapter({ ...config, ...readOnlyLogin });
  }
  if (config.type !== 'sqlite') {
    logger[isProduction() ? 'error' : 'warn'](
      'DB_READONLY_USER is not set: queries run as DB_USER, and only the SQL guard keeps them from the app tables',
    );
  }
  return connectDatabaseAdapter(config);
}

async function main() {
  const access = readMcpAccessConfig();
  assertNoDevelopmentSecrets();
  const database = await connectUntrustedReader();
  const mcp = createMcpHttpApp({
    database: createUntrustedDatabase(database),
    access,
    allowedHosts: parseList(process.env.MCP_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS),
    metrics: createMcpServerMetrics(),
    logger,
    sessionIdleTimeoutMs: readSessionIdleTimeoutMs(),
  });

  const port = Number(process.env.PORT || DEFAULT_PORT);
  const httpServer = mcp.app.listen(port, () => {
    logger.info(
      { port, databaseType: database.getDatabaseType() },
      `Database MCP Server running on Streamable HTTP at http://localhost:${port}/mcp`,
    );
  });

  const closeServer = async () => {
    try {
      // Close sessions first: open SSE streams would otherwise keep the HTTP server from closing.
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await database.disconnect();
    } catch (error) {
      logger.error({ err: error }, 'Error during MCP server shutdown');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void closeServer());
  process.once('SIGTERM', () => void closeServer());
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start server');
  process.exit(1);
});
