import { DatabaseAdapter, DatabaseConfig } from './types';
import { PostgreSQLAdapter } from './adapters/postgres';
import { MySQLAdapter } from './adapters/mysql';
import { SQLiteAdapter } from './adapters/sqlite';

export type DatabaseType = 'postgres' | 'mysql' | 'sqlite';

export interface DatabaseFactoryConfig extends DatabaseConfig {
  type: DatabaseType;
}

/**
 * Factory for creating database adapter instances
 */
export class DatabaseFactory {
  static createFromEnv(): DatabaseAdapter {
    const dbType = (process.env.DB_TYPE || 'sqlite') as DatabaseType;

    const config: DatabaseConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || (dbType === 'mysql' ? '3306' : dbType === 'postgres' ? '5432' : '0')),
      user: process.env.DB_USER || (dbType === 'sqlite' ? 'sqlite' : 'postgres'),
      password: process.env.DB_PASSWORD || (dbType === 'sqlite' ? '' : 'password'),
      database: process.env.DB_NAME || (dbType === 'sqlite' ? 'database.db' : 'testdb'),
    };

    return this.create({ ...config, type: dbType });
  }

  static create(config: DatabaseFactoryConfig): DatabaseAdapter {
    const { type, ...dbConfig } = config;

    switch (type) {
      case 'postgres':
        return new PostgreSQLAdapter(dbConfig);

      case 'mysql':
        // Adjust default port for MySQL
        if (dbConfig.port === 5432) {
          dbConfig.port = 3306;
        }
        return new MySQLAdapter(dbConfig);

      case 'sqlite':
        return new SQLiteAdapter(dbConfig);

      default:
        throw new Error(`Unknown database type: ${type}`);
    }
  }

  static getDefaultPort(type: DatabaseType): number {
    switch (type) {
      case 'postgres':
        return 5432;
      case 'mysql':
        return 3306;
      case 'sqlite':
        return 0; // SQLite doesn't use ports
      default:
        return 5432;
    }
  }

  static getDefaultDatabase(type: DatabaseType): string {
    switch (type) {
      case 'postgres':
        return 'postgres';
      case 'mysql':
        return 'mysql';
      case 'sqlite':
        return 'database.db';
      default:
        return 'testdb';
    }
  }

  static validateConfig(config: DatabaseFactoryConfig): { valid: boolean; error?: string } {
    const { type, host, user, password, database } = config;

    // SQLite doesn't need host, user, password
    if (type === 'sqlite') {
      if (!database) {
        return { valid: false, error: 'SQLite requires database (file path)' };
      }
      return { valid: true };
    }

    // PostgreSQL and MySQL need these
    if (!host) {
      return { valid: false, error: `${type} requires host` };
    }
    if (!user) {
      return { valid: false, error: `${type} requires user` };
    }
    if (!database) {
      return { valid: false, error: `${type} requires database` };
    }

    return { valid: true };
  }
}

/**
 * Global database adapter instance
 */
let globalAdapter: DatabaseAdapter | null = null;

export async function initializeDatabaseAdapter(config?: DatabaseFactoryConfig): Promise<DatabaseAdapter> {
  if (globalAdapter) {
    return globalAdapter;
  }

  globalAdapter = config ? DatabaseFactory.create(config) : DatabaseFactory.createFromEnv();
  await globalAdapter.connect();
  return globalAdapter;
}

export function getDatabaseAdapter(): DatabaseAdapter {
  if (!globalAdapter) {
    throw new Error('Database adapter not initialized. Call initializeDatabaseAdapter first.');
  }
  return globalAdapter;
}

export async function closeDatabaseAdapter(): Promise<void> {
  if (globalAdapter) {
    await globalAdapter.disconnect();
    globalAdapter = null;
  }
}
