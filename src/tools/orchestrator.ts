import { LLMProvider, Message } from '../llm/types';
import { ChatMessage, ConversationStore } from '../chat/types';
import { ToolCall, ToolDefinition, ToolExecutionResult } from './types';

export class ToolCallOrchestrator {
  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly conversationStore: ConversationStore,
    private readonly toolDefinitions: ToolDefinition[],
    private readonly toolExecutor: (name: string, args: Record<string, any>) => Promise<any>,
  ) {}

  async processMessage(sessionId: string, userId: string | undefined, message: string): Promise<{ answer: string; toolCall?: ToolCall; toolResult?: ToolExecutionResult }> {
    await this.conversationStore.ensureSession(sessionId || userId || 'default', userId);
    await this.conversationStore.appendMessage(sessionId || userId || 'default', 'user', message);

    const history = await this.conversationStore.getRecentMessages(sessionId || userId || 'default', 12);
    const toolPrompt = this.buildToolPrompt();
    const modelMessages: Message[] = [
      { role: 'system', content: toolPrompt },
      ...history.map((entry: ChatMessage): Message => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        content: entry.content,
      })),
      { role: 'user', content: message },
    ];

    const firstPass = await this.llmProvider.chat(modelMessages);
    const toolCall = this.parseToolCall(firstPass.content);

    if (!toolCall) {
      await this.conversationStore.appendMessage(sessionId || userId || 'default', 'assistant', firstPass.content);
      return { answer: firstPass.content };
    }

    const toolResult = await this.executeTool(toolCall);
    const followUpMessages: Message[] = [
      ...modelMessages,
      { role: 'assistant', content: JSON.stringify(toolCall) },
      {
        role: 'user',
        content: `Tool result:\n${JSON.stringify(toolResult, null, 2)}`,
      },
    ];

    const finalResponse = await this.llmProvider.chat(followUpMessages);
    await this.conversationStore.appendMessage(sessionId || userId || 'default', 'assistant', finalResponse.content);

    return {
      answer: finalResponse.content,
      toolCall,
      toolResult,
    };
  }

  private buildToolPrompt(): string {
    return `
You are a helpful database-aware assistant.

Rules:
- Use the tools when the user asks for schema, table metadata, database contents, or recent conversation history.
- When a tool is needed, respond only with a JSON object shaped like:
  { "name": "tool_name", "arguments": { ... } }
- When no tool is needed, answer normally in natural language.
- When a schema, relationship, or request flow is easier to understand visually, include a valid Mermaid diagram in a fenced block using \`\`\`mermaid and \`\`\`.
- Do not reveal secrets or perform destructive database actions.

Available tools:
${this.toolDefinitions.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}
    `.trim();
  }

  private parseToolCall(content: string): ToolCall | null {
    const candidate = content.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? content.trim();
    if (!candidate) {
      return null;
    }

    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') {
        return null;
      }
      return {
        name: parsed.name,
        arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
      };
    } catch {
      return null;
    }
  }

  private async executeTool(call: ToolCall): Promise<ToolExecutionResult> {
    try {
      const result = await this.toolExecutor(call.name, call.arguments || {});
      return {
        ok: true,
        name: call.name,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: call.name,
        error: message,
      };
    }
  }
}
