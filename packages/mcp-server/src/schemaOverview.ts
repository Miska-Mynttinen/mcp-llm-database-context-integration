import { type UntrustedDatabase } from '@mcp-llm/database';

export const SCHEMA_OVERVIEW_URI = 'database://schema/overview';
/** Longest overview with columns; a bigger schema is described by table names only. */
export const MAX_OVERVIEW_CHARS = 6000;

/** The MCP resource the chat app puts in the model's system prompt, so it can write SQL without lookups. */
export const SCHEMA_OVERVIEW_RESOURCE = {
  uri: SCHEMA_OVERVIEW_URI,
  name: 'database_schema_overview',
  description: 'Every table the database tools can read, with its columns and their types.',
  mimeType: 'text/plain',
};

/**
 * One line per table, `table(column type, ...)`, from the untrusted view so the app's own tables
 * stay hidden. Falls back to table names alone when the full overview exceeds `MAX_OVERVIEW_CHARS`.
 */
export async function readSchemaOverview(database: UntrustedDatabase): Promise<string> {
  const { tables, columns } = await database.getSchema();
  const type = database.getDatabaseType();
  if (tables.length === 0) {
    return `Database schema (${type}): no tables.`;
  }

  const lines = tables.map((table) => {
    const tableColumns = columns
      .filter((column) => column.tableName === table.tableName)
      .map((column) => `${column.columnName} ${column.dataType}`);
    return `- ${table.tableName}(${tableColumns.join(', ')})`;
  });
  const overview = [`Database schema (${type}), table(column type, ...):`, ...lines].join('\n');
  if (overview.length <= MAX_OVERVIEW_CHARS) {
    return overview;
  }
  const names = tables.map((table) => table.tableName).join(', ');
  return `Database tables (${type}): ${names}\nCall get_table_columns for a table's columns before querying it.`;
}
