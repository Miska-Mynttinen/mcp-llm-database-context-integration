import { Pool, types, type CustomTypesConfig } from 'pg';
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
  createIndexIfNotExistsSql,
  type InformationSchemaColumnRow,
  limitBySubquery,
  queryError,
  requireReadOnlyLogin,
  tlsOptions,
  toColumnInfo,
  toNumberIfExact,
} from './sqlShared';
import { placeholderIndexes, POSTGRES_TEXT } from './sqlText';

// node-postgres returns BIGINT (COUNT, SUM of integers) and NUMERIC as text; read them as exact numbers.
const EXACT_NUMBER_TYPES: ReadonlySet<number> = new Set([types.builtins.INT8, types.builtins.NUMERIC]);
// A DATE stays its 'YYYY-MM-DD' text: node-postgres would make it a Date at local midnight,
// which serializes as the previous day anywhere east of UTC.
const keepText = (text: string): string => text;
const TYPE_PARSERS: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (format === 'binary') {
      return types.getTypeParser(oid, format);
    }
    if (EXACT_NUMBER_TYPES.has(oid)) {
      return toNumberIfExact;
    }
    return oid === types.builtins.DATE ? keepText : types.getTypeParser(oid, format);
  }) as CustomTypesConfig['getTypeParser'],
};

const PUBLIC_SCHEMA = 'public';

/** Numbers each `?` placeholder as PostgreSQL's `$1, $2…`. */
function toNumberedPlaceholders(sql: string): string {
  const indexes = placeholderIndexes(sql, POSTGRES_TEXT);
  if (indexes.length === 0) {
    return sql;
  }
  const pieces = indexes.map((index, position) => {
    const start = position === 0 ? 0 : indexes[position - 1] + 1;
    return `${sql.slice(start, index)}$${position + 1}`;
  });
  return pieces.join('') + sql.slice(indexes[indexes.length - 1] + 1);
}

export class PostgreSQLAdapter implements DatabaseAdapter {
  private pool: Pool;
  private connected: boolean = false;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      types: TYPE_PARSERS,
      ssl: tlsOptions(config.ssl),
      // The server cancels the statement; the connection stays usable.
      statement_timeout: config.statementTimeoutMs || undefined,
      // Every transaction starts read-only, so the server refuses writes whatever the login may do.
      options: config.readOnly ? '-c default_transaction_read_only=on' : undefined,
    });
    // An idle client the server closed (a restart, a failover) is reported here. Without a listener,
    // Node treats it as an unhandled 'error' event and exits; the pool itself replaces the client.
    this.pool.on('error', backgroundErrorHandler(config, 'PostgreSQL'));
  }

  async connect(): Promise<void> {
    try {
      // Test connection by running a simple query
      const client = await this.pool.connect();
      client.release();
      this.connected = true;
    } catch (error) {
      this.connected = false;
      throw new Error(`Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.connected = false;
    }
  }

  async query<TRow = Row>(sql: string, params: readonly unknown[] = [], options: QueryOptions = {}): Promise<QueryResult<TRow>> {
    const statement = options.maxRows === undefined ? sql : limitBySubquery(sql, options.maxRows);
    try {
      const result = await this.pool.query(toNumberedPlaceholders(statement), [...params]);
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount || 0,
        command: result.command,
      };
    } catch (error) {
      throw queryError('PostgreSQL', error);
    }
  }

  async getSchema(schema: string = 'public'): Promise<SchemaInfo> {
    const tables = await this.getTables(schema);
    const columns = await this.getColumns('', schema);
    return { tables, columns };
  }

  async getTables(schema: string = 'public'): Promise<TableInfo[]> {
    const query = `
      SELECT 
        table_name as "tableName",
        table_schema as "tableSchema",
        table_type as "tableType"
      FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY table_name
    `;
    const result = await this.query<TableInfo>(query, [schema]);
    return result.rows;
  }

  async getColumns(tableName?: string, schema: string = 'public'): Promise<ColumnInfo[]> {
    let query = `
      SELECT 
        column_name as "columnName",
        data_type as "dataType",
        is_nullable as "isNullable",
        column_default as "columnDefault",
        character_maximum_length as "characterMaximumLength",
        table_name as "tableName",
        table_schema as "tableSchema"
      FROM information_schema.columns
      WHERE table_schema = ?
    `;
    const params: string[] = [schema];

    if (tableName && tableName !== '') {
      query += ` AND table_name = ?`;
      params.push(tableName);
    }

    query += ` ORDER BY table_name, ordinal_position`;

    const result = await this.query<InformationSchemaColumnRow>(query, params);
    return result.rows.map(toColumnInfo);
  }

  getDatabaseType(): DatabaseType {
    return 'postgres';
  }

  async ensureIndex(index: IndexSpec): Promise<void> {
    await this.query(createIndexIfNotExistsSql(index));
  }

  /**
   * SELECT on every table in `public`, now and (by default privileges) whenever the owner creates
   * one, then revoked on the hidden tables. Revoking also hides their rows in `pg_stats`.
   */
  async ensureReadOnlyLogin(login: ReadOnlyLogin, hiddenTables: readonly string[]): Promise<void> {
    const { user, password } = requireReadOnlyLogin(login, this.config.user);
    const role = `"${user}"`;
    const { rows } = await this.query('SELECT 1 FROM pg_roles WHERE rolname = ?', [user]);
    if (rows.length === 0) {
      await this.query(`CREATE ROLE ${role} LOGIN`);
    }
    await this.query(
      `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
    await this.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
    await this.query(`GRANT USAGE ON SCHEMA ${PUBLIC_SCHEMA} TO ${role}`);
    await this.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${PUBLIC_SCHEMA} TO ${role}`);
    await this.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${PUBLIC_SCHEMA} GRANT SELECT ON TABLES TO ${role}`);
    const hidden = new Set(hiddenTables.map((table) => table.toLowerCase()));
    const existingHidden = (await this.getTables(PUBLIC_SCHEMA)).filter((table) => hidden.has(table.tableName.toLowerCase()));
    if (existingHidden.length > 0) {
      await this.query(`REVOKE ALL ON ${existingHidden.map((table) => `"${table.tableName}"`).join(', ')} FROM ${role}`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
