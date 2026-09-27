import { parseDuration } from '../config/duration';
import { isOff } from '../config/settings';

/** At most `limit` requests per key within each `windowMs`. */
export interface LimitRule {
  windowMs: number;
  limit: number;
}

/** Request limits; an undefined rule is off. */
export interface RequestLimits {
  /** Sign-ups per client IP, successful or not. */
  register?: LimitRule;
  /** Sign-ups across all clients, so spreading over many IPs doesn't help. */
  registerGlobal?: LimitRule;
  /** Failed logins per client IP; successful logins don't count. */
  login?: LimitRule;
  /** Chat turns per authenticated user. */
  chat?: LimitRule;
  /** Chat turns per client IP, whichever account sends them. */
  chatIp?: LimitRule;
  /** Every `/api` request per client IP; a general backstop. */
  api?: LimitRule;
}

/** Defaults, in the same `<count>/<window>` form as `.env.limits`. */
export const DEFAULT_REQUEST_LIMITS = {
  RATE_LIMIT_REGISTER_IP: '5/1h',
  RATE_LIMIT_REGISTER_GLOBAL: '50/1h',
  RATE_LIMIT_LOGIN_FAILED_IP: '10/15m',
  RATE_LIMIT_CHAT_USER: '20/1m',
  RATE_LIMIT_CHAT_IP: '40/1m',
  RATE_LIMIT_API_IP: '300/1m',
} as const;

type LimitName = keyof typeof DEFAULT_REQUEST_LIMITS;

const RULE = /^(\d+)\s*\/\s*(.+)$/;

/**
 * Reads the RATE_LIMIT_* settings (normally from `.env.limits`); throws on bad values.
 * Returns `undefined` when RATE_LIMIT_ENABLED=false. Daily token budgets are separate (`tokenBudget`).
 */
export function readRequestLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RequestLimits | undefined {
  if (env.RATE_LIMIT_ENABLED === 'false') {
    return undefined;
  }
  const rule = (name: LimitName) => parseRule(name, env[name]?.trim() || DEFAULT_REQUEST_LIMITS[name]);
  return {
    register: rule('RATE_LIMIT_REGISTER_IP'),
    registerGlobal: rule('RATE_LIMIT_REGISTER_GLOBAL'),
    login: rule('RATE_LIMIT_LOGIN_FAILED_IP'),
    chat: rule('RATE_LIMIT_CHAT_USER'),
    chatIp: rule('RATE_LIMIT_CHAT_IP'),
    api: rule('RATE_LIMIT_API_IP'),
  };
}

/** Parses `<count>/<window>`, such as `5/1h`, or `off`. */
function parseRule(name: string, value: string): LimitRule | undefined {
  if (isOff(value)) {
    return undefined;
  }
  const match = RULE.exec(value);
  const windowMs = match ? parseDuration(match[2]) : undefined;
  if (!match || !windowMs || Number(match[1]) < 1) {
    throw new Error(`${name} must be <count>/<window> such as 5/1h or 300/1m, or "off" (got "${value}")`);
  }
  return { windowMs, limit: Number(match[1]) };
}
