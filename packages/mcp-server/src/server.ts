import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { type UntrustedDatabase } from '@mcp-llm/database';
import { createDatabaseContextTools } from './contextTools';
import { readSchemaOverview, SCHEMA_OVERVIEW_RESOURCE } from './schemaOverview';
import type { McpServerMetrics } from './metrics';

const SERVER_INFO = { name: "database-mcp-server", version: "1.0.0" };
// Metric label for calls naming a tool that doesn't exist, so client input never becomes a series.
const UNKNOWN_TOOL_LABEL = 'unknown';

const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** The bare message: `isError` marks it, so the model reads the same text as from the in-process tools. */
function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

type ToolRunner = (tool: string, run: () => Promise<unknown>) => Promise<CallToolResult>;

/** Runs a tool body, returning its value as JSON text and any failure as an `isError` result the model can read. */
async function toToolResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await run());
  } catch (error) {
    return errorResult(error);
  }
}

/** `toToolResult` that also records each call's outcome and duration when metrics are given. */
function createToolRunner(metrics?: McpServerMetrics): ToolRunner {
  if (!metrics) {
    return (_tool, run) => toToolResult(run);
  }
  return async (tool, run) => {
    const endTimer = metrics.toolDuration.startTimer({ tool });
    const result = await toToolResult(run);
    endTimer();
    metrics.toolCalls.inc({ tool, outcome: result.isError ? 'error' : 'success' });
    return result;
  };
}

/**
 * Builds the database MCP server, independent of transport. It is the only source of the
 * database context tools and the schema overview resource; tool results are JSON text, which
 * the app's MCP registry parses back.
 */
export function createDatabaseMcpServer(database: UntrustedDatabase, metrics?: McpServerMetrics): Server {
  const tools = createDatabaseContextTools(database);
  const toolNames = new Set(tools.definitions.map((definition) => definition.name));
  const runTool = createToolRunner(metrics);
  const server = new Server(SERVER_INFO, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.definitions.map((definition): Tool => ({
      ...definition,
      inputSchema: definition.inputSchema as Tool['inputSchema'],
      annotations: READ_ONLY_TOOL,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const label = toolNames.has(name) ? name : UNKNOWN_TOOL_LABEL;
    return runTool(label, () => tools.execute(name, args));
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [SCHEMA_OVERVIEW_RESOURCE] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== SCHEMA_OVERVIEW_RESOURCE.uri) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    const text = await readSchemaOverview(database);
    return { contents: [{ uri, mimeType: SCHEMA_OVERVIEW_RESOURCE.mimeType, text }] };
  });

  return server;
}
