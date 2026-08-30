export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolExecutionResult {
  ok: boolean;
  name: string;
  result?: any;
  error?: string;
}

export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<any>;
