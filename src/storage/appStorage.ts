import { createAppTables, type DatabaseAdapter, grantReadOnlyLogin, type ReadOnlyLogin } from '@mcp-llm/database';
import { SqlConversationStore } from '../chat/stores/sqlConversationStore';
import { SqlUserStore } from '../auth/userStore';
import { SqlTokenUsageStore } from '../tokenBudget/tokenUsageStore';

/** The app's persistent stores, all on one database. */
export interface AppStorage {
  readonly conversations: SqlConversationStore;
  readonly users: SqlUserStore;
  readonly tokenUsage: SqlTokenUsageStore;
}

export interface AppStorageOptions {
  /**
   * The login untrusted readers (the MCP server) connect as. Created or updated after the app
   * tables, so it can read every table but those, including any table this version adds.
   */
  readOnlyLogin?: ReadOnlyLogin;
}

/**
 * Creates every app table and index where missing, then returns the stores. Idempotent; call
 * once at startup. The tables are defined in `APP_TABLES` (`@mcp-llm/database`), which is also
 * what hides them from untrusted readers.
 */
export async function openAppStorage(database: DatabaseAdapter, options: AppStorageOptions = {}): Promise<AppStorage> {
  await createAppTables(database);
  if (options.readOnlyLogin) {
    await grantReadOnlyLogin(database, options.readOnlyLogin);
  }
  return {
    conversations: new SqlConversationStore(database),
    users: new SqlUserStore(database),
    tokenUsage: new SqlTokenUsageStore(database),
  };
}
