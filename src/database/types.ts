/**
 * Database abstraction layer - defines interface for all database adapters
 */

export interface QueryResult {
  rows: any[];
  rowCount: number;
  command?: string;
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

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
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
   * Execute a query
   * @param query SQL query string
   * @param params Optional parameterized query parameters
   */
  query(query: string, params?: any[]): Promise<QueryResult>;

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
  getDatabaseType(): string;

  /**
   * Check if the connection is active
   */
  isConnected(): boolean;
}
