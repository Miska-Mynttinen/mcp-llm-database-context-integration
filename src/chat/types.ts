/** `tool` rows record a turn's tool calls for later model context; they are never shown to people. */
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatSession {
  id: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}
