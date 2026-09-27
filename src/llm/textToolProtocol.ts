import { toToolCall } from './toolArguments';
import { type ChatReply, type LLMProvider, type LLMToolCall, type Message, type ToolResultMessage, type ToolSpec } from './types';

/**
 * Tool calling for models without native support: tools are described in the system
 * prompt, the model replies with a bare (or ```json-fenced) JSON object naming a tool,
 * and results come back as user messages. One tool call per reply.
 */
export function withTextToolProtocol(inner: LLMProvider): LLMProvider {
  let callCounter = 0;

  return {
    async chat(messages, tools = []) {
      const reply = await inner.chat(toTextMessages(messages, tools));
      if (tools.length === 0) {
        return { ...reply, toolCalls: [] };
      }

      const call = parseToolCallText(reply.content, new Set(tools.map((tool) => tool.name)));
      if (!call) {
        return { ...reply, toolCalls: [] };
      }

      callCounter += 1;
      const toolCall = toToolCall(`text-call-${callCounter}`, call.name, call.arguments);
      return { content: '', toolCalls: [toolCall], usage: reply.usage } satisfies ChatReply;
    },
    close: () => inner.close(),
  };
}

export function buildToolInstructions(tools: readonly ToolSpec[]): string {
  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  arguments: ${JSON.stringify(tool.inputSchema)}`)
    .join('\n');

  return `
Tool use:
- When a tool is needed, respond only with a JSON object shaped like:
  { "name": "tool_name", "arguments": { ... } }
- When you need a tool, reply with the JSON object right away. Never describe or announce a
  tool call in words, and never ask for permission first.
- Call one tool per reply. After each call you receive its result.
- When no tool is needed, answer normally in natural language.

Available tools:
${toolList}
  `.trim();
}

/** Rewrites a native-style conversation into plain system/user/assistant text messages. */
export function toTextMessages(messages: readonly Message[], tools: readonly ToolSpec[]): Message[] {
  const converted = messages.map((message): Message => {
    switch (message.role) {
      case 'assistant':
        return { role: 'assistant', content: assistantText(message.content, message.toolCalls) };
      case 'tool':
        return { role: 'user', content: formatToolResult(message) };
      default:
        return message;
    }
  });

  if (tools.length === 0) {
    return converted;
  }

  const instructions = buildToolInstructions(tools);
  const systemIndex = converted.findIndex((message) => message.role === 'system');
  if (systemIndex === -1) {
    return [{ role: 'system', content: instructions }, ...converted];
  }
  return converted.map((message, index) =>
    index === systemIndex ? { role: 'system', content: `${message.content}\n\n${instructions}` } : message);
}

/**
 * Returns a tool call only when the reply is JSON naming one of `knownTools`: the whole reply,
 * a ```json block, or failing those the first such JSON object inside prose ("Let me check: {...}").
 */
export function parseToolCallText(
  content: string,
  knownTools: ReadonlySet<string>,
): { name: string; arguments: unknown } | null {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, content.trim(), ...embeddedObjects(content)];
  for (const candidate of candidates) {
    const call = candidate ? asToolCall(candidate, knownTools) : null;
    if (call) {
      return call;
    }
  }
  return null;
}

function asToolCall(candidate: string, knownTools: ReadonlySet<string>): { name: string; arguments: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown };
  if (typeof name !== 'string' || !knownTools.has(name)) {
    return null;
  }
  return { name, arguments: args };
}

/** Every outermost balanced `{...}` span in `text`, in order; braces inside JSON strings are skipped. */
function embeddedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push(text.slice(start, index + 1));
    }
  }
  return spans;
}

export function formatToolResult(message: ToolResultMessage): string {
  const status = message.isError ? 'error' : 'ok';
  return `Tool result for ${message.toolName} (${status}):\n${message.content}`;
}

function assistantText(content: string, toolCalls: readonly LLMToolCall[] = []): string {
  const calls = toolCalls.map((call) => JSON.stringify({ name: call.name, arguments: call.arguments }));
  return [content, ...calls].filter(Boolean).join('\n');
}
