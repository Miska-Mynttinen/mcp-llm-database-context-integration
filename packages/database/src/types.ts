/**
 * Database abstraction layer - defines interface for all database adapters
 */

/** A result row keyed by column name. Adapters do not know column types at compile time. */
export type Row = Record<string, unknown>;

export interface QueryResult<TRow = Row> {
  rows: TRow[];
  rowCount: number;
  command?: string;
}

export interface QueryOptions {
  /** Caps a single SELECT at this many rows (a positive integer), in SQL, so the rest are never produced. */
  maxRows?: number;
}

export interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault?: string;
  characterMaximumLength?: number;
  tableName: string;
  tableSchema: string;
}

export interface TableInfo {
  tableName: string;
  tableSchema: string;
  tableType: string; // 'BASE TABLE', 'VIEW', etc.
}

export interface SchemaInfo {
  tables: TableInfo[];
  columns: ColumnInfo[];
}

export type DatabaseType = 'postgres' | 'mysql' | 'sqlite';

/** A secondary index; `name` must be unique across the database (PostgreSQL scopes index names per schema). */
export interface IndexSpec {
  name: string;
  table: string;
  columns: readonly string[];
}

/** A database login for untrusted readers: it may read, never write, and never see the hidden tables. */
export interface ReadOnlyLogin {
  user: string;
  password: string;
}

/**
 * TLS to a PostgreSQL or MySQL server: `off`, `require` (encrypted, the server certificate is not
 * checked), or `verify` (encrypted, the certificate must chain to a trusted CA; add a private CA
 * with NODE_EXTRA_CA_CERTS). SQLite ignores it.
 */
export type DatabaseSslMode = 'off' | 'require' | 'verify';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: DatabaseSslMode;
  /**
   * Cancels a statement that runs longer than this, in the database itself; 0 or unset means no
   * limit. PostgreSQL: every statement. MySQL: SELECTs only (max_execution_time). SQLite: none.
   */
  statementTimeoutMs?: number;
  /**
   * Refuse every write on this connection. SQLite: PRAGMA query_only. PostgreSQL:
   * default_transaction_read_only. MySQL: SET SESSION TRANSACTION READ ONLY.
   */
  readOnly?: boolean;
  /**
   * Receives errors that happen outside any query, such as a pooled connection the server closed.
   * The pool drops that connection and opens a new one when needed. Defaults to console.error.
   */
  onBackgroundError?: (error: Error) => void;
}

export interface DatabaseAdapter {
  /**
   * Connect to the database
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the database
   */
  disconnect(): Promise<void>;

  /**
   * Runs one statement, the same way in every dialect:
   * - `?` is the only placeholder. The adapter numbers it where the driver needs that (`$1` in
   *   PostgreSQL), never inside strings, quoted identifiers or comments. A `?` is always a
   *   placeholder, so PostgreSQL's `?` jsonb operators need their function forms (`jsonb_exists`).
   *   A bound `LIMIT ?` / `OFFSET ?` works everywhere.
   * - Integer and decimal results (COUNT, SUM, BIGINT, NUMERIC) come back as numbers when the
   *   number is exact, otherwise as their decimal text.
   * - DATE results come back as 'YYYY-MM-DD' text, never as a Date shifted by the local time zone.
   * - With `maxRows`, `sql` must be a single SELECT, and at most that many rows are produced.
   * - Errors name the dialect and keep the driver's error, with its code, as `cause`.
   */
  query<TRow = Row>(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult<TRow>>;

  /**
   * Get information about database tables and columns
   * @param schema Optional schema name (defaults to public/main schema)
   */
  getSchema(schema?: string): Promise<SchemaInfo>;

  /**
   * Get list of tables
   * @param schema Optional schema name
   */
  getTables(schema?: string): Promise<TableInfo[]>;

  /**
   * Get columns for a specific table
   * @param tableName Table name
   * @param schema Optional schema name
   */
  getColumns(tableName: string, schema?: string): Promise<ColumnInfo[]>;

  /**
   * Get the database type (postgres, mysql, sqlite)
   */
  getDatabaseType(): DatabaseType;

  /**
   * Creates the index if it does not exist yet; an existing index is left alone.
   */
  ensureIndex(index: IndexSpec): Promise<void>;

  /**
   * Creates `login` if it is missing, or resets its password, as a login that can read every
   * table in the database except `hiddenTables`, and write nothing. Idempotent; run it as the
   * database owner, after creating the hidden tables.
   * - PostgreSQL: tables in the `public` schema, including ones the owner creates later.
   * - MySQL: the tables that exist now; run it again after creating tables.
   * - SQLite has no logins and throws.
   * Throws for the adapter's own user, a name that is not a plain identifier, or a password
   * with quotes, backslashes or control characters.
   */
  ensureReadOnlyLogin(login: ReadOnlyLogin, hiddenTables: readonly string[]): Promise<void>;

  /**
   * Check if the connection is active
   */
  isConnected(): boolean;
}
