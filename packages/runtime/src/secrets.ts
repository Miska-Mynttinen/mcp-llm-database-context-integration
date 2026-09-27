/**
 * Secrets shipped for local development in the `*.example` files and `docker-compose.yaml`.
 * Anyone can read them in the repository, so a production deployment must never run with them.
 */
export const DEVELOPMENT_SECRETS: Readonly<Record<string, readonly string[]>> = {
  JWT_SECRET: ['saltsecret-saltsecret-saltsecret-00'],
  SEED_USER_PASSWORD: ['password'],
  MCP_AUTH_TOKEN: ['dev-mcp-token-dev-mcp-token-dev-mcp-token'],
  DB_PASSWORD: ['password', 'readonly-password'],
  DB_READONLY_PASSWORD: ['readonly-password'],
};

/** Shared by the chat app (which sends it) and the MCP server (which requires it). */
export const MIN_MCP_AUTH_TOKEN_LENGTH = 32;

/** Production is the default in the Docker images; local `docker-compose.yaml` sets NODE_ENV=development. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * When NODE_ENV=production, throws naming every variable still set to a public development value.
 * Does nothing otherwise.
 */
export function assertNoDevelopmentSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) {
    return;
  }
  const offending = Object.entries(DEVELOPMENT_SECRETS)
    .filter(([name, values]) => values.includes(env[name]?.trim() ?? ''))
    .map(([name]) => name);
  if (offending.length > 0) {
    throw new Error(
      `NODE_ENV=production but ${offending.join(', ')} still use the public development values. `
      + 'Set real secrets (e.g. openssl rand -hex 32), or NODE_ENV=development for local use',
    );
  }
}

/**
 * Reads MCP_AUTH_TOKEN, trimmed. Throws when it is shorter than 32 characters; `context`
 * says why it is needed. The chat app and the MCP server must use the same value.
 */
export function requireMcpAuthToken(env: NodeJS.ProcessEnv, context: string): string {
  const authToken = env.MCP_AUTH_TOKEN?.trim() ?? '';
  if (authToken.length < MIN_MCP_AUTH_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be set to at least ${MIN_MCP_AUTH_TOKEN_LENGTH} characters ${context} `
      + '(e.g. openssl rand -hex 32, in .env.mcp); the chat app and the MCP server must use the same value',
    );
  }
  return authToken;
}
