import express, { type NextFunction, type Request, type Response } from 'express';
import { type ChatTurn } from './chat/chatTurn';
import { type UntrustedDatabase } from '@mcp-llm/database';
import { httpMetricsMiddleware } from './observability/httpMetrics';
import { type Telemetry } from './observability/telemetry';
import { type AuthService, UsernameTakenError } from './auth/authService';
import { InvalidCredentialsError, MAX_PASSWORD_LENGTH } from './auth/credentials';
import { SessionNotFoundError } from './chat/chatTurn';
import { authenticatedUser, requireAuth } from './auth/middleware';
import { requireAllowedOrigin } from './auth/origin';
import { createRateLimiters, type RequestLimits } from './rateLimit';
import { TokenBudgetExceededError } from './tokenBudget';
import { LLMRateLimitError, LLMUnavailableError } from './llm/errors';
import { type MCPStatus } from './tools/mcpToolRegistry';

export const MAX_SESSION_ID_LENGTH = 255;
export const MAX_MESSAGE_LENGTH = 20_000;
export const MAX_USERNAME_LENGTH = 255;
export const INTERNAL_ERROR_MESSAGE = 'Something went wrong. Please try again.';
const HISTORY_LIMIT = 50;
const NO_MCP_SERVERS: MCPStatus = { configured: 0, connected: 0, tools: 0 };

export interface AppDeps {
  chat: ChatTurn;
  /** Serves `/api/schema` and the health check; untrusted, so the app's own tables stay hidden. */
  database: UntrustedDatabase;
  llmProviderName: string;
  /** Verifies logins and bearer tokens; guards every `/api` route except login and health. */
  auth: AuthService;
  staticDir?: string;
  /**
   * Request failures and rate-limit rejections are logged here. When it has metrics, requests are
   * measured; the registry is served by `createMetricsApp` on a separate port, never by this app.
   */
  telemetry: Telemetry;
  /**
   * When set, sign-up, login, chat and `/api` requests are rate limited (429 once over). Daily token
   * budgets are the chat turn's; the app only maps `TokenBudgetExceededError` (and the provider's
   * `LLMRateLimitError`) to 429. A provider outage (`LLMUnavailableError`) is a 503.
   */
  requestLimits?: RequestLimits;
  /** Reverse proxies whose `X-Forwarded-For` is trusted for `req.ip`; 0 (the default) trusts none. */
  trustProxyHops?: number;
  /** Live MCP server status for `GET /api/mcp/status`; without it no server is reported. */
  mcpStatus?: () => Promise<MCPStatus>;
  /** Browser origins besides the app's own that may call `/api`; every other origin gets 403. */
  allowedOrigins?: readonly string[];
}

class BadRequestError extends Error {}

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

/** Builds the HTTP app from injected dependencies. Does not listen or touch process state. */
export function createApp(deps: AppDeps): express.Express {
  const { chat, database, auth, telemetry } = deps;
  const app = express();
  // req.ip, which per-IP limits, token budgets and logs key on.
  app.set('trust proxy', deps.trustProxyHops || false);
  const route = routeWith(telemetry);
  if (telemetry.metrics) {
    app.use(httpMetricsMiddleware(telemetry.metrics));
  }
  const limit = createRateLimiters(deps.requestLimits, telemetry);
  app.use('/api', requireAllowedOrigin(deps.allowedOrigins), limit.api);
  app.use(express.json());
  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
  }

  app.post('/api/auth/login', limit.login, route(async (req, res) => {
    const body = req.body || {};
    const username = requireCredential(body.username, 'username', MAX_USERNAME_LENGTH);
    const password = requireCredential(body.password, 'password', MAX_PASSWORD_LENGTH);
    const result = await auth.login(username, password);
    if (!result) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    res.json(result);
  }));

  app.post('/api/auth/register', limit.register, limit.registerGlobal, route(async (req, res) => {
    const body = req.body || {};
    const username = requireCredential(body.username, 'username', MAX_USERNAME_LENGTH);
    const password = requireCredential(body.password, 'password', MAX_PASSWORD_LENGTH);
    res.status(201).json(await auth.register(username, password));
  }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      llmProvider: deps.llmProviderName,
      databaseType: database.getDatabaseType(),
      connected: database.isConnected(),
      timestamp: new Date().toISOString(),
    });
  });

  // Everything registered below this line requires a valid bearer token.
  app.use('/api', requireAuth(auth));

  app.get('/api/auth/me', (_req, res) => {
    res.json({ user: authenticatedUser(res) });
  });

  app.post('/api/chat', limit.chatIp, limit.chat, route(async (req, res) => {
    const body = req.body || {};
    const message = body.message;
    if (typeof message !== 'string' || message.trim() === '') {
      throw new BadRequestError('message is required');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestError(`message must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }

    const result = await chat.handle({
      sessionId: optionalId(body.sessionId, 'sessionId'),
      userId: authenticatedUser(res).id,
      message,
      clientIp: req.ip,
    });
    res.json(result);
  }));

  app.get('/api/sessions/:sessionId/history', route(async (req, res) => {
    const sessionId = requireId(req.params.sessionId);
    const history = await chat.getHistory(authenticatedUser(res).id, sessionId, HISTORY_LIMIT);
    res.json({ sessionId, history });
  }));

  app.post('/api/sessions/:sessionId/clear', route(async (req, res) => {
    const sessionId = requireId(req.params.sessionId);
    await chat.clearSession(authenticatedUser(res).id, sessionId);
    res.json({ ok: true, sessionId });
  }));

  app.get('/api/mcp/status', route(async (_req, res) => {
    const status = deps.mcpStatus ? await deps.mcpStatus() : NO_MCP_SERVERS;
    res.json({
      ...status,
      ok: status.connected > 0 && status.connected === status.configured,
      checkedAt: new Date().toISOString(),
    });
  }));

  app.get('/api/schema', route(async (_req, res) => {
    res.json({ schema: await database.getSchema() });
  }));

  return app;
}

function routeWith({ logger }: Telemetry) {
  return (handler: AsyncHandler) => (req: Request, res: Response, _next: NextFunction) => {
    handler(req, res).catch((error: unknown) => {
      const retryAfter = retryAfterSecondsOf(error);
      if (retryAfter !== undefined) {
        res.set('Retry-After', String(retryAfter));
      }
      const status = expectedErrorStatus(error);
      if (status) {
        res.status(status).json({ error: (error as Error).message });
        return;
      }
      logger.error({ err: error, method: req.method, path: req.route?.path ?? req.path }, 'Request failed');
      // Unexpected errors can carry SQL, driver or LLM-provider details; those stay in the log.
      res.status(500).json({ error: INTERNAL_ERROR_MESSAGE });
    });
  };
}

/**
 * Status for expected errors: the client's doing, or a known provider limit or outage (already
 * logged by the LLM telemetry). These are not logged here.
 */
function expectedErrorStatus(error: unknown): number | undefined {
  if (error instanceof BadRequestError || error instanceof InvalidCredentialsError) return 400;
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof UsernameTakenError) return 409;
  if (error instanceof TokenBudgetExceededError || error instanceof LLMRateLimitError) return 429;
  if (error instanceof LLMUnavailableError) return 503;
  return undefined;
}

/** When a daily token budget, or the LLM provider's rate limit or outage, lets the client try again. */
function retryAfterSecondsOf(error: unknown): number | undefined {
  if (error instanceof TokenBudgetExceededError || error instanceof LLMRateLimitError || error instanceof LLMUnavailableError) {
    return error.retryAfterSeconds;
  }
  return undefined;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_SESSION_ID_LENGTH) {
    throw new BadRequestError(`${field} must be a string of at most ${MAX_SESSION_ID_LENGTH} characters`);
  }
  return value;
}

function requireCredential(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value === '') {
    throw new BadRequestError(`${field} is required`);
  }
  if (value.length > maxLength) {
    throw new BadRequestError(`${field} must be at most ${maxLength} characters`);
  }
  return value;
}

function requireId(value: string): string {
  const id = optionalId(value, 'sessionId');
  if (!id) {
    throw new BadRequestError('sessionId is required');
  }
  return id;
}
