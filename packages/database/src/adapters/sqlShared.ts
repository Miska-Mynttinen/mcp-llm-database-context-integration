import { type ColumnInfo, type DatabaseConfig, type DatabaseSslMode, type IndexSpec, type ReadOnlyLogin } from '../types';

// Any decimal of up to 15 significant digits survives a round trip through a double unchanged.
const MAX_EXACT_DECIMAL_DIGITS = 15;
const DECIMAL_TEXT = /^[+-]?(\d+)(?:\.(\d+))?$/;

// Login names are written into SQL as identifiers, so only plain ones (MySQL allows 32 characters).
const LOGIN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
// Passwords are written into SQL as string literals, which quotes and backslashes could end.
const QUOTES_AND_BACKSLASH = /['"\\]/;
const FIRST_PRINTABLE = ' ';
const DELETE_CHAR = '\u007f';

/** The TLS options both network drivers (pg, mysql2) take for `mode`, or undefined for plain TCP. */
export function tlsOptions(mode: DatabaseSslMode | undefined): { rejectUnauthorized: boolean } | undefined {
  if (mode === undefined || mode === 'off') {
    return undefined;
  }
  return { rejectUnauthorized: mode === 'verify' };
}

/** `config.onBackgroundError`, or one that reports to stderr, so a background error never goes unheard. */
export function backgroundErrorHandler(config: DatabaseConfig, dialect: string): (error: Error) => void {
  return config.onBackgroundError
    ?? ((error) => console.error(`${dialect} connection error outside a query: ${error.message}`));
}

/** `CREATE INDEX IF NOT EXISTS`, which PostgreSQL and SQLite support and MySQL does not. */
export function createIndexIfNotExistsSql(index: IndexSpec): string {
  return `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns.join(', ')})`;
}

/** Caps a SELECT by wrapping it in a subquery, so its own LIMIT, ORDER BY or UNION stay intact. */
export function limitBySubquery(statement: string, maxRows: number): string {
  return `SELECT * FROM (${statement}) AS read_only_query LIMIT ${requireRowLimit(maxRows)}`;
}

/** `maxRows` checked to be a positive integer, since it is written into the SQL rather than bound. */
export function requireRowLimit(maxRows: number): number {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error(`maxRows must be a positive integer, got ${maxRows}`);
  }
  return maxRows;
}

/**
 * A driver's decimal text (BIGINT, NUMERIC, DECIMAL) as a number when the number is exact:
 * a safe integer, or a fraction of at most 15 significant digits. Otherwise the text itself.
 */
export function toNumberIfExact(text: string): number | string {
  const match = DECIMAL_TEXT.exec(text);
  if (!match) {
    return text; // NaN, Infinity
  }
  const [, whole, fraction] = match;
  const value = Number(text);
  if (fraction === undefined) {
    return Number.isSafeInteger(value) ? value : text;
  }
  const significant = `${whole}${fraction}`.replace(/^0+/, '').replace(/0+$/, '');
  return significant.length <= MAX_EXACT_DECIMAL_DIGITS ? value : text;
}

/** A row of `information_schema.columns`, aliased to `ColumnInfo` names but typed however the driver chose. */
export interface InformationSchemaColumnRow {
  columnName: string;
  dataType: string;
  isNullable: string;
  columnDefault: string | null;
  characterMaximumLength: number | string | null;
  tableName: string;
  tableSchema: string;
}

export function toColumnInfo(row: InformationSchemaColumnRow): ColumnInfo {
  return {
    columnName: row.columnName,
    dataType: row.dataType,
    isNullable: row.isNullable === 'YES',
    columnDefault: row.columnDefault ?? undefined,
    characterMaximumLength: row.characterMaximumLength === null ? undefined : Number(row.characterMaximumLength),
    tableName: row.tableName,
    tableSchema: row.tableSchema,
  };
}

/**
 * `login`, checked so that its name and password can be written into SQL as they are, and that
 * it is not `ownerUser`, which the read-only grants would lock out.
 */
export function requireReadOnlyLogin(login: ReadOnlyLogin, ownerUser: string): ReadOnlyLogin {
  if (!LOGIN_NAME.test(login.user)) {
    throw new Error(`Read-only login name must be a plain identifier (letters, digits, _), got "${login.user}"`);
  }
  if (login.user.toLowerCase() === ownerUser.toLowerCase()) {
    throw new Error(`The read-only login must not be the database owner "${ownerUser}"`);
  }
  if (!isSafeLiteral(login.password)) {
    throw new Error('Read-only login password must be set, without quotes, backslashes or control characters');
  }
  return login;
}

/** Non-empty text with no quote, backslash or control character, so it can sit inside '...' as it is. */
function isSafeLiteral(text: string): boolean {
  return text.length > 0
    && !QUOTES_AND_BACKSLASH.test(text)
    && [...text].every((char) => char >= FIRST_PRINTABLE && char !== DELETE_CHAR);
}

/** An error naming the dialect, keeping the driver's error (and its code) as `cause`. */
export function queryError(dialect: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`${dialect} query error: ${message}`), { cause: error });
}
