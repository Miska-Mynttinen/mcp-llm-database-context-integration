import { randomUUID } from 'crypto';
import { APP_TABLES, type DatabaseAdapter, type Row } from '@mcp-llm/database';
import { type ChatMessage, type ChatRole, type ChatSession } from '../types';
import {
  clampHistoryLimit,
  type ConversationStore,
  type OwnedSession,
  requireOwner,
  type UserHistoryQuery,
} from '../conversationStore';

const SESSIONS = APP_TABLES.chatSessions.name;
const MESSAGES = APP_TABLES.chatMessages.name;

/**
 * Persists sessions and messages in the configured database. Its tables must exist:
 * get it from `openAppStorage`, which creates them.
 */
export class SqlConversationStore implements ConversationStore {
  private lastTimestamp = 0;

  constructor(private readonly database: DatabaseAdapter) {}

  async openSession(sessionId: string, userId: string): Promise<OwnedSession> {
    const existing = await this.findSession(sessionId);
    if (existing) {
      return this.owned(requireOwner(existing, userId));
    }
    const now = this.nextTimestamp();
    try {
      await this.execute(
        `INSERT INTO ${SESSIONS} (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        [sessionId, userId, now, now],
      );
    } catch (error) {
      // A concurrent request created the session first (primary-key conflict): use that one.
      const created = await this.findSession(sessionId);
      if (!created) {
        throw error;
      }
      return this.owned(requireOwner(created, userId));
    }
    return this.owned({ id: sessionId, userId, createdAt: now, updatedAt: now });
  }

  async findOwnedSession(sessionId: string, userId: string): Promise<OwnedSession | undefined> {
    const session = await this.findSession(sessionId);
    return session && this.owned(requireOwner(session, userId));
  }

  async getRecentMessagesForUser(userId: string, query: UserHistoryQuery = {}): Promise<ChatMessage[]> {
    const roles = roleFilter(query.roles);
    const excluded = query.excludeSessionId === undefined
      ? { sql: '', params: [] }
      : { sql: ' AND m.session_id <> ?', params: [query.excludeSessionId] };
    const rows = await this.run<MessageRow>(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at
       FROM ${MESSAGES} m JOIN ${SESSIONS} s ON s.id = m.session_id
       WHERE s.user_id = ?${excluded.sql}${roles.sql} ORDER BY m.created_at DESC LIMIT ?`,
      [userId, ...excluded.params, ...roles.params, clampHistoryLimit(query.limit)],
    );
    return rows.reverse().map(toMessage);
  }

  /**
   * Every statement is scoped to the session's id and owner, so a handle kept past a clear
   * can't reach a session another user has since opened under the same id.
   */
  private owned(session: ChatSession): OwnedSession {
    const owner = session.userId as string;
    return {
      ...session,
      append: (role, content) => this.append(session.id, owner, role, content),
      recent: (limit, roles) => this.recent(session.id, owner, limit, roles),
      clear: () => this.clear(session.id, owner),
    };
  }

  private async append(sessionId: string, owner: string, role: ChatRole, content: string): Promise<ChatMessage> {
    const message: ChatMessage = { id: randomUUID(), sessionId, role, content, createdAt: this.nextTimestamp() };
    const touched = await this.execute(
      `UPDATE ${SESSIONS} SET updated_at = ? WHERE id = ? AND user_id = ?`,
      [message.createdAt, sessionId, owner],
    );
    if (touched === 0) {
      throw new Error(`Cannot append to session ${sessionId}: it does not exist`);
    }
    await this.execute(
      `INSERT INTO ${MESSAGES} (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      [message.id, message.sessionId, message.role, message.content, message.createdAt],
    );
    return message;
  }

  private async recent(
    sessionId: string,
    owner: string,
    limit?: number,
    roles?: readonly ChatRole[],
  ): Promise<ChatMessage[]> {
    const filter = roleFilter(roles);
    const rows = await this.run<MessageRow>(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at
       FROM ${MESSAGES} m JOIN ${SESSIONS} s ON s.id = m.session_id
       WHERE m.session_id = ? AND s.user_id = ?${filter.sql} ORDER BY m.created_at DESC LIMIT ?`,
      [sessionId, owner, ...filter.params, clampHistoryLimit(limit)],
    );
    return rows.reverse().map(toMessage);
  }

  private async clear(sessionId: string, owner: string): Promise<void> {
    await this.execute(
      `DELETE FROM ${MESSAGES} WHERE session_id IN (SELECT id FROM ${SESSIONS} WHERE id = ? AND user_id = ?)`,
      [sessionId, owner],
    );
    await this.execute(`DELETE FROM ${SESSIONS} WHERE id = ? AND user_id = ?`, [sessionId, owner]);
  }

  private async findSession(sessionId: string): Promise<ChatSession | undefined> {
    const rows = await this.run<SessionRow>(
      `SELECT id, user_id, created_at, updated_at FROM ${SESSIONS} WHERE id = ? LIMIT 1`,
      [sessionId],
    );
    const row = rows[0];
    return row && { id: row.id, userId: row.user_id || undefined, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private async run<TRow = Row>(sql: string, params: readonly unknown[]): Promise<TRow[]> {
    return (await this.database.query<TRow>(sql, params)).rows;
  }

  /** Runs an INSERT, UPDATE or DELETE and returns how many rows it matched. */
  private async execute(sql: string, params: readonly unknown[]): Promise<number> {
    return (await this.database.query(sql, params)).rowCount;
  }

  /** Strictly increasing ISO timestamps, so messages written in the same millisecond keep their order. */
  private nextTimestamp(): string {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }
}

interface SessionRow {
  id: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatMessage['role'];
  content: string;
  created_at: string;
}

/** A `WHERE` clause fragment limiting `m.role`; empty when every role is wanted. */
function roleFilter(roles: readonly ChatRole[] | undefined): { sql: string; params: readonly string[] } {
  if (!roles) {
    return { sql: '', params: [] };
  }
  if (roles.length === 0) {
    return { sql: ' AND 1 = 0', params: [] };
  }
  return { sql: ` AND m.role IN (${roles.map(() => '?').join(', ')})`, params: roles };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
