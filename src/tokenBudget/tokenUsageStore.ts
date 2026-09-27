import { randomUUID } from 'crypto';
import { APP_TABLES, type DatabaseAdapter } from '@mcp-llm/database';

const TOKEN_USAGE_TABLE = APP_TABLES.tokenUsage.name;

/** Who a chat turn's tokens are charged to. */
export interface TokenUsageKey {
  userId: string;
  ip: string;
}

/** Tokens used on one day by the user, by the IP, and by everyone. */
export interface TokenUsageTotals {
  user: number;
  ip: number;
  global: number;
}

export interface TokenUsageStore {
  /** Adds `tokens` to `day` (a UTC `YYYY-MM-DD` date) for the key. */
  record(day: string, key: TokenUsageKey, tokens: number): Promise<void>;
  usedOn(day: string, key: TokenUsageKey): Promise<TokenUsageTotals>;
}

/**
 * Persists LLM token usage in the configured database, so daily budgets survive restarts.
 * Get it from `openAppStorage`, which creates its table.
 */
export class SqlTokenUsageStore implements TokenUsageStore {
  constructor(private readonly database: DatabaseAdapter) {}

  async record(day: string, key: TokenUsageKey, tokens: number): Promise<void> {
    await this.database.query(
      `INSERT INTO ${TOKEN_USAGE_TABLE} (id, user_id, client_ip, day, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), key.userId, key.ip, day, tokens, new Date().toISOString()],
    );
  }

  async usedOn(day: string, key: TokenUsageKey): Promise<TokenUsageTotals> {
    const { rows } = await this.database.query<UsageTotalsRow>(
      `SELECT
         COALESCE(SUM(CASE WHEN user_id = ? THEN tokens ELSE 0 END), 0) AS user_tokens,
         COALESCE(SUM(CASE WHEN client_ip = ? THEN tokens ELSE 0 END), 0) AS ip_tokens,
         COALESCE(SUM(tokens), 0) AS global_tokens
       FROM ${TOKEN_USAGE_TABLE} WHERE day = ?`,
      [key.userId, key.ip, day],
    );
    const row = rows[0];
    return { user: row?.user_tokens ?? 0, ip: row?.ip_tokens ?? 0, global: row?.global_tokens ?? 0 };
  }
}

interface UsageTotalsRow {
  user_tokens: number;
  ip_tokens: number;
  global_tokens: number;
}

interface UsageEntry extends TokenUsageKey {
  day: string;
  tokens: number;
}

/** Process-local store for tests. */
export class InMemoryTokenUsageStore implements TokenUsageStore {
  private entries: readonly UsageEntry[] = [];

  async record(day: string, key: TokenUsageKey, tokens: number): Promise<void> {
    this.entries = [...this.entries, { ...key, day, tokens }];
  }

  async usedOn(day: string, key: TokenUsageKey): Promise<TokenUsageTotals> {
    const sum = (match: (entry: UsageEntry) => boolean) =>
      this.entries.filter((entry) => entry.day === day && match(entry)).reduce((total, entry) => total + entry.tokens, 0);
    return {
      user: sum((entry) => entry.userId === key.userId),
      ip: sum((entry) => entry.ip === key.ip),
      global: sum(() => true),
    };
  }
}
