import sqlite3 from 'sqlite3';
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
import { createIndexIfNotExistsSql, limitBySubquery, queryError } from './sqlShared';

// How long a statement waits for another process's lock on the file before failing with SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000;

/** Statements whose rows `query` returns; `db.run` would discard them (e.g. PRAGMA table_info). */
const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i;

// One query for every table's columns, instead of one PRAGMA per table.
const ALL_COLUMNS_QUERY = `
  SELECT
    m.name AS tableName,
    p.name AS columnName,
    p.type AS dataType,
    p."notnull" AS "notNull",
    p.dflt_value AS columnDefault
  FROM sqlite_master m
  JOIN pragma_table_info(m.name) p
  WHERE m.type = 'table'
    AND m.name NOT LIKE 'sqlite_%'
  ORDER BY m.name, p.cid
`;

export class SQLiteAdapter implements DatabaseAdapter {
  private db: sqlite3.Database | null = null;
  private connected: boolean = false;
  private config: DatabaseConfig;
  private dbPath: string;

  constructor(config: DatabaseConfig) {
    this.config = config;
    // For SQLite, use the database name as the file path
    this.dbPath = config.database;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          this.connected = false;
          reject(new Error(`Failed to connect to SQLite: ${err.message}`));
        } else {
          this.connected = true;
          resolve();
        }
      });
    });
    try {
      await this.configureConnection();
    } catch (error) {
      await this.disconnect();
      throw new Error(`Failed to configure SQLite: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The app and the MCP server open the same file from two processes. A busy timeout makes one
   * wait for the other's lock instead of failing with SQLITE_BUSY, and WAL lets readers run
   * while the app writes. A read-only connection leaves the journal mode to the writer.
   */
  private async configureConnection(): Promise<void> {
    this.db!.configure('busyTimeout', BUSY_TIMEOUT_MS);
    if (this.config.readOnly) {
      await this.query('PRAGMA query_only = ON');
    } else {
      await this.query('PRAGMA journal_mode = WAL');
    }
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.connected = false;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  async query<TRow = Row>(sql: string, params: readonly unknown[] = [], options: QueryOptions = {}): Promise<QueryResult<TRow>> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const statement = options.maxRows === undefined ? sql : limitBySubquery(sql, options.maxRows);
    const values = [...params];

    return new Promise((resolve, reject) => {
      if (RETURNS_ROWS.test(statement)) {
        this.db!.all(statement, values, (err: Error | null, rows: TRow[]) => {
          if (err) {
            reject(queryError('SQLite', err));
          } else {
            resolve({
              rows: rows || [],
              rowCount: rows?.length || 0,
            });
          }
        });
      } else {
        this.db!.run(statement, values, function (err: Error | null) {
          if (err) {
            reject(queryError('SQLite', err));
          } else {
            resolve({
              rows: [],
              rowCount: this.changes || 0,
            });
          }
        });
      }
    });
  }

  async getSchema(_schema?: string): Promise<SchemaInfo> {
    const tables = await this.getTables();
    const columns = await this.getColumns();
    return { tables, columns };
  }

  async getTables(_schema?: string): Promise<TableInfo[]> {
    const query = `
      SELECT 
        name as tableName,
        'main' as tableSchema,
        'BASE TABLE' as tableType
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;
    const result = await this.query<TableInfo>(query);
    return result.rows;
  }

  async getColumns(tableName?: string, _schema?: string): Promise<ColumnInfo[]> {
    if (tableName && tableName !== '') {
      const escapedTableName = tableName.replace(/'/g, "''");
      const query = `PRAGMA table_info('${escapedTableName}')`;
      const result = await this.query<SqlitePragmaColumnRow>(query);
      return result.rows.map((row) => toColumnInfo({
        tableName,
        columnName: row.name,
        dataType: row.type,
        notNull: row.notnull,
        columnDefault: row.dflt_value,
      }));
    }
    const result = await this.query<SqliteColumnRow>(ALL_COLUMNS_QUERY);
    return result.rows.map(toColumnInfo);
  }

  getDatabaseType(): DatabaseType {
    return 'sqlite';
  }

  async ensureIndex(index: IndexSpec): Promise<void> {
    await this.query(createIndexIfNotExistsSql(index));
  }

  async ensureReadOnlyLogin(_login: ReadOnlyLogin, _hiddenTables: readonly string[]): Promise<void> {
    throw new Error('SQLite has no database logins; a read-only login needs PostgreSQL or MySQL');
  }

  isConnected(): boolean {
    return this.connected && this.db !== null;
  }
}

/** A row of `PRAGMA table_info(...)`. */
interface SqlitePragmaColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

interface SqliteColumnRow {
  tableName: string;
  columnName: string;
  dataType: string;
  notNull: number;
  columnDefault: string | null;
}

function toColumnInfo(row: SqliteColumnRow): ColumnInfo {
  return {
    columnName: row.columnName,
    dataType: row.dataType,
    isNullable: !row.notNull,
    columnDefault: row.columnDefault || undefined,
    tableName: row.tableName,
    tableSchema: 'main',
  };
}
