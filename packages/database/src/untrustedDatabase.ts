import { isInternalTable } from './appTables';
import { clampRowLimit, validateReadOnlyQuery } from './readOnlyQuery';
import { type ColumnInfo, type DatabaseAdapter, type DatabaseType, type Row, type SchemaInfo, type TableInfo } from './types';

export interface ReadOnlyQueryResult {
  rows: Row[];
  rowCount: number;
  truncated: boolean;
}

/**
 * What untrusted (LLM- or MCP-client-authored) requests may see of a database: listings
 * without the app's internal tables, and read-only queries that cannot reach them.
 * There is deliberately no raw `query`.
 */
export interface UntrustedDatabase {
  getDatabaseType(): DatabaseType;
  isConnected(): boolean;
  getSchema(schema?: string): Promise<SchemaInfo>;
  getTables(schema?: string): Promise<TableInfo[]>;
  getColumns(tableName: string, schema?: string): Promise<ColumnInfo[]>;
  /**
   * Runs one read-only SELECT (or WITH ... SELECT), with `?` placeholders bound to `params` in
   * every dialect. Throws for anything else, including SQL that
   * names an internal table. Returns at most `limit` rows (default 100, capped at 1000), limited
   * in SQL so the rest are never produced; `truncated` says more rows matched.
   */
  readOnlyQuery(sql: string, params?: readonly unknown[], limit?: unknown): Promise<ReadOnlyQueryResult>;
}

/** The only path by which untrusted SQL reaches a database; the adapter stays with its owner. */
export function createUntrustedDatabase(adapter: DatabaseAdapter): UntrustedDatabase {
  return {
    getDatabaseType: () => adapter.getDatabaseType(),
    isConnected: () => adapter.isConnected(),
    async getSchema(schema) {
      const { tables, columns } = await adapter.getSchema(schema);
      return {
        tables: tables.filter((table) => !isInternalTable(table.tableName)),
        columns: columns.filter((column) => !isInternalTable(column.tableName)),
      };
    },
    async getTables(schema) {
      return (await adapter.getTables(schema)).filter((table) => !isInternalTable(table.tableName));
    },
    async getColumns(tableName, schema) {
      return isInternalTable(tableName) ? [] : adapter.getColumns(tableName, schema);
    },
    async readOnlyQuery(sql, params = [], limit) {
      const statement = validateReadOnlyQuery(sql);
      const rowLimit = clampRowLimit(limit);
      // One extra row reports truncation without loading the full result.
      const result = await adapter.query(statement, params, { maxRows: rowLimit + 1 });
      const rows = result.rows.slice(0, rowLimit);
      return { rows, rowCount: rows.length, truncated: result.rows.length > rowLimit };
    },
  };
}
