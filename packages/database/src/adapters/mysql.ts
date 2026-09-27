import mysql from 'mysql2/promise';
import {
  type DatabaseAdapter,
  type DatabaseConfig,
  type QueryOptions,
  type QueryResult,
  type Row,
  type ColumnInfo,
  type TableInfo,
  type SchemaInfo,
  type DatabaseType,
  type IndexSpec,
  type ReadOnlyLogin,
} from '../types';
import {
  backgroundErrorHandler,
  type InformationSchemaColumnRow,
  limitBySubquery,
  queryError,
  requireReadOnlyLogin,
  requireRowLimit,
  tlsOptions,
  toColumnInfo,
  toNumberIfExact,
} from './sqlShared';
import { blankQuotedText, hasTopLevelKeyword, MYSQL_TEXT, placeholderIndexes } from './sqlText';

// mysql2 does not export its bind-value type; take it from `execute`.
type MysqlExecuteValues = Parameters<mysql.PoolConnection['execute']>[1];

/** The callback API of the connection mysql2's pool passes to 'connection' listeners. */
interface CallbackConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
}

// Driver error code for CREATE INDEX on a name that already exists.
const DUPLICATE_KEY_NAME = 'ER_DUP_KEYNAME';

// Column types the pool returns as decimal text (supportBigNumbers + bigNumberStrings), to read as exact numbers.
const EXACT_NUMBER_COLUMN_TYPES: ReadonlySet<number> = new Set([mysql.Types.LONGLONG, mysql.Types.DECIMAL, mysql.Types.NEWDECIMAL]);

// Code before a `?` that binds a row count: `LIMIT ?`, `OFFSET ?`, or the first of `LIMIT ?, ?`.
const ROW_COUNT_CONTEXT = /\b(?:LIMIT|OFFSET)\s*$|\bLIMIT\s*\?\s*,\s*$/i;

/**
 * Prepared statements reject a JavaScript number bound to LIMIT or OFFSET
 * ("Incorrect arguments to mysqld_stmt_execute") but accept its decimal text.
 */
function bindRowCountsAsText(sql: string, params: readonly unknown[]): unknown[] {
  const code = blankQuotedText(sql, MYSQL_TEXT);
  const indexes = placeholderIndexes(sql, MYSQL_TEXT);
  return params.map((value, position) => {
    const index = indexes[position];
    const bindsRowCount = index !== undefined && ROW_COUNT_CONTEXT.test(code.slice(0, index));
    return bindsRowCount && typeof value === 'number' ? String(value) : value;
  });
}

function toExactNumbers<TRow>(rows: Row[], fields: readonly mysql.FieldPacket[]): TRow[] {
  const numeric = fields.filter((field) => EXACT_NUMBER_COLUMN_TYPES.has(field.columnType ?? -1)).map((field) => field.name);
  if (numeric.length === 0) {
    return rows as TRow[];
  }
  return rows.map((row) => {
    const converted = numeric.map((name) => [name, typeof row[name] === 'string' ? toNumberIfExact(row[name]) : row[name]]);
    return { ...row, ...Object.fromEntries(converted) } as TRow;
  });
}

export class MySQLAdapter implements DatabaseAdapter {
  private pool: mysql.Pool;
  private connected: boolean = false;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // A DATE stays its 'YYYY-MM-DD' text rather than a Date at local midnight, as in the other adapters.
      dateStrings: ['DATE'],
      ssl: tlsOptions(config.ssl),
    });
    // mysql2 drops a pooled connection the server closed by itself; the pool emits no 'error'.
    const sessionStatements = sessionSettings(config);
    if (sessionStatements.length > 0) {
      this.runOnNewConnections(sessionStatements, backgroundErrorHandler(config, 'MySQL'));
    }
  }

  /**
   * Queues `statements` on each new connection ahead of any query, so no query runs without them.
   */
  private runOnNewConnections(statements: readonly string[], onError: (error: Error) => void): void {
    // The event passes the driver's callback connection, not the promise wrapper its typings name.
    this.pool.on('connection', (connection) => {
      for (const sql of statements) {
        (connection as unknown as CallbackConnection).query(sql, (error) => {
          if (error) {
            onError(queryError('MySQL', error));
          }
        });
      }
    });
  }

  async connect(): Promise<void> {
    try {
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();
      this.connected = true;
    } catch (error) {
      this.connected = false;
      throw new Error(`Failed to connect to MySQL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.connected = false;
    }
  }

  async query<TRow = Row>(sql: string, params: readonly unknown[] = [], options: QueryOptions = {}): Promise<QueryResult<TRow>> {
    const statement = options.maxRows === undefined ? sql : limitRows(sql, options.maxRows);
    const connection = await this.pool.getConnection();
    try {
      const [rows, fields] = await connection.execute(statement, bindRowCountsAsText(statement, params) as MysqlExecuteValues);
      if (Array.isArray(rows)) {
        return { rows: toExactNumbers<TRow>(rows as Row[], fields ?? []), rowCount: rows.length };
      }
      // INSERT/UPDATE/DELETE return a result header; mysql2's default FOUND_ROWS flag counts matched rows.
      return { rows: [], rowCount: (rows as mysql.ResultSetHeader).affectedRows ?? 0 };
    } catch (error) {
      throw queryError('MySQL', error);
    } finally {
      connection.release();
    }
  }

  async getSchema(schema: string = ''): Promise<SchemaInfo> {
    const tables = await this.getTables(schema);
    const columns = await this.getColumns('', schema);
    return { tables, columns };
  }

  async getTables(schema: string = ''): Promise<TableInfo[]> {
    const database = schema || this.config.database;
    const query = `
      SELECT 
        table_name as tableName,
        table_schema as tableSchema,
        table_type as tableType
      FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY table_name
    `;
    const result = await this.query<TableInfo>(query, [database]);
    return result.rows;
  }

  async getColumns(tableName?: string, schema: string = ''): Promise<ColumnInfo[]> {
    const database = schema || this.config.database;
    let query = `
      SELECT 
        column_name as columnName,
        column_type as dataType,
        is_nullable as isNullable,
        column_default as columnDefault,
        character_maximum_length as characterMaximumLength,
        table_name as tableName,
        table_schema as tableSchema
      FROM information_schema.columns
      WHERE table_schema = ?
    `;
    const params: string[] = [database];

    if (tableName && tableName !== '') {
      query += ` AND table_name = ?`;
      params.push(tableName);
    }

    query += ` ORDER BY table_name, ordinal_position`;

    const result = await this.query<InformationSchemaColumnRow>(query, params);
    return result.rows.map(toColumnInfo);
  }

  getDatabaseType(): DatabaseType {
    return 'mysql';
  }

  /** MySQL has no `CREATE INDEX IF NOT EXISTS`, so an existing index is recognised by its driver error code. */
  async ensureIndex(index: IndexSpec): Promise<void> {
    try {
      await this.query(`CREATE INDEX ${index.name} ON ${index.table} (${index.columns.join(', ')})`);
    } catch (error) {
      if ((error as { cause?: { code?: unknown } }).cause?.code !== DUPLICATE_KEY_NAME) {
        throw error;
      }
    }
  }

  /**
   * MySQL privileges only add up (a database-wide SELECT can't exclude a table), so SELECT is
   * granted table by table, on every table but the hidden ones, after revoking everything else.
   * SHOW VIEW on the database lets the login connect to it before it has any table to read;
   * without SELECT on a view it shows nothing.
   */
  async ensureReadOnlyLogin(login: ReadOnlyLogin, hiddenTables: readonly string[]): Promise<void> {
    const { user, password } = requireReadOnlyLogin(login, this.config.user);
    const account = `'${user}'@'%'`;
    const database = quoteName(this.config.database);
    await this.runAccountStatement(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY '${password}'`);
    await this.runAccountStatement(`ALTER USER ${account} IDENTIFIED BY '${password}'`);
    await this.runAccountStatement(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`);
    await this.runAccountStatement(`GRANT SHOW VIEW ON ${database}.* TO ${account}`);
    const hidden = new Set(hiddenTables.map((table) => table.toLowerCase()));
    for (const table of await this.getTables()) {
      if (!hidden.has(table.tableName.toLowerCase())) {
        await this.runAccountStatement(`GRANT SELECT ON ${database}.${quoteName(table.tableName)} TO ${account}`);
      }
    }
  }

  /**
   * Runs a statement without parameters over the text protocol. Re-running a prepared
   * `ALTER USER ... IDENTIFIED BY` (mysql2 caches prepared statements per connection) leaves a
   * password the login can no longer authenticate with.
   */
  private async runAccountStatement(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (error) {
      throw queryError('MySQL', error);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Session settings for each new connection:
 * - max_execution_time makes the server cancel SELECTs, the only statements untrusted callers run.
 * - READ ONLY makes the server refuse writes, whatever the login may do.
 */
function sessionSettings(config: DatabaseConfig): string[] {
  const statements: string[] = [];
  const timeoutMs = config.statementTimeoutMs;
  if (timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error(`statementTimeoutMs must be a non-negative integer, got ${timeoutMs}`);
    }
    statements.push(`SET SESSION max_execution_time = ${timeoutMs}`);
  }
  if (config.readOnly) {
    statements.push('SET SESSION TRANSACTION READ ONLY');
  }
  return statements;
}

/**
 * MySQL rejects a derived table with duplicate column names (a join selecting `a.id, b.id`),
 * so a statement without a LIMIT of its own (subqueries and strings aside) gets one appended
 * instead of being wrapped.
 */
function limitRows(statement: string, maxRows: number): string {
  return hasTopLevelKeyword(statement, 'LIMIT', MYSQL_TEXT)
    ? limitBySubquery(statement, maxRows)
    : `${statement} LIMIT ${requireRowLimit(maxRows)}`;
}

function quoteName(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}
