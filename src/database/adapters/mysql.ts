import mysql from 'mysql2/promise';
import {
  DatabaseAdapter,
  DatabaseConfig,
  QueryResult,
  ColumnInfo,
  TableInfo,
  SchemaInfo,
} from '../types';

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

  async query(queryString: string, params?: any[]): Promise<QueryResult> {
    const connection = await this.pool.getConnection();
    try {
      const [rows, fields] = await connection.execute(queryString, params);
      return {
        rows: Array.isArray(rows) ? rows : [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
      };
    } catch (error) {
      throw new Error(`MySQL query error: ${error instanceof Error ? error.message : String(error)}`);
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
    const result = await this.query(query, [database]);
    return result.rows;
  }

  async getColumns(tableName?: string, schema: string = ''): Promise<ColumnInfo[]> {
    const database = schema || this.config.database;
    let query = `
      SELECT 
        column_name as columnName,
        column_type as dataType,
        is_nullable = 'YES' as isNullable,
        column_default as columnDefault,
        character_maximum_length as characterMaximumLength,
        table_name as tableName,
        table_schema as tableSchema
      FROM information_schema.columns
      WHERE table_schema = ?
    `;
    const params: any[] = [database];

    if (tableName && tableName !== '') {
      query += ` AND table_name = ?`;
      params.push(tableName);
    }

    query += ` ORDER BY table_name, ordinal_position`;

    const result = await this.query(query, params);
    return result.rows;
  }

  getDatabaseType(): string {
    return 'mysql';
  }

  isConnected(): boolean {
    return this.connected;
  }
}
