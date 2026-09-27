import { type ChatReply } from '../llm/types';
import { type Telemetry } from '../observability/telemetry';
import { type TokenBudgets } from './config';
import { type TokenUsageKey, type TokenUsageStore, type TokenUsageTotals } from './tokenUsageStore';

const DAY_MS = 86_400_000;
const SCOPES: readonly BudgetScope[] = ['user', 'ip', 'global'];
/** Charged for turns whose client IP is not known. */
const UNKNOWN_IP = 'unknown';

const MESSAGES: Readonly<Record<BudgetScope, string>> = {
  user: 'You have reached your daily AI token limit. It resets at 00:00 UTC.',
  ip: 'Your network has reached its daily AI token limit. It resets at 00:00 UTC.',
  global: 'The service has reached its daily AI token limit. It resets at 00:00 UTC.',
};

export type BudgetScope = keyof TokenUsageTotals;

/** Today's usage has reached the `scope` budget; it resets at 00:00 UTC, `retryAfterSeconds` from now. */
export class TokenBudgetExceededError extends Error {
  constructor(readonly scope: BudgetScope, readonly retryAfterSeconds: number) {
    super(MESSAGES[scope]);
  }
}

/** Who a chat turn is for: the authenticated user and, when known, the client's IP. */
export interface BudgetClient {
  userId: string;
  clientIp?: string;
}

/** Charges one chat turn's LLM replies to its client. */
export interface TurnMeter {
  /** Adds the reply's tokens. Never rejects: the tokens are already spent, so a failure is logged. */
  charge(reply: Pick<ChatReply, 'usage'>): Promise<void>;
}

export interface TokenBudget {
  /**
   * Starts a chat turn for `client`. Throws `TokenBudgetExceededError` once today's usage has reached
   * any configured budget; errors reading the usage store propagate.
   */
  openTurn(client: BudgetClient): Promise<TurnMeter>;
}

export interface TokenBudgetDeps {
  /** Rejections and failed charges are reported here. */
  telemetry?: Pick<Telemetry, 'logger' | 'budgetRefused'>;
  /** Clock, for tests. */
  now?: () => Date;
}

const UNMETERED: TurnMeter = { charge: async () => undefined };

/** A budget with no limits: every turn opens and nothing is recorded. */
export const UNLIMITED_BUDGET: TokenBudget = { openTurn: async () => UNMETERED };

/**
 * Daily LLM token budgets per user, per IP and overall, reset at 00:00 UTC. A turn is checked when
 * it opens and charged after every LLM reply, so a turn can overshoot by what it uses, and turns
 * that open together all pass the check. With no budget set, nothing is read or recorded.
 */
export function createTokenBudget(budgets: TokenBudgets, store: TokenUsageStore, deps: TokenBudgetDeps = {}): TokenBudget {
  const now = deps.now ?? (() => new Date());
  const scopes = SCOPES.filter((scope) => budgets[scope] !== undefined);
  if (scopes.length === 0) {
    return UNLIMITED_BUDGET;
  }

  const meterFor = (key: TokenUsageKey): TurnMeter => ({
    async charge(reply) {
      const tokens = reply.usage?.totalTokens ?? 0;
      if (tokens <= 0) {
        return;
      }
      try {
        await store.record(utcDay(now()), key, tokens);
      } catch (error) {
        deps.telemetry?.logger.error({ err: error }, 'Recording token usage failed');
      }
    },
  });

  return {
    async openTurn(client) {
      const key: TokenUsageKey = { userId: client.userId, ip: client.clientIp ?? UNKNOWN_IP };
      const today = now();
      const used = await store.usedOn(utcDay(today), key);
      const exceeded = scopes.find((scope) => used[scope] >= (budgets[scope] as number));
      if (exceeded) {
        deps.telemetry?.budgetRefused(exceeded, { ip: key.ip });
        throw new TokenBudgetExceededError(exceeded, secondsUntilNextUtcDay(today));
      }
      return meterFor(key);
    },
  };
}

/** The UTC date, as `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(date: Date): number {
  const nextDay = Math.floor(date.getTime() / DAY_MS + 1) * DAY_MS;
  return Math.ceil((nextDay - date.getTime()) / 1000);
}
