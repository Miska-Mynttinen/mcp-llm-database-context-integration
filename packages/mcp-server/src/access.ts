import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseList, requireMcpAuthToken } from '@mcp-llm/runtime';

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;
const JSON_RPC_SERVER_ERROR = -32000;

export interface McpAccessConfig {
  /** The token the chat app sends as `Authorization: Bearer <token>`. */
  authToken: string;
  /** Browser origins allowed to call the server. Empty by default: only non-browser clients such as the chat app. */
  allowedOrigins: readonly string[];
}

/** Reads MCP_AUTH_TOKEN (required) and MCP_ALLOWED_ORIGINS; throws when the token is missing or short. */
export function readMcpAccessConfig(env: NodeJS.ProcessEnv = process.env): McpAccessConfig {
  return {
    authToken: requireMcpAuthToken(env, 'to run the MCP server'),
    allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
  };
}

export function sendJsonRpcError(res: Response, status: number, message: string, code = JSON_RPC_SERVER_ERROR): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Rejects browser requests from origins not in `allowedOrigins` with 403. The chat app calls from
 * Node and sends no Origin, so by default every request that carries one (any web page) is refused.
 */
export function rejectForeignOrigins(allowedOrigins: readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      sendJsonRpcError(res, 403, 'Origin not allowed');
      return;
    }
    next();
  };
}

/** Requires `Authorization: Bearer <authToken>`, compared in constant time; 401 otherwise. */
export function requireServiceToken(authToken: string): RequestHandler {
  const expected = digest(authToken);
  return (req: Request, res: Response, next: NextFunction) => {
    const match = BEARER_PREFIX.exec(req.get('authorization') ?? '');
    if (!match || !timingSafeEqual(digest(match[1].trim()), expected)) {
      res.set('WWW-Authenticate', 'Bearer');
      sendJsonRpcError(res, 401, 'Unauthorized');
      return;
    }
    next();
  };
}

// Hashing first gives equal-length buffers, as timingSafeEqual requires, without leaking the length.
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
