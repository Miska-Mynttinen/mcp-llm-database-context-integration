import { type ChatMessage, type ChatRole, type ChatSession } from './types';

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

/** The roles people see and write: tool records are model context, not conversation. */
export const VISIBLE_ROLES: readonly ChatRole[] = ['user', 'assistant'];

export interface UserHistoryQuery {
  /** See `clampHistoryLimit`. */
  limit?: number;
  /** Only messages with these roles; every role when omitted. */
  roles?: readonly ChatRole[];
  /** Leaves out this session, e.g. the conversation already in the model's context. */
  excludeSessionId?: string;
}

/** The session doesn't exist for this user: it is missing, unowned, or owned by someone else. */
export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
  }
}

/**
 * A session the caller has proven it owns: the only way to read or write a session's messages.
 * Get one from `ConversationStore.openSession` or `findOwnedSession`.
 */
export interface OwnedSession extends ChatSession {
  /** Appends a message; throws when the session has been cleared since it was opened. */
  append(role: ChatRole, content: string): Promise<ChatMessage>;
  /**
   * The newest `limit` messages, oldest first, counting only `roles` (every role when omitted).
   * See `clampHistoryLimit` for `limit`.
   */
  recent(limit?: number, roles?: readonly ChatRole[]): Promise<ChatMessage[]>;
  /** Deletes the session and its messages. */
  clear(): Promise<void>;
}

/**
 * Sessions and their messages. A session's messages are reached only through the `OwnedSession`
 * that `openSession` or `findOwnedSession` return, so every read and write is ownership-checked.
 */
export interface ConversationStore {
  /**
   * The session, created for `userId` if it doesn't exist yet. Safe when two requests create
   * the same session at once. Throws `SessionNotFoundError` when it exists and `userId` doesn't own it.
   */
  openSession(sessionId: string, userId: string): Promise<OwnedSession>;
  /**
   * The session if `userId` owns it; undefined when it doesn't exist.
   * Throws `SessionNotFoundError` when someone else, or no one, owns it.
   */
  findOwnedSession(sessionId: string, userId: string): Promise<OwnedSession | undefined>;
  /** The newest messages matching `query` across every session owned by `userId`, oldest first. */
  getRecentMessagesForUser(userId: string, query?: UserHistoryQuery): Promise<ChatMessage[]>;
}

/** A history size as an integer in [1, MAX_HISTORY_LIMIT]; anything unusable (NaN, < 1, missing) means the default. */
export function clampHistoryLimit(limit: unknown): number {
  const requested = Number(limit ?? DEFAULT_HISTORY_LIMIT);
  if (!Number.isFinite(requested) || requested < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_HISTORY_LIMIT);
}

/** Whether `message` passes a `roles` filter; an omitted filter passes every role. */
export function hasRole(message: ChatMessage, roles: readonly ChatRole[] | undefined): boolean {
  return !roles || roles.includes(message.role);
}

/** Returns the session when `userId` owns it; throws `SessionNotFoundError` otherwise (including ownerless legacy sessions). */
export function requireOwner(session: ChatSession, userId: string): ChatSession {
  if (session.userId !== userId) {
    throw new SessionNotFoundError();
  }
  return session;
}
