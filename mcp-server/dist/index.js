import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { initializeDatabaseAdapter, closeDatabaseAdapter } from '../../src/database/index.js';
async function main() {
    // Initialize database adapter from environment
    const database = await initializeDatabaseAdapter();
    const dbType = database.getDatabaseType();
    const server = new Server({
        name: "database-mcp-server",
        version: "1.0.0",
    }, {
        capabilities: {
            tools: {},
        },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "execute-sql-query",
                    description: "Execute a SQL query on the database",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The SQL query to execute",
                            },
                        },
                        required: ["query"],
                    },
                },
                {
                    name: "database-context",
                    description: "Get database context like schema information",
                    inputSchema: {
                        type: "object",
                        properties: {
                            type: {
                                type: "string",
                                enum: ["schema", "tables"],
                                description: "Type of context to get",
                            },
                        },
                        required: ["type"],
                    },
                },
            ],
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        if (name === "execute-sql-query") {
            const query = args?.query;
            try {
                const result = await database.query(query);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.rows),
                        },
                    ],
                };
            }
            catch (err) {
                const error = err;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
        else if (name === "database-context") {
            const type = args?.type;
            try {
                if (type === "schema") {
                    const schema = await database.getSchema();
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    database: dbType,
                                    tables: schema.tables,
                                    columns: schema.columns,
                                }),
                            },
                        ],
                    };
                }
                else if (type === "tables") {
                    const tables = await database.getTables();
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    database: dbType,
                                    tables,
                                }),
                            },
                        ],
                    };
                }
            }
            catch (err) {
                const error = err;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error.message}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
        return {
            content: [
                {
                    type: "text",
                    text: "Unknown tool",
                },
            ],
            isError: true,
        };
    });
    // Use stdio transport for this server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Database MCP Server running on stdio (${dbType})`);
}
main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
}).finally(async () => {
    // Cleanup on exit
    await closeDatabaseAdapter();
});
