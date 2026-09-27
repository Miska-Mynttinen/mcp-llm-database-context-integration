import { randomUUID } from 'crypto';
import { APP_TABLES, type DatabaseAdapter } from '@mcp-llm/database';
import { type User, type UserRole, type UserStore } from './types';

const USERS_TABLE = APP_TABLES.users.name;

/** Persists login users in the configured database. Get it from `openAppStorage`, which creates its table. */
export class SqlUserStore implements UserStore {
  constructor(private readonly database: DatabaseAdapter) {}

  async findByUsername(username: string): Promise<User | undefined> {
    const { rows } = await this.database.query<UserRow>(
      `SELECT id, username, password_hash, role, created_at FROM ${USERS_TABLE} WHERE username = ? LIMIT 1`,
      [username],
    );
    return rows.length > 0 ? toUser(rows[0]) : undefined;
  }

  async create(input: Omit<User, 'id' | 'createdAt'>): Promise<User> {
    const user: User = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    await this.database.query(
      `INSERT INTO ${USERS_TABLE} (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`,
      [user.id, user.username, user.passwordHash, user.role, user.createdAt],
    );
    return user;
  }

  async updatePasswordHash(username: string, passwordHash: string): Promise<void> {
    await this.database.query(`UPDATE ${USERS_TABLE} SET password_hash = ? WHERE username = ?`, [passwordHash, username]);
  }
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role as UserRole,
    createdAt: row.created_at,
  };
}
