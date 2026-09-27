import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { secondsSince } from '@mcp-llm/runtime';
import { type Metrics } from './metrics';

/**
 * Records every HTTP request. The route label is the matched route template
 * (`/api/sessions/:sessionId/history`), never the raw path, so ids don't become series.
 */
export function httpMetricsMiddleware(metrics: Metrics): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = routeLabel(req, res);
      metrics.http.requests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.http.duration.observe({ method: req.method, route }, secondsSince(start));
    });
    next();
  };
}

function routeLabel(req: Request, res: Response): string {
  if (req.route?.path) {
    return String(req.route.path);
  }
  // Unmatched GETs are either static UI files or misses; neither gets its own series.
  return req.method === 'GET' && res.statusCode < 400 ? 'static' : 'unmatched';
}
