import { type RequestHandler } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { authenticatedUser } from '../auth/middleware';
import { type Telemetry } from '../observability/telemetry';
import { type LimitRule, type RequestLimits } from './config';

export type LimiterName = keyof RequestLimits;

export type RateLimiters = Readonly<Record<LimiterName, RequestHandler>>;

const REGISTER_MESSAGE = 'Too many sign-up attempts, please try again later';
const CHAT_MESSAGE = 'Too many messages, please slow down and try again shortly';
const GLOBAL_KEY = 'global';

const passThrough: RequestHandler = (_req, _res, next) => next();

/**
 * Builds one in-memory limiter per configured rule, and pass-through middleware for rules that are off
 * or when `limits` is undefined (RATE_LIMIT_ENABLED=false). Rejections are reported to `telemetry`.
 * Limits are per app instance; running several instances needs a shared store (such as Redis) to keep them exact.
 */
export function createRateLimiters(limits: RequestLimits | undefined, telemetry?: Pick<Telemetry, 'rateLimited'>): RateLimiters {
  const limiter = (name: LimiterName, message: string, options: Partial<Options> = {}): RequestHandler => {
    const rule: LimitRule | undefined = limits?.[name];
    if (!rule) {
      return passThrough;
    }
    return rateLimit({
      windowMs: rule.windowMs,
      limit: rule.limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      identifier: name,
      handler: (req, res, _next, used) => {
        telemetry?.rateLimited(name, { ip: req.ip, path: req.path });
        res.status(used.statusCode).json({ error: message });
      },
      ...options,
    });
  };

  return {
    register: limiter('register', REGISTER_MESSAGE),
    registerGlobal: limiter('registerGlobal', REGISTER_MESSAGE, { keyGenerator: () => GLOBAL_KEY }),
    login: limiter('login', 'Too many failed login attempts, please try again later', {
      skipSuccessfulRequests: true,
    }),
    chat: limiter('chat', CHAT_MESSAGE, { keyGenerator: (_req, res) => authenticatedUser(res).id }),
    chatIp: limiter('chatIp', CHAT_MESSAGE),
    api: limiter('api', 'Too many requests, please try again later'),
  };
}
