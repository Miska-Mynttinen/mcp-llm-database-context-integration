import { Pool, Client } from 'pg';
import {
  DatabaseAdapter,
  DatabaseConfig,
  QueryResult,
  ColumnInfo,
  TableInfo,
  SchemaInfo,
} from '../types';

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
    });
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

  async query(queryString: string, params?: any[]): Promise<QueryResult> {
    try {
      const result = await this.pool.query(queryString, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
        command: result.command,
      };
    } catch (error) {
      throw new Error(`PostgreSQL query error: ${error instanceof Error ? error.message : String(error)}`);
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
      WHERE table_schema = $1
      ORDER BY table_name
    `;
    const result = await this.pool.query(query, [schema]);
    return result.rows;
  }

  async getColumns(tableName?: string, schema: string = 'public'): Promise<ColumnInfo[]> {
    let query = `
      SELECT 
        column_name as "columnName",
        data_type as "dataType",
        is_nullable = 'YES' as "isNullable",
        column_default as "columnDefault",
        character_maximum_length as "characterMaximumLength",
        table_name as "tableName",
        table_schema as "tableSchema"
      FROM information_schema.columns
      WHERE table_schema = $1
    `;
    const params: any[] = [schema];

    if (tableName && tableName !== '') {
      query += ` AND table_name = $2`;
      params.push(tableName);
    }

    query += ` ORDER BY table_name, ordinal_position`;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  getDatabaseType(): string {
    return 'postgres';
  }

  isConnected(): boolean {
    return this.connected;
  }
}
