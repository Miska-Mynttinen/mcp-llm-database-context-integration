import express from "express";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { initializeDatabaseAdapter, closeDatabaseAdapter } from '../../src/database/index.js';

async function main() {
  // Initialize database adapter from environment
  const database = await initializeDatabaseAdapter();
  const dbType = database.getDatabaseType();

  const createServer = () => {
    const server = new Server(
    {
      name: "database-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

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
      const query = (args as any)?.query as string;
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
      } catch (err) {
        const error = err as Error;
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
    } else if (name === "database-context") {
      const type = (args as any)?.type as string;
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
        } else if (type === "tables") {
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
      } catch (err) {
        const error = err as Error;
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

    return server;
  };

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const app = express();
  app.use(express.json());

  app.all('/mcp', async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? transports.get(sessionId) : undefined;

    try {
      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport!);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) {
            transports.delete(transport.sessionId);
          }
        };
        await createServer().connect(transport);
      }

      if (!transport) {
        res.status(400).json({ error: 'Missing or invalid MCP session' });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  const port = Number(process.env.PORT || 3001);
  const httpServer = app.listen(port, () => {
    console.error(`Database MCP Server running on Streamable HTTP at http://localhost:${port}/mcp (${dbType})`);
  });

  const closeServer = async () => {
    httpServer.close();
    await Promise.all([...transports.values()].map((transport) => transport.close()));
    await closeDatabaseAdapter();
  };

  process.once('SIGINT', closeServer);
  process.once('SIGTERM', closeServer);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});