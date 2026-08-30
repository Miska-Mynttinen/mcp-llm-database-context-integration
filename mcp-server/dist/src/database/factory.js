import { PostgreSQLAdapter } from './adapters/postgres';
import { MySQLAdapter } from './adapters/mysql';
import { SQLiteAdapter } from './adapters/sqlite';
/**
 * Factory for creating database adapter instances
 */
export class DatabaseFactory {
    static createFromEnv() {
        const dbType = (process.env.DB_TYPE || 'sqlite');
        const config = {
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || (dbType === 'mysql' ? '3306' : dbType === 'postgres' ? '5432' : '0')),
            user: process.env.DB_USER || (dbType === 'sqlite' ? 'sqlite' : 'postgres'),
            password: process.env.DB_PASSWORD || (dbType === 'sqlite' ? '' : 'password'),
            database: process.env.DB_NAME || (dbType === 'sqlite' ? 'database.db' : 'testdb'),
        };
        return this.create({ ...config, type: dbType });
    }
    static create(config) {
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
    static getDefaultPort(type) {
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
    static getDefaultDatabase(type) {
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
    static validateConfig(config) {
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
let globalAdapter = null;
export async function initializeDatabaseAdapter(config) {
    if (globalAdapter) {
        return globalAdapter;
    }
    globalAdapter = config ? DatabaseFactory.create(config) : DatabaseFactory.createFromEnv();
    await globalAdapter.connect();
    return globalAdapter;
}
export function getDatabaseAdapter() {
    if (!globalAdapter) {
        throw new Error('Database adapter not initialized. Call initializeDatabaseAdapter first.');
    }
    return globalAdapter;
}
export async function closeDatabaseAdapter() {
    if (globalAdapter) {
        await globalAdapter.disconnect();
        globalAdapter = null;
    }
}
