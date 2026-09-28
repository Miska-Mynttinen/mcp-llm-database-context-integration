const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, scriptedLLM } = require('./helpers');

const { withTextToolProtocol, toTextMessages } = dist('src/llm/textToolProtocol');
const { LLMMalformedToolCallError } = dist('src/llm/errors');

const malformed = () => new LLMMalformedToolCallError('function_call_filter: MALFORMED_FUNCTION_CALL');

const tools = [{ name: 'lookup', description: 'Look up a key', inputSchema: { type: 'object', properties: { key: {} } } }];

test('describes tools in the system prompt and sends no native tools', async () => {
  const inner = scriptedLLM(['plain answer']);
  const reply = await withTextToolProtocol(inner).chat(
    [{ role: 'system', content: 'Base rules.' }, { role: 'user', content: 'hi' }],
    tools,
  );

  assert.deepEqual(reply.toolCalls, []);
  assert.equal(reply.content, 'plain answer');
  const [system] = inner.requests[0].messages;
  assert.match(system.content, /^Base rules\.\n\nTool use:/);
  assert.match(system.content, /- lookup: Look up a key\n {2}arguments: \{"type":"object"/);
  assert.match(system.content, /Native function calling is not available/);
  assert.deepEqual(inner.requests[0].tools, []);
});

test('turns a JSON reply naming a known tool into a tool call', async () => {
  const inner = scriptedLLM([
    '{"name":"lookup","arguments":{"key":"x"}}',
    '```json\n{"name":"lookup","arguments":{"key":"y"}}\n```',
  ]);
  const provider = withTextToolProtocol(inner);

  const bare = await provider.chat([{ role: 'user', content: 'x?' }], tools);
  const fenced = await provider.chat([{ role: 'user', content: 'y?' }], tools);

  assert.deepEqual(bare.toolCalls, [{ id: 'text-call-1', name: 'lookup', arguments: { key: 'x' } }]);
  assert.equal(bare.content, '');
  assert.deepEqual(fenced.toolCalls[0].arguments, { key: 'y' });
});

test('finds a tool call written inside prose, and ignores prose without one', async () => {
  const inner = scriptedLLM([
    'I will look it up now: {"name":"lookup","arguments":{"key":"a \\"}\\" b"}} and then answer.',
    'I will use the lookup tool to find {the key}.',
  ]);
  const provider = withTextToolProtocol(inner);

  const embedded = await provider.chat([{ role: 'user', content: 'a?' }], tools);
  assert.deepEqual(embedded.toolCalls.map((c) => [c.name, c.arguments]), [['lookup', { key: 'a "}" b' }]]);
  const prose = await provider.chat([{ role: 'user', content: 'b?' }], tools);
  assert.deepEqual(prose.toolCalls, []);
});

test('keeps a native tool call the model makes despite no declared tools, one per reply', async () => {
  const inner = scriptedLLM([{
    toolCalls: [
      { id: 'native-1', name: 'lookup', arguments: { key: 'z' } },
      { id: 'native-2', name: 'lookup', arguments: { key: 'w' } },
    ],
  }]);

  const reply = await withTextToolProtocol(inner).chat([{ role: 'user', content: 'z?' }], tools);

  assert.deepEqual(reply.toolCalls, [{ id: 'text-call-1', name: 'lookup', arguments: { key: 'z' } }]);
  assert.equal(reply.content, '');
});

test('retries a rejected native call once, nudging toward plain-text JSON', async () => {
  const inner = scriptedLLM([malformed(), '{"name":"lookup","arguments":{"key":"x"}}']);

  const reply = await withTextToolProtocol(inner).chat([{ role: 'user', content: 'x?' }], tools);

  assert.deepEqual(reply.toolCalls.map((c) => [c.name, c.arguments]), [['lookup', { key: 'x' }]]);
  assert.equal(inner.requests.length, 2);
  assert.equal(inner.requests[0].messages.at(-1).content, 'x?');
  const nudge = inner.requests[1].messages.at(-1);
  assert.equal(nudge.role, 'user');
  assert.match(nudge.content, /Function calling is not available/);
});

test('gives up after a second rejected native call', async () => {
  const inner = scriptedLLM([malformed(), malformed()]);

  await assert.rejects(
    withTextToolProtocol(inner).chat([{ role: 'user', content: 'x?' }], tools),
    LLMMalformedToolCallError,
  );
  assert.equal(inner.requests.length, 2);
});

test('does not retry other errors', async () => {
  const inner = scriptedLLM([new Error('boom')]);

  await assert.rejects(withTextToolProtocol(inner).chat([{ role: 'user', content: 'x?' }], tools), /boom/);
  assert.equal(inner.requests.length, 1);
});

test('treats JSON naming an unknown tool, or any JSON without tools, as a plain answer', async () => {
  const unknown = '{"name":"not_a_tool","arguments":{}}';
  const inner = scriptedLLM([unknown, '{"name":"lookup"}']);
  const provider = withTextToolProtocol(inner);

  assert.deepEqual((await provider.chat([{ role: 'user', content: 'a' }], tools)).toolCalls, []);
  const noTools = await provider.chat([{ role: 'user', content: 'b' }]);
  assert.deepEqual([noTools.content, noTools.toolCalls], ['{"name":"lookup"}', []]);
});

test('rewrites assistant tool calls and tool results as text messages', () => {
  const messages = toTextMessages([
    { role: 'user', content: 'x?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup', arguments: { key: 'x' } }], providerState: { opaque: true } },
    { role: 'tool', toolCallId: 't1', toolName: 'lookup', content: '42' },
    { role: 'tool', toolCallId: 't2', toolName: 'lookup', content: 'missing', isError: true },
  ], []);

  assert.deepEqual(messages, [
    { role: 'user', content: 'x?' },
    { role: 'assistant', content: '{"name":"lookup","arguments":{"key":"x"}}' },
    { role: 'user', content: 'Tool result for lookup (ok):\n42' },
    { role: 'user', content: 'Tool result for lookup (error):\nmissing' },
  ]);
});

test('adds a system message when the conversation has none', () => {
  const [first] = toTextMessages([{ role: 'user', content: 'hi' }], tools);
  assert.equal(first.role, 'system');
  assert.match(first.content, /^Tool use:/);
});
