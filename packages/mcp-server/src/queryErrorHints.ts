import { type UntrustedDatabase } from '@mcp-llm/database';

/** Driver messages for a missing column: PostgreSQL, MySQL, SQLite. */
const UNKNOWN_COLUMN = /column .* does not exist|unknown column|no such column/i;
/** Driver messages for a missing table: PostgreSQL, SQLite, MySQL. */
const UNKNOWN_TABLE = /relation .* does not exist|no such table|table .* doesn't exist/i;
const MAX_HINT_TABLES = 5;
const HINT_FOOTER = 'Use only these names, or call get_table_columns.';

/**
 * Adds the real schema to a failed query's error when it names a column or table that does not
 * exist, so the model can correct its SQL. Other errors, and failed lookups, come back unchanged.
 */
export async function withSchemaHint(database: UntrustedDatabase, sql: string, error: unknown): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error));
  try {
    const hint = await schemaHint(database, sql, original.message);
    return hint ? Object.assign(new Error(`${original.message}\n${hint}\n${HINT_FOOTER}`), { cause: original }) : original;
  } catch {
    return original;
  }
}

async function schemaHint(database: UntrustedDatabase, sql: string, message: string): Promise<string | undefined> {
  const unknownColumn = UNKNOWN_COLUMN.test(message);
  if (!unknownColumn && !UNKNOWN_TABLE.test(message)) {
    return undefined;
  }
  const tableNames = await visibleTableNames(database);
  const referenced = unknownColumn ? tablesNamedIn(sql, tableNames).slice(0, MAX_HINT_TABLES) : [];
  if (referenced.length === 0) {
    return availableTablesLine(tableNames);
  }
  const lines = await Promise.all(referenced.map(async (tableName) => {
    const columns = await database.getColumns(tableName);
    return `Columns of ${tableName}: ${columns.map((column) => column.columnName).join(', ')}`;
  }));
  return lines.join('\n');
}

/**
 * The error for a table that has no readable columns: it does not exist or is one of the app's own
 * tables, which get the same message so the model cannot tell them apart.
 */
export async function tableNotFoundError(database: UntrustedDatabase, tableName: string): Promise<Error> {
  return new Error(`Table "${tableName}" not found. ${availableTablesLine(await visibleTableNames(database))}`);
}

async function visibleTableNames(database: UntrustedDatabase): Promise<string[]> {
  return (await database.getTables()).map((table) => table.tableName);
}

function availableTablesLine(tableNames: readonly string[]): string {
  return `Available tables: ${tableNames.join(', ')}`;
}

/** The table names that appear as whole words in the SQL, ignoring case. */
function tablesNamedIn(sql: string, tableNames: readonly string[]): string[] {
  const words = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []);
  return tableNames.filter((tableName) => words.has(tableName.toLowerCase()));
}
