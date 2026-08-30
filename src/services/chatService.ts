import { DatabaseAdapter } from '../database/types';
import { LLMProvider } from '../llm/types';
import { ConversationStore } from '../chat/types';
import { ToolDefinition } from '../tools/types';
import { ToolCallOrchestrator } from '../tools/orchestrator';

export interface ChatRequest {
  sessionId?: string;
  userId?: string;
  message: string;
}

export interface ChatResponse {
  sessionId: string;
  answer: string;
  toolCall?: {
    name: string;
    arguments: Record<string, any>;
  };
  toolResult?: any;
}

export class ChatService {
  private readonly orchestrator: ToolCallOrchestrator;

  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly databaseAdapter: DatabaseAdapter,
    private readonly conversationStore: ConversationStore,
    toolDefinitions: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, any>) => Promise<any>,
  ) {
    this.orchestrator = new ToolCallOrchestrator(
      llmProvider,
      conversationStore,
      toolDefinitions,
      toolExecutor,
    );
  }

  async handleMessage(request: ChatRequest): Promise<ChatResponse> {
    const sessionId = request.sessionId || request.userId || 'default';
    const result = await this.orchestrator.processMessage(sessionId, request.userId, request.message);

    return {
      sessionId,
      answer: result.answer,
      toolCall: result.toolCall,
      toolResult: result.toolResult,
    };
  }

  async getHistory(sessionId: string, limit = 20): Promise<any[]> {
    return this.conversationStore.getRecentMessages(sessionId, limit);
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.conversationStore.clearSession(sessionId);
  }
}
