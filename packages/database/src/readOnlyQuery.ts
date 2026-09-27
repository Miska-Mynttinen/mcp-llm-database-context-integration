import { assertNoInternalTableAccess } from './appTables';

export const DEFAULT_ROW_LIMIT = 100;
export const MAX_ROW_LIMIT = 1000;

const READ_STATEMENT_START = /^(WITH\s+.*\s+SELECT\b|SELECT\b)/i;
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|MERGE|INTO|ATTACH|DETACH|PRAGMA|VACUUM)\b/i;
const COMMENT_MARKERS = /--|\/\*|\*\//;

/**
 * Checks that `sql` is a single read-only SELECT (or WITH ... SELECT) statement.
 * Returns the statement without its trailing semicolon, ready to embed in a subquery.
 */
export function validateReadOnlyQuery(sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, '').trim();
  if (!statement) {
    throw new Error('SQL statement is empty');
  }

  if (statement.includes(';')) {
    throw new Error('Only a single SQL statement is allowed');
  }

  if (COMMENT_MARKERS.test(statement)) {
    throw new Error('SQL comments are not allowed');
  }

  const normalized = statement.replace(/\s+/g, ' ');
  if (!READ_STATEMENT_START.test(normalized)) {
    throw new Error('Only SELECT queries are allowed');
  }

  if (WRITE_KEYWORDS.test(normalized)) {
    throw new Error('Only read-only SELECT queries are allowed');
  }

  assertNoInternalTableAccess(statement);

  return statement;
}

/** A requested row count as an integer in [1, MAX_ROW_LIMIT]; anything unusable means the default. */
export function clampRowLimit(limit: unknown): number {
  const requested = Number(limit ?? DEFAULT_ROW_LIMIT);
  if (!Number.isFinite(requested) || requested < 1) {
    return DEFAULT_ROW_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_ROW_LIMIT);
}
