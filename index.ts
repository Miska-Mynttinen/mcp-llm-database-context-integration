import { type Server } from 'http';
import path from 'path';
import { connectDatabaseAdapter, createUntrustedDatabase, readDatabaseConfigFromEnv, readReadOnlyLoginFromEnv } from '@mcp-llm/database';
import { assertNoDevelopmentSecrets, createLogger, isProduction } from '@mcp-llm/runtime';
import { createLLMProvider, readLLMConfigFromEnv } from './src/llm';
import { createChatTurn } from './src/chat/chatTurn';
import { openAppStorage } from './src/storage/appStorage';
import { createHistoryToolRegistry } from './src/tools/historyTools';
import { connectMCPToolRegistry, readMCPServerConfig } from './src/tools/mcpToolRegistry';
import { createTools } from './src/tools/tools';
import { createApp } from './src/app';
import { loadConfigEnvFiles } from './src/config/envFiles';
import { readRequestLimitsFromEnv } from './src/rateLimit';
import { createTokenBudget, readTokenBudgetsFromEnv } from './src/tokenBudget';
import { readTrustProxyHopsFromEnv } from './src/config/http';
import { createAuthService, createTokenService, readAuthConfigFromEnv, seedFromConfig } from './src/auth';
import { createMetrics, createMetricsApp, createTelemetry } from './src/observability';

const loadedEnvFiles = loadConfigEnvFiles();

const PORT = Number(process.env.PORT || 3000);
const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';
// Metrics get their own port so a reverse proxy in front of PORT never exposes them.
const METRICS_PORT = Number(process.env.METRICS_PORT || 9464);
const METRICS_HOST = process.env.METRICS_HOST || '127.0.0.1';
const logger = createLogger({ service: 'app', level: process.env.LOG_LEVEL });

async function main(): Promise<void> {
  const production = isProduction();
  assertNoDevelopmentSecrets();
  const telemetry = createTelemetry(logger, METRICS_ENABLED ? createMetrics() : undefined);
  const authConfig = readAuthConfigFromEnv();
  const requestLimits = readRequestLimitsFromEnv();
  const tokenBudgets = readTokenBudgetsFromEnv();
  const trustProxyHops = readTrustProxyHopsFromEnv();
  const mcpServers = readMCPServerConfig();
  const warnOrError = production ? 'error' : 'warn';
  if (!requestLimits) {
    logger[warnOrError]('RATE_LIMIT_ENABLED=false: sign-up, login and chat are not rate limited');
  }
  if (Object.values(tokenBudgets).every((budget) => budget === undefined)) {
    logger[warnOrError]('Every CHAT_TOKENS_DAILY_* budget is off: chat has no daily token budget');
  }
  const readOnlyLogin = readReadOnlyLoginFromEnv();
  const database = await connectDatabaseAdapter({
    ...readDatabaseConfigFromEnv(),
    onBackgroundError: (error) => logger.error({ err: error }, 'Database connection error outside a query'),
  });
  const { users, conversations, tokenUsage } = await openAppStorage(database, { readOnlyLogin });
  if (readOnlyLogin) {
    logger.info({ user: readOnlyLogin.user }, 'Read-only database login granted every table but the app tables');
  }
  // What the LLM, its tools and API clients may see: the app's own tables stay hidden.
  const untrustedDatabase = createUntrustedDatabase(database);
  const seeded = await seedFromConfig(users, authConfig.seed);
  if (seeded.length === 0) {
    logger.warn('SEED_USER_PASSWORD is not set: no users seeded (accounts can still be created by sign-up)');
  }
  for (const { username, outcome } of seeded) {
    logger.info({ username, outcome }, 'User seeded');
  }
  const auth = createAuthService({
    users,
    tokens: createTokenService({ secret: authConfig.jwtSecret, expiresIn: authConfig.jwtExpiresIn }),
  });
  const llmConfig = readLLMConfigFromEnv();
  const llmLabels = { provider: llmConfig.provider, model: llmConfig.model || 'default' };
  const llm = telemetry.llm(createLLMProvider(llmConfig), llmLabels);
  // The database context tools come only from MCP servers; the app serves conversation history itself.
  const mcpTools = await connectMCPToolRegistry(mcpServers, undefined, logger);
  if (mcpTools.definitions.length === 0) {
    logger[warnOrError]('No MCP tools registered: the LLM has no database tools. Set MCP_SERVER_URLS to the database MCP server');
  }
  const tools = telemetry.tools(createTools([createHistoryToolRegistry(conversations), mcpTools]));

  const budget = createTokenBudget(tokenBudgets, tokenUsage, { telemetry });

  const app = createApp({
    chat: telemetry.chat(createChatTurn({ llm, store: conversations, tools, budget, readContext: mcpTools.readContext })),
    database: untrustedDatabase,
    llmProviderName: llmConfig.provider,
    auth,
    staticDir: path.join(__dirname, 'frontend'),
    telemetry,
    requestLimits,
    trustProxyHops,
    allowedOrigins: authConfig.allowedOrigins,
    mcpStatus: () => mcpTools.status(),
  });

  const server = app.listen(PORT, () => {
    logger.info({
      port: PORT,
      configFiles: loadedEnvFiles.map((file) => path.basename(file)),
      llmProvider: llmConfig.provider,
      llmModel: llmLabels.model,
      databaseType: database.getDatabaseType(),
      metrics: METRICS_ENABLED ? { host: METRICS_HOST, port: METRICS_PORT } : 'disabled',
      requestLimits: requestLimits ?? 'disabled',
      tokenBudgets,
      trustProxyHops,
      mcpTools: mcpTools.definitions.length,
      production,
    }, `Chat server running on port ${PORT}`);
  });

  const metricsServer = telemetry.metrics
    ? createMetricsApp(telemetry.metrics).listen(METRICS_PORT, METRICS_HOST)
    : undefined;
  metricsServer?.on('error', (error) => {
    logger.fatal({ err: error, port: METRICS_PORT, host: METRICS_HOST }, 'Metrics server failed');
    process.exit(1);
  });

  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    try {
      // Let in-flight requests finish before closing what they use.
      await Promise.all([server, metricsServer].flatMap((open) => (open ? [closeServer(open)] : [])));
      await mcpTools.close();
      await database.disconnect();
      await llm.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Graceful shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to initialize app');
  process.exit(1);
});
