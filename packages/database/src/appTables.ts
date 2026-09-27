import { type DatabaseAdapter, type ReadOnlyLogin } from './types';

/** A secondary index on an app table; `name` must be unique across the database. */
export interface AppTableIndex {
  readonly name: string;
  readonly columns: readonly string[];
}

/**
 * One of the chat app's own tables. `createAppTables` creates exactly these, and untrusted
 * readers never see them, so a table cannot be created without also being hidden.
 */
export interface AppTable {
  readonly name: string;
  /** Column definitions, portable across SQLite, PostgreSQL and MySQL (MySQL rejects TEXT primary keys). */
  readonly columns: readonly string[];
  readonly indexes: readonly AppTableIndex[];
}

/**
 * The chat app's own tables: their names, columns and indexes, in one place.
 * `users` holds password hashes; the chat tables hold every user's conversations (the LLM
 * reads its own user's history through the `get_conversation_history` tool instead);
 * `tokenUsage` holds each user's and client IP's daily token counts.
 */
export const APP_TABLES = {
  users: {
    name: 'app_users',
    columns: [
      'id VARCHAR(255) PRIMARY KEY',
      'username VARCHAR(255) NOT NULL UNIQUE',
      'password_hash VARCHAR(255) NOT NULL',
      'role VARCHAR(32) NOT NULL',
      'created_at VARCHAR(32) NOT NULL',
    ],
    indexes: [],
  },
  chatSessions: {
    name: 'chat_sessions',
    columns: [
      'id VARCHAR(255) PRIMARY KEY',
      'user_id VARCHAR(255)',
      'created_at VARCHAR(32) NOT NULL',
      'updated_at VARCHAR(32) NOT NULL',
    ],
    // History reads across a user's conversations filter sessions by owner.
    indexes: [{ name: 'idx_chat_sessions_user', columns: ['user_id'] }],
  },
  chatMessages: {
    name: 'chat_messages',
    columns: [
      'id VARCHAR(255) PRIMARY KEY',
      'session_id VARCHAR(255) NOT NULL',
      'role VARCHAR(16) NOT NULL',
      'content TEXT NOT NULL',
      'created_at VARCHAR(32) NOT NULL',
    ],
    // Every history read filters messages by session, newest first.
    indexes: [{ name: 'idx_chat_messages_session_created', columns: ['session_id', 'created_at'] }],
  },
  tokenUsage: {
    // One row per charge, so recording is a plain INSERT rather than a dialect-specific upsert.
    name: 'llm_token_usage',
    columns: [
      'id VARCHAR(255) PRIMARY KEY',
      'user_id VARCHAR(255) NOT NULL',
      'client_ip VARCHAR(64) NOT NULL',
      'day VARCHAR(10) NOT NULL',
      'tokens INTEGER NOT NULL',
      'created_at VARCHAR(32) NOT NULL',
    ],
    // Every chat request sums one day's rows before calling the LLM; without this it scans all history.
    indexes: [{ name: 'idx_llm_token_usage_day', columns: ['day'] }],
  },
} as const satisfies Record<string, AppTable>;

export const INTERNAL_TABLES: readonly string[] = Object.values(APP_TABLES).map((table) => table.name);

/** Creates every app table and index where missing. Idempotent. */
export async function createAppTables(database: DatabaseAdapter): Promise<void> {
  for (const table of Object.values(APP_TABLES) as readonly AppTable[]) {
    await database.query(`CREATE TABLE IF NOT EXISTS ${table.name} (\n  ${table.columns.join(',\n  ')}\n)`);
    for (const index of table.indexes) {
      await database.ensureIndex({ name: index.name, table: table.name, columns: index.columns });
    }
  }
}

/** Creates or updates `login` as a read-only login that can read every table but the app tables. Idempotent. */
export async function grantReadOnlyLogin(database: DatabaseAdapter, login: ReadOnlyLogin): Promise<void> {
  await database.ensureReadOnlyLogin(login, INTERNAL_TABLES);
}

// PostgreSQL features that name a table without spelling it out: Unicode-escaped
// identifiers/strings (U&"..."), and functions that run a query or read a table given as text.
const INDIRECT_TABLE_ACCESS = /\bU&|\b\w*_to_xml\w*\s*\(|\bdblink\w*\s*\(|\bpg_read_(binary_)?file\s*\(|\blo_(get|import|export)\s*\(|\bts_(stat|rewrite)\s*\(/i;

// System catalogues, which a query can filter by a computed table name ('app_' || 'users'). Some
// hold sampled column values (pg_stats, MySQL column statistics) or other sessions' SQL; the
// database context tools already describe the schema, so untrusted queries need none of them.
const SYSTEM_CATALOGUES = /\b(pg_catalog|pg_stat\w*|information_schema|performance_schema|sqlite_(master|schema|temp_master|temp_schema|dbpage|stat\d)|pragma_\w+)\b|\b(mysql|sys)\s*\./i;

export function isInternalTable(tableName: string): boolean {
  return INTERNAL_TABLES.includes(tableName.toLowerCase());
}

/**
 * Throws when `sql` could read an internal table. Deliberately coarse (substring match on the
 * table name, whatever the quoting or case): a defense-in-depth guard, not a substitute for a
 * database role that lacks access to those tables.
 */
export function assertNoInternalTableAccess(sql: string): void {
  const lowered = sql.toLowerCase();
  if (INTERNAL_TABLES.some((table) => lowered.includes(table))) {
    throw new Error('Query references an internal application table');
  }
  if (INDIRECT_TABLE_ACCESS.test(sql)) {
    throw new Error('Query uses an escaped identifier or a function that is not allowed');
  }
  if (SYSTEM_CATALOGUES.test(sql)) {
    throw new Error('Query reads a system catalogue; use the schema tools instead');
  }
}
