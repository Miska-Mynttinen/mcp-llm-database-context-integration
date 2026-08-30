import { DatabaseAdapter } from '../database/types';
import { ConversationStore } from '../chat/types';
import { ToolDefinition, ToolExecutionResult } from './types';

export function validateReadOnlyQuery(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('SQL statement is empty');
  }

  if (trimmed.includes(';') && trimmed.slice(trimmed.indexOf(';') + 1).trim().length > 0) {
    throw new Error('Only a single SQL statement is allowed');
  }

  if (/--|\/\*|\*\//i.test(trimmed)) {
    throw new Error('SQL comments are not allowed');
  }

  const normalized = trimmed.replace(/\s+/g, ' ');
  if (!/^(WITH\s+.*\s+SELECT\b|SELECT\b)/i.test(normalized)) {
    throw new Error('Only SELECT queries are allowed');
  }

  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|CALL|MERGE|REPLACE|ATTACH|DETACH|PRAGMA)\b/i.test(normalized)) {
    throw new Error('Only read-only SELECT queries are allowed');
  }

  return normalized;
}

export function buildSchemaPayload(databaseAdapter: DatabaseAdapter): Promise<any> {
  return (async () => {
    const schema = await databaseAdapter.getSchema();
    const tableList = await databaseAdapter.getTables();

    return {
      tables: tableList.map((table) => ({
        name: table.tableName,
        schema: table.tableSchema,
        type: table.tableType,
      })),
      columns: schema.columns.map((column) => ({
        tableName: column.tableName,
        tableSchema: column.tableSchema,
        columnName: column.columnName,
        dataType: column.dataType,
        isNullable: column.isNullable,
      })),
    };
  })();
}

export function createDatabaseToolRegistry(databaseAdapter: DatabaseAdapter, conversationStore?: ConversationStore) {
  const definitions: ToolDefinition[] = [
    {
      name: 'get_database_schema',
      description: 'Retrieve database schema metadata for tables and columns.',
      inputSchema: {
        type: 'object',
        properties: { tableName: { type: 'string' } },
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List the available tables in the configured database.',
      inputSchema: {
        type: 'object',
        properties: { schema: { type: 'string' } },
        additionalProperties: false,
      },
    },
    {
      name: 'get_table_columns',
      description: 'Fetch column definitions for a specific database table.',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: { type: 'string' },
          schema: { type: 'string' },
        },
        required: ['tableName'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_conversation_history',
      description: 'Retrieve recent chat messages for the active session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_readonly_query',
      description: 'Execute a read-only SQL query with validation and result limits.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          params: { type: 'array' },
          limit: { type: 'number' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
  ];

  const execute = async (name: string, args: Record<string, any>): Promise<any> => {
    switch (name) {
      case 'get_database_schema': {
        const tableName = args.tableName as string | undefined;
        const schema = await databaseAdapter.getSchema();
        if (tableName) {
          return {
            tableName,
            columns: schema.columns.filter((column) => column.tableName === tableName),
          };
        }
        return await buildSchemaPayload(databaseAdapter);
      }
      case 'list_tables': {
        const tables = await databaseAdapter.getTables(args.schema as string | undefined);
        return { tables };
      }
      case 'get_table_columns': {
        const tableName = String(args.tableName);
        const columns = await databaseAdapter.getColumns(tableName, args.schema as string | undefined);
        return { tableName, columns };
      }
      case 'get_conversation_history': {
        if (!conversationStore) {
          throw new Error('Conversation store is unavailable');
        }
        const sessionId = String(args.sessionId || 'default');
        const limit = Number(args.limit ?? 20);
        return {
          sessionId,
          messages: await conversationStore.getRecentMessages(sessionId, limit),
        };
      }
      case 'execute_readonly_query': {
        const sql = validateReadOnlyQuery(String(args.sql));
        const params = Array.isArray(args.params) ? args.params : [];
        const limit = Number(args.limit ?? 100);
        const result = await databaseAdapter.query(sql, params);
        const rows = (result.rows || []).slice(0, limit);
        return {
          rows,
          rowCount: rows.length,
          totalRowCount: result.rowCount,
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  return {
    definitions,
    execute,
  };
}

export function createToolExecutionResult(name: string, result: any, error?: string): ToolExecutionResult {
  return {
    ok: !error,
    name,
    result,
    error,
  };
}
