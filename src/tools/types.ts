/**
 * A tool the LLM may call; `inputSchema` is a JSON Schema object. Structurally identical to the
 * LLM module's `ToolSpec`, so definitions pass straight through.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool call came to: its result, or an error message the model can read. */
export type ToolOutcome =
  | { ok: true; name: string; result: unknown }
  | { ok: false; name: string; error: string };

/** Facts about the chat turn a tool runs in, supplied by the caller rather than the LLM. */
export interface ToolContext {
  sessionId: string;
  /** The authenticated user who owns `sessionId`. */
  userId: string;
}

/** A call as the model made it; `argumentsError` is set when its arguments could not be parsed. */
export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
  argumentsError?: string;
}

/**
 * A source of tools behind the `Tools` module: conversation history, or the MCP servers.
 * `execute` may throw for unknown names and tool failures; `Tools` turns those into outcomes.
 */
export interface ToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

/** Every tool the LLM may call. `call` never rejects: every failure is an `ok: false` outcome. */
export interface Tools {
  readonly definitions: readonly ToolDefinition[];
  call(request: ToolCallRequest, context: ToolContext): Promise<ToolOutcome>;
}
