import { type ChatReply, type LLMProvider, type LLMToolCall, type Message, type ToolResultMessage } from '../llm/types';
import { type ToolContext, type ToolOutcome, type Tools } from '../tools/types';
import { type ChatMessage } from './types';
import { type ConversationStore, type OwnedSession, VISIBLE_ROLES } from './conversationStore';
import { type TokenBudget, type TurnMeter, UNLIMITED_BUDGET } from '../tokenBudget/tokenBudget';

export { SessionNotFoundError } from './conversationStore';

const DEFAULT_MAX_TOOL_STEPS = 4;
// About six turns: a turn that used tools is stored as three rows (user, tool, assistant).
const DEFAULT_CONTEXT_MESSAGES = 18;
/** Longest tool result kept per call in the stored tool record; longer ones are cut. */
export const MAX_TOOL_RESULT_CHARS = 1500;
export const TOOL_RECORD_HEADING = 'Tool results used for this answer:';

const PROMPT_INTRO =
  'You are a helpful database-aware assistant. Answer questions about the data by querying the database.';

const SHARED_RULES = `
- Answer from the query results. Never make up data. Call the tools yourself; do not ask the user whether you may.
- If a query fails, read the error: it lists the real columns or tables. Fix the SQL with those names and run it again before answering.
- The recent messages of this conversation are already above. Use get_conversation_history only when the user refers to an earlier conversation or to something no longer shown.
- When a schema, relationship, or request flow is easier to understand visually, include a valid Mermaid diagram in a fenced block using \`\`\`mermaid and \`\`\`.
- Do not reveal secrets or perform destructive database actions.
`.trim();

/** The system prompt when no schema context is available: the model looks the schema up itself. */
export const SYSTEM_PROMPT = `
${PROMPT_INTRO}

Rules:
- Use the tools when the user asks for schema, table metadata, or database contents.
- Before writing SQL, call get_table_columns for every table the query uses, unless its columns already appear earlier in this conversation. Never guess table or column names.
${SHARED_RULES}
`.trim();

/**
 * The system prompt with schema context (such as the MCP schema overview). The schema comes before
 * the rules, and the rules steer straight to a query: small models otherwise spend their tool steps
 * on lookups whenever the prompt mentions the lookup tools as an option.
 */
export function buildSystemPrompt(context: string): string {
  if (!context) {
    return SYSTEM_PROMPT;
  }
  return `
${PROMPT_INTRO}

${context}

Rules:
- For any question about the data, call execute_readonly_query right away with a SELECT that uses only the tables and columns listed above. Do not call list_tables or get_table_columns for tables listed above.
${SHARED_RULES}
`.trim();
}

export const STEP_LIMIT_NOTICE =
  'Tool step limit reached. Answer the user now using the tool results above, without calling any more tools.';
export const STEP_LIMIT_ANSWER = 'I could not finish this request within the tool step limit.';

export interface ChatTurnDeps {
  llm: LLMProvider;
  store: ConversationStore;
  tools: Tools;
  /** Refuses a turn once its user or IP is over budget, and is charged every LLM reply. Unlimited by default. */
  budget?: TokenBudget;
  maxToolSteps?: number;
  contextMessages?: number;
  /**
   * Schema context read each turn for the system prompt (see `buildSystemPrompt`), such as the
   * database schema overview the MCP servers serve, so the model can write SQL without lookup
   * steps. None by default.
   */
  readContext?: () => Promise<string>;
}

export interface TurnRequest {
  sessionId?: string;
  /** The authenticated user; owns new sessions and must own existing ones. */
  userId: string;
  message: string;
  /** The client's IP, charged alongside the user for token budgets. */
  clientIp?: string;
}

export interface ToolStep {
  call: LLMToolCall;
  result: ToolOutcome;
}

export interface TurnResult {
  sessionId: string;
  answer: string;
  toolSteps: ToolStep[];
}

export interface ChatTurn {
  /**
   * Records the user message, runs the LLM/tool loop, records and returns the answer.
   * Throws `TokenBudgetExceededError` before anything is recorded when the budget is used up.
   */
  handle(request: TurnRequest): Promise<TurnResult>;
  /** The session's recent messages; empty when it doesn't exist yet. Throws `SessionNotFoundError` if another user owns it. */
  getHistory(userId: string, sessionId: string, limit?: number): Promise<ChatMessage[]>;
  /** Deletes the session if it exists. Throws `SessionNotFoundError` if another user owns it. */
  clearSession(userId: string, sessionId: string): Promise<void>;
}

export function resolveSessionId(request: Pick<TurnRequest, 'sessionId' | 'userId'>): string {
  return request.sessionId || request.userId;
}

export function createChatTurn(deps: ChatTurnDeps): ChatTurn {
  const { llm, store, tools } = deps;
  const budget = deps.budget ?? UNLIMITED_BUDGET;
  const maxToolSteps = deps.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS;
  const contextMessages = deps.contextMessages ?? DEFAULT_CONTEXT_MESSAGES;
  const readContext = deps.readContext ?? (async () => '');

  const runToolLoop = async (initial: Message[], context: ToolContext, meter: TurnMeter) => {
    // Charged per reply, so tokens spent before a later failure are still counted.
    const ask = async (conversation: Message[]): Promise<ChatReply> => {
      const reply = await llm.chat(conversation, tools.definitions);
      await meter.charge(reply);
      return reply;
    };
    let messages = initial;
    let toolSteps: ToolStep[] = [];

    for (let step = 0; step < maxToolSteps; step += 1) {
      const reply = await ask(messages);
      if (reply.toolCalls.length === 0) {
        return { answer: reply.content, toolSteps };
      }

      const steps: ToolStep[] = [];
      for (const call of reply.toolCalls) {
        steps.push({ call, result: await tools.call(call, context) });
      }
      toolSteps = [...toolSteps, ...steps];
      messages = [
        ...messages,
        { role: 'assistant', content: reply.content, toolCalls: reply.toolCalls, providerState: reply.providerState },
        ...steps.map(toToolResultMessage),
      ];
    }

    // Tools stay declared: providers reject tool history without tool definitions.
    const final = await ask([...messages, { role: 'user', content: STEP_LIMIT_NOTICE }]);
    // Text alongside more tool calls is a preamble ("Let me check…"), not an answer.
    const answered = final.toolCalls.length === 0 && final.content;
    return { answer: answered ? final.content : STEP_LIMIT_ANSWER, toolSteps };
  };

  return {
    async handle(request) {
      const { userId } = request;
      const meter = await budget.openTurn({ userId, clientIp: request.clientIp });
      const sessionId = resolveSessionId(request);
      const session = await store.openSession(sessionId, userId);
      await session.append('user', request.message);

      // History already ends with the user message just appended.
      const history = await session.recent(contextMessages);
      const { answer, toolSteps } = await runToolLoop(
        [{ role: 'system', content: buildSystemPrompt(await readContext()) }, ...toModelMessages(history)],
        { sessionId, userId },
        meter,
      );

      await recordAnswer(session, toolSteps, answer);
      return { sessionId, answer, toolSteps };
    },

    async getHistory(userId, sessionId, limit) {
      const session = await store.findOwnedSession(sessionId, userId);
      return session ? session.recent(limit, VISIBLE_ROLES) : [];
    },

    async clearSession(userId, sessionId) {
      await (await store.findOwnedSession(sessionId, userId))?.clear();
    },
  };
}

/** Stores the turn's tool record, when it used tools, and then its answer. */
async function recordAnswer(session: OwnedSession, toolSteps: readonly ToolStep[], answer: string): Promise<void> {
  if (toolSteps.length > 0) {
    await session.append('tool', summarizeToolSteps(toolSteps));
  }
  await session.append('assistant', answer);
}

function toToolResultMessage(step: ToolStep): ToolResultMessage {
  const { call, result } = step;
  return {
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    ...(result.ok ? { content: JSON.stringify(result.result ?? null) } : { content: result.error, isError: true }),
  };
}

/** One line per tool call, results cut to `MAX_TOOL_RESULT_CHARS`: what later turns see of this turn's tools. */
export function summarizeToolSteps(steps: readonly ToolStep[]): string {
  return steps.map(({ call, result }) => {
    const outcome = result.ok
      ? `ok: ${truncate(JSON.stringify(result.result ?? null))}`
      : `error: ${truncate(result.error)}`;
    return `- ${call.name}(${JSON.stringify(call.arguments)}) → ${outcome}`;
  }).join('\n');
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… (truncated)` : text;
}

/**
 * Maps stored history to model messages; providers such as Anthropic require a user message first.
 * A turn's tool record is folded into its answer, so earlier tool results stay in context
 * without breaking the user/assistant alternation. Stored system rows are not replayed.
 */
function toModelMessages(history: readonly ChatMessage[]): Message[] {
  const firstUser = history.findIndex((entry) => entry.role === 'user');
  const conversation = firstUser === -1 ? [] : history.slice(firstUser);
  const messages: Message[] = [];
  let toolRecord: string | undefined;
  for (const entry of conversation) {
    switch (entry.role) {
      case 'user':
        toolRecord = undefined;
        messages.push({ role: 'user', content: entry.content });
        break;
      case 'tool':
        toolRecord = entry.content;
        break;
      case 'assistant':
        messages.push({ role: 'assistant', content: withToolRecord(entry.content, toolRecord) });
        toolRecord = undefined;
        break;
      case 'system':
        break;
    }
  }
  return messages;
}

function withToolRecord(answer: string, toolRecord: string | undefined): string {
  return toolRecord ? `${TOOL_RECORD_HEADING}\n${toolRecord}\n\n${answer}` : answer;
}
