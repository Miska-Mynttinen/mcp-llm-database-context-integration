import { isOff, WHOLE_NUMBER } from '../config/settings';

/** LLM tokens allowed per UTC day; an undefined budget is off. */
export interface TokenBudgets {
  user?: number;
  ip?: number;
  global?: number;
}

/** Defaults, in the token-count form of `.env.limits`. */
export const DEFAULT_TOKEN_BUDGETS = {
  CHAT_TOKENS_DAILY_USER: '100000',
  CHAT_TOKENS_DAILY_IP: '300000',
  CHAT_TOKENS_DAILY_GLOBAL: 'off',
} as const;

type BudgetName = keyof typeof DEFAULT_TOKEN_BUDGETS;

/**
 * Reads the CHAT_TOKENS_DAILY_* settings (normally from `.env.limits`); throws on bad values.
 * Independent of RATE_LIMIT_ENABLED: set each budget to `off` to turn budgets off.
 */
export function readTokenBudgetsFromEnv(env: NodeJS.ProcessEnv = process.env): TokenBudgets {
  const budget = (name: BudgetName) => parseTokenBudget(name, env[name]?.trim() || DEFAULT_TOKEN_BUDGETS[name]);
  return {
    user: budget('CHAT_TOKENS_DAILY_USER'),
    ip: budget('CHAT_TOKENS_DAILY_IP'),
    global: budget('CHAT_TOKENS_DAILY_GLOBAL'),
  };
}

function parseTokenBudget(name: string, value: string): number | undefined {
  if (isOff(value)) {
    return undefined;
  }
  if (!WHOLE_NUMBER.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive number of tokens, or "off" (got "${value}")`);
  }
  return Number(value);
}
