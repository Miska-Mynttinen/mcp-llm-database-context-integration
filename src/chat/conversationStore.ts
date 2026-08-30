import { DatabaseAdapter } from '../database/types';
import { ChatMessage, ChatSession, ConversationStore } from './types';

export class DatabaseConversationStore implements ConversationStore {
  private memory = new Map<string, { session: ChatSession; messages: ChatMessage[] }>();

  constructor(private readonly databaseAdapter?: DatabaseAdapter) {}

  async ensureSession(sessionId: string, userId?: string): Promise<ChatSession> {
    const normalizedId = sessionId || userId || 'default';

    if (!this.databaseAdapter) {
      const existing = this.memory.get(normalizedId);
      if (existing) {
        return existing.session;
      }
      const session: ChatSession = {
        id: normalizedId,
        userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.memory.set(normalizedId, { session, messages: [] });
      return session;
    }

    await this.databaseAdapter.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    await this.databaseAdapter.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    const existing = await this.databaseAdapter.query(
      'SELECT * FROM chat_sessions WHERE id = ? LIMIT 1',
      [normalizedId],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        id: row.id,
        userId: row.user_id || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }

    const now = new Date().toISOString();
    const session: ChatSession = {
      id: normalizedId,
      userId,
      createdAt: now,
      updatedAt: now,
    };

    await this.databaseAdapter.query(
      'INSERT INTO chat_sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [session.id, session.userId || null, session.createdAt, session.updatedAt],
    );

    return session;
  }

  async appendMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<ChatMessage> {
    const normalizedSessionId = sessionId || 'default';
    const now = new Date().toISOString();
    const id = `${normalizedSessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message: ChatMessage = {
      id,
      sessionId: normalizedSessionId,
      role,
      content,
      createdAt: now,
    };

    if (!this.databaseAdapter) {
      const existing = this.memory.get(normalizedSessionId) || { session: { id: normalizedSessionId, createdAt: now, updatedAt: now }, messages: [] };
      existing.messages.push(message);
      existing.session.updatedAt = now;
      this.memory.set(normalizedSessionId, existing);
      return message;
    }

    await this.databaseAdapter.query(
      'INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [message.id, message.sessionId, message.role, message.content, message.createdAt],
    );

    await this.databaseAdapter.query(
      'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
      [now, normalizedSessionId],
    );

    return message;
  }

  async getRecentMessages(sessionId: string, limit = 20): Promise<ChatMessage[]> {
    const normalizedSessionId = sessionId || 'default';

    if (!this.databaseAdapter) {
      const existing = this.memory.get(normalizedSessionId);
      return (existing?.messages || []).slice(-limit);
    }

    const result = await this.databaseAdapter.query(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
      [normalizedSessionId, limit],
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async clearSession(sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId || 'default';

    if (!this.databaseAdapter) {
      this.memory.delete(normalizedSessionId);
      return;
    }

    await this.databaseAdapter.query('DELETE FROM chat_messages WHERE session_id = ?', [normalizedSessionId]);
    await this.databaseAdapter.query('DELETE FROM chat_sessions WHERE id = ?', [normalizedSessionId]);
  }
}
