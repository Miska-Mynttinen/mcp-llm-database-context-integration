import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { parseList } from '@mcp-llm/runtime';

/**
 * Reads ALLOWED_ORIGINS: comma-separated origins (scheme://host[:port]) besides the app's own that
 * may call the API from a browser. Throws on anything that isn't a bare origin.
 */
export function readAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseList(env.ALLOWED_ORIGINS)
    .map((origin) => {
      if (safeOrigin(origin) !== origin) {
        throw new Error(`ALLOWED_ORIGINS entries must be origins such as https://chat.example.com (got "${origin}")`);
      }
      return origin;
    });
}

/**
 * Rejects browser requests from other sites with 403. A request's `Origin` must be the app's own
 * (same host as the `Host` header) or listed in `allowedOrigins`. Requests without an `Origin`,
 * such as same-origin GETs and non-browser clients, pass unless the browser marks them cross-site.
 */
export function requireAllowedOrigin(allowedOrigins: readonly string[] = []): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    const allowed = origin === undefined
      ? req.get('sec-fetch-site') !== 'cross-site'
      : allowedOrigins.includes(origin) || isSameHost(origin, req.get('host'));
    if (!allowed) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  };
}

function isSameHost(origin: string, host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    // Includes the literal "null" origin of sandboxed frames and file:// pages.
    return false;
  }
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
