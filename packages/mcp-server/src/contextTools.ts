import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, type UntrustedDatabase } from '@mcp-llm/database';
import { tableNotFoundError, withSchemaHint } from './queryErrorHints';

/** A tool an LLM may call; `inputSchema` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The database context tools this MCP server serves; the chat app gets them only over MCP.
 * `execute` validates arguments and throws for unknown tools, invalid arguments and
 * database errors; results are plain JSON-serialisable data.
 */
export interface DatabaseContextTools {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

type ToolHandler = (database: UntrustedDatabase, args: Record<string, unknown>) => Promise<unknown>;

const HANDLERS: Readonly<Record<string, ToolHandler>> = {
  get_database_schema: (database, args) => schemaPayload(database, optionalString(args, 'tableName')),
  list_tables: async (database, args) => ({ tables: await database.getTables(optionalString(args, 'schema')) }),
  get_table_columns: async (database, args) => {
    const tableName = requireString(args, 'tableName');
    return { tableName, columns: await existingColumns(database, tableName, optionalString(args, 'schema')) };
  },
  execute_readonly_query: async (database, args) => {
    const sql = requireString(args, 'sql');
    try {
      return await database.readOnlyQuery(sql, optionalArray(args, 'params'), optionalNumber(args, 'limit'));
    } catch (error) {
      throw await withSchemaHint(database, sql, error);
    }
  },
};

export function createDatabaseContextTools(database: UntrustedDatabase): DatabaseContextTools {
  return {
    definitions: definitionsFor(database),
    async execute(name, args) {
      const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : undefined;
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return handler(database, args);
    },
  };
}

function definitionsFor(database: UntrustedDatabase): ToolDefinition[] {
  const type = database.getDatabaseType();
  return [
    {
      name: 'get_database_schema',
      description: `Retrieve ${type} database schema metadata for tables and columns, optionally for one table.`,
      inputSchema: objectSchema({ tableName: { type: 'string' } }),
    },
    {
      name: 'list_tables',
      description: `List the available tables in the ${type} database.`,
      inputSchema: objectSchema({ schema: { type: 'string' } }),
    },
    {
      name: 'get_table_columns',
      description: `Fetch column definitions for a specific ${type} database table.`,
      inputSchema: objectSchema({ tableName: { type: 'string' }, schema: { type: 'string' } }, ['tableName']),
    },
    {
      name: 'execute_readonly_query',
      description:
        `Execute a single read-only SELECT (or WITH ... SELECT) query on the ${type} database. `
        + 'Bind values with ? placeholders and the params array. Returns {rows, rowCount, truncated}: '
        + `${DEFAULT_ROW_LIMIT} rows by default, at most ${MAX_ROW_LIMIT}; truncated is true when more rows matched.`,
      inputSchema: objectSchema({
        sql: { type: 'string' },
        params: { type: 'array' },
        limit: { type: 'number', description: `Maximum rows (default ${DEFAULT_ROW_LIMIT}, capped at ${MAX_ROW_LIMIT})` },
      }, ['sql']),
    },
  ];
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

async function schemaPayload(database: UntrustedDatabase, tableName: string | undefined) {
  const schema = await database.getSchema();
  if (tableName) {
    const columns = schema.columns.filter((column) => column.tableName === tableName);
    if (columns.length === 0) {
      throw await tableNotFoundError(database, tableName);
    }
    return { tableName, columns };
  }
  return {
    tables: schema.tables.map((entry) => ({ name: entry.tableName, schema: entry.tableSchema, type: entry.tableType })),
    columns: schema.columns.map((column) => ({
      tableName: column.tableName,
      tableSchema: column.tableSchema,
      columnName: column.columnName,
      dataType: column.dataType,
      isNullable: column.isNullable,
    })),
  };
}

/** A table's columns; an empty list means no such (visible) table, which is reported as an error. */
async function existingColumns(database: UntrustedDatabase, tableName: string, schema: string | undefined) {
  const columns = await database.getColumns(tableName, schema);
  if (columns.length === 0) {
    throw await tableNotFoundError(database, tableName);
  }
  return columns;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = optionalString(args, field);
  if (value === undefined) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalArray(args: Record<string, unknown>, field: string): unknown[] {
  const value = args[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}
