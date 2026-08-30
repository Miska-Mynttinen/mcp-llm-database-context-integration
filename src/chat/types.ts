export interface ChatSession {
  id: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface ConversationStore {
  ensureSession(sessionId: string, userId?: string): Promise<ChatSession>;
  appendMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<ChatMessage>;
  getRecentMessages(sessionId: string, limit?: number): Promise<ChatMessage[]>;
  clearSession(sessionId: string): Promise<void>;
}
