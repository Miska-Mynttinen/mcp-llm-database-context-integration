import { type ConversationStore, VISIBLE_ROLES } from '../chat/conversationStore';
import { type ChatMessage } from '../chat/types';
import { type ToolContext, type ToolDefinition, type ToolRegistry } from './types';

const HISTORY_TOOL: ToolDefinition = {
  name: 'get_conversation_history',
  description:
    'Recall messages the user exchanged with you that are not in your context. The recent messages of the ' +
    'current conversation are already in your context: do not call this to read them. scope "previous" ' +
    '(default) reads the user\'s earlier conversations; scope "session" reads older messages of the current one.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['previous', 'session'] },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
};

// Small models otherwise pick the old conversation's last task back up as if it were the request.
const PREVIOUS_NOTE = 'Messages from earlier conversations, for reference only. Answer the user\'s latest message.';

/**
 * The chat app's only in-process tool: conversation history, which reads the app's own tables
 * for the chat turn's user. The database context tools come from the MCP server.
 */
export function createHistoryToolRegistry(conversationStore: ConversationStore): ToolRegistry {
  return {
    definitions: [HISTORY_TOOL],
    execute: async (name, args, context) => {
      if (name !== HISTORY_TOOL.name) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return historyPayload(conversationStore, args, context);
    },
  };
}

// Ids come from the context, never from the LLM's arguments: it must not read other users' chats.
// The store clamps `limit`, so an unusable value from the LLM means the default.
async function historyPayload(store: ConversationStore, args: Record<string, unknown>, context: ToolContext) {
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  if (args.scope === undefined || args.scope === 'previous') {
    const messages = await store.getRecentMessagesForUser(context.userId, {
      limit,
      roles: VISIBLE_ROLES,
      excludeSessionId: context.sessionId,
    });
    return { scope: 'previous', note: PREVIOUS_NOTE, messages: messages.map(toToolMessage) };
  }
  if (args.scope !== 'session') {
    throw new Error('scope must be "previous" or "session"');
  }
  const session = await store.findOwnedSession(context.sessionId, context.userId);
  const messages = session ? await session.recent(limit, VISIBLE_ROLES) : [];
  return { scope: 'session', messages: messages.map(toToolMessage) };
}

/** Only what the model needs: ids would just invite it to reason about sessions. */
function toToolMessage({ role, content, createdAt }: ChatMessage) {
  return { role, content, createdAt };
}
