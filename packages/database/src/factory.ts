import { type DatabaseAdapter, type DatabaseConfig, type DatabaseSslMode, type DatabaseType, type ReadOnlyLogin } from './types';
import { PostgreSQLAdapter } from './adapters/postgres';
import { MySQLAdapter } from './adapters/mysql';
import { SQLiteAdapter } from './adapters/sqlite';

export interface DatabaseFactoryConfig extends DatabaseConfig {
  type: DatabaseType;
}

const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
};

// Each server's built-in administrator; SQLite has no users.
const DEFAULT_USERS: Record<DatabaseType, string> = {
  postgres: 'postgres',
  mysql: 'root',
  sqlite: 'sqlite',
};

const SSL_MODES: readonly DatabaseSslMode[] = ['off', 'require', 'verify'];
const MAX_PORT = 65535;
// Long enough for any reasonable query on a chat's behalf, short enough that a runaway one frees its connection.
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * DB_* settings. DB_PASSWORD has no default: a server that needs one refuses the connection
 * with its own error, rather than the app silently trying a well-known password.
 */
export function readDatabaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseFactoryConfig {
  const type = parseDatabaseType(env.DB_TYPE);
  const isSqlite = type === 'sqlite';

  return {
    type,
    host: env.DB_HOST || 'localhost',
    port: isSqlite ? 0 : parsePort(env.DB_PORT, DEFAULT_PORTS[type]),
    user: env.DB_USER || DEFAULT_USERS[type],
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME || (isSqlite ? 'database.db' : 'testdb'),
    ssl: parseSslMode(env.DB_SSL),
    statementTimeoutMs: parseStatementTimeout(env.DB_STATEMENT_TIMEOUT_MS),
  };
}

/**
 * The read-only login for untrusted readers, from DB_READONLY_USER and DB_READONLY_PASSWORD, or
 * undefined when DB_READONLY_USER is unset. The app creates it at startup (hidden from the app
 * tables); the MCP server connects as it instead of DB_USER. PostgreSQL and MySQL only.
 */
export function readReadOnlyLoginFromEnv(env: NodeJS.ProcessEnv = process.env): ReadOnlyLogin | undefined {
  const user = env.DB_READONLY_USER?.trim();
  if (!user) {
    return undefined;
  }
  if (parseDatabaseType(env.DB_TYPE) === 'sqlite') {
    throw new Error('DB_READONLY_USER needs DB_TYPE=postgres or mysql: SQLite has no database logins');
  }
  const password = env.DB_READONLY_PASSWORD ?? '';
  if (!password) {
    throw new Error('DB_READONLY_PASSWORD must be set when DB_READONLY_USER is');
  }
  return { user, password };
}

export function createDatabaseAdapter(config: DatabaseFactoryConfig): DatabaseAdapter {
  const { type, ...dbConfig } = config;

  switch (type) {
    case 'postgres':
      return new PostgreSQLAdapter(dbConfig);
    case 'mysql':
      return new MySQLAdapter(dbConfig);
    case 'sqlite':
      return new SQLiteAdapter(dbConfig);
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}

/**
 * Creates and connects an adapter. Callers own the returned adapter and must
 * call `disconnect()` on shutdown.
 */
export async function connectDatabaseAdapter(
  config: DatabaseFactoryConfig = readDatabaseConfigFromEnv(),
): Promise<DatabaseAdapter> {
  const adapter = createDatabaseAdapter(config);
  await adapter.connect();
  return adapter;
}

function parseDatabaseType(value: string | undefined): DatabaseType {
  const type = value || 'sqlite';
  if (!(type in DEFAULT_PORTS)) {
    throw new Error(`DB_TYPE must be one of ${Object.keys(DEFAULT_PORTS).join(', ')}, got "${type}"`);
  }
  return type as DatabaseType;
}

function parsePort(value: string | undefined, defaultPort: number): number {
  if (!value) {
    return defaultPort;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`DB_PORT must be a port number (1-${MAX_PORT}), got "${value}"`);
  }
  return port;
}

function parseSslMode(value: string | undefined): DatabaseSslMode {
  const mode = value?.trim().toLowerCase() || 'off';
  if (!SSL_MODES.includes(mode as DatabaseSslMode)) {
    throw new Error(`DB_SSL must be one of ${SSL_MODES.join(', ')}, got "${value}"`);
  }
  return mode as DatabaseSslMode;
}

/** DB_STATEMENT_TIMEOUT_MS in milliseconds; 0 turns the limit off. */
function parseStatementTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error(`DB_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds (0 for no limit), got "${value}"`);
  }
  return timeoutMs;
}
