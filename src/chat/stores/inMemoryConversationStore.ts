import { randomUUID } from 'crypto';
import { type ChatMessage, type ChatRole, type ChatSession } from '../types';
import {
  clampHistoryLimit,
  type ConversationStore,
  hasRole,
  type OwnedSession,
  requireOwner,
  type UserHistoryQuery,
} from '../conversationStore';

interface SessionRecord {
  session: ChatSession;
  messages: readonly ChatMessage[];
}

/** Process-local store: for tests and running without persistent history. */
export class InMemoryConversationStore implements ConversationStore {
  private readonly records = new Map<string, SessionRecord>();
  // Write order of every message, so cross-session reads stay ordered when timestamps tie.
  private readonly sequence = new Map<string, number>();
  private nextSequence = 0;

  async openSession(sessionId: string, userId: string): Promise<OwnedSession> {
    const existing = this.records.get(sessionId);
    if (existing) {
      return this.owned(requireOwner(existing.session, userId));
    }
    const now = new Date().toISOString();
    const session: ChatSession = { id: sessionId, userId, createdAt: now, updatedAt: now };
    this.records.set(sessionId, { session, messages: [] });
    return this.owned(session);
  }

  async findOwnedSession(sessionId: string, userId: string): Promise<OwnedSession | undefined> {
    const record = this.records.get(sessionId);
    return record && this.owned(requireOwner(record.session, userId));
  }

  async getRecentMessagesForUser(userId: string, query: UserHistoryQuery = {}): Promise<ChatMessage[]> {
    const owned = [...this.records.values()].filter((record) =>
      record.session.userId === userId && record.session.id !== query.excludeSessionId);
    const order = (message: ChatMessage) => this.sequence.get(message.id) ?? 0;
    return owned
      .flatMap((record) => record.messages)
      .filter((message) => hasRole(message, query.roles))
      .sort((a, b) => order(a) - order(b))
      .slice(-clampHistoryLimit(query.limit));
  }

  /** Bound to the session's id and owner, so a handle kept past a clear can't reach a successor session. */
  private owned(session: ChatSession): OwnedSession {
    const ownedRecord = () => {
      const record = this.records.get(session.id);
      return record?.session.userId === session.userId ? record : undefined;
    };
    return {
      ...session,
      append: async (role, content) => this.append(session.id, ownedRecord(), role, content),
      recent: async (limit, roles) =>
        (ownedRecord()?.messages ?? []).filter((message) => hasRole(message, roles)).slice(-clampHistoryLimit(limit)),
      clear: async () => {
        const record = ownedRecord();
        for (const message of record?.messages ?? []) {
          this.sequence.delete(message.id);
        }
        if (record) {
          this.records.delete(session.id);
        }
      },
    };
  }

  private append(sessionId: string, record: SessionRecord | undefined, role: ChatRole, content: string): ChatMessage {
    if (!record) {
      throw new Error(`Cannot append to session ${sessionId}: it does not exist`);
    }
    const now = new Date().toISOString();
    const message: ChatMessage = { id: randomUUID(), sessionId, role, content, createdAt: now };
    this.sequence.set(message.id, this.nextSequence++);
    this.records.set(sessionId, {
      session: { ...record.session, updatedAt: now },
      messages: [...record.messages, message],
    });
    return message;
  }
}
