import fs from 'fs';
import path from 'path';

/**
 * The env files a deployment is configured with. The chat app loads all of them;
 * the MCP server loads `database` and `mcp`, which it shares with the app.
 */
export const ENV_FILES = {
  /** LLM settings (LLM_*). */
  llm: '.env.llm',
  /** Database settings (DB_*). */
  database: '.env.database',
  /** MCP_AUTH_TOKEN and MCP server settings. */
  mcp: '.env.mcp',
  /** Rate limits and daily token budgets (RATE_LIMIT_*, CHAT_TOKENS_DAILY_*, TRUST_PROXY). */
  limits: '.env.limits',
  /** App settings (PORT, MCP_SERVER_URLS). */
  app: '.env',
} as const;

/**
 * Loads each named file that exists in `dir` into `process.env`, in order. Precedence: real
 * environment variables, then the first file that defines a variable. Returns the loaded paths.
 */
export function loadEnvFiles(dir: string, fileNames: readonly string[]): string[] {
  return fileNames
    .map((name) => path.resolve(dir, name))
    .filter((file) => fs.existsSync(file))
    .map((file) => {
      process.loadEnvFile(file);
      return file;
    });
}

/** Splits a comma-separated setting, trimming entries and dropping empty ones. */
export function parseList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
