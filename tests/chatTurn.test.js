const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, scriptedLLM, connectTempSqlite, openAppStorage } = require('./helpers');

const {
  createChatTurn, buildSystemPrompt, SessionNotFoundError, SYSTEM_PROMPT, STEP_LIMIT_ANSWER, MAX_TOOL_RESULT_CHARS, TOOL_RECORD_HEADING,
} = dist('src/chat/chatTurn');
const { InMemoryConversationStore } = dist('src/chat/stores/inMemoryConversationStore');
const { createTools } = dist('src/tools/tools');
const { createTokenBudget, InMemoryTokenUsageStore, TokenBudgetExceededError } = dist('src/tokenBudget');

function recordingTools(handlers) {
  const calls = [];
  return {
    calls,
    definitions: Object.keys(handlers).map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    async execute(name, args, context) {
      calls.push({ name, args, context });
      return handlers[name](args);
    },
  };
}

const call = (id, name, args = {}) => ({ id, name, arguments: args });
const newTurn = (llm, tools = recordingTools({}), extra = {}) =>
  createChatTurn({ llm, store: new InMemoryConversationStore(), tools: createTools([tools]), ...extra });

test('answers directly when the model does not call a tool', async () => {
  const llm = scriptedLLM(['Hello there.']);
  const chat = newTurn(llm);

  const result = await chat.handle({ userId: 'u1', sessionId: 's1', message: 'Hi' });

  assert.deepEqual(result, {
    sessionId: 's1',
    answer: 'Hello there.',
    toolSteps: [],
  });
  assert.deepEqual((await chat.getHistory('u1', 's1')).map((m) => [m.role, m.content]), [['user', 'Hi'], ['assistant', 'Hello there.']]);
});

test('sends the system prompt, the user message once, and the tool definitions', async () => {
  const llm = scriptedLLM(['ok']);
  const tools = recordingTools({ lookup: () => 1 });
  await newTurn(llm, tools).handle({ userId: 'u1', sessionId: 's1', message: 'unique question' });

  const { messages, tools: sentTools } = llm.requests[0];
  assert.deepEqual(messages[0], { role: 'system', content: SYSTEM_PROMPT });
  assert.equal(messages.filter((m) => m.content === 'unique question').length, 1);
  assert.deepEqual(sentTools.map((tool) => tool.name), ['lookup']);
});

test('puts the context it reads each turn, such as the schema overview, in the system prompt', async () => {
  const llm = scriptedLLM(['ok', 'ok']);
  const contexts = ['Database schema (sqlite):\n- shipment(id INTEGER)', ''];
  const chat = newTurn(llm, recordingTools({}), { readContext: async () => contexts.shift() });

  await chat.handle({ userId: 'u1', sessionId: 's1', message: 'first' });
  await chat.handle({ userId: 'u1', sessionId: 's1', message: 'second' });

  const [withSchema] = llm.requests[0].messages;
  assert.deepEqual(withSchema, { role: 'system', content: buildSystemPrompt('Database schema (sqlite):\n- shipment(id INTEGER)') });
  // The schema comes before the rules, which send the model straight to a query.
  assert.ok(withSchema.content.indexOf('- shipment(id INTEGER)') < withSchema.content.indexOf('Rules:'));
  assert.match(withSchema.content, /call execute_readonly_query right away/);
  assert.doesNotMatch(withSchema.content, /Before writing SQL, call get_table_columns/);
  assert.deepEqual(llm.requests[1].messages[0], { role: 'system', content: SYSTEM_PROMPT });
  assert.match(SYSTEM_PROMPT, /Before writing SQL, call get_table_columns/);
});

test('runs a tool call and continues with assistant and tool messages', async () => {
  const providerState = [{ type: 'thinking', thinking: '', signature: 'sig' }];
  const llm = scriptedLLM([
    { content: 'Checking.', toolCalls: [call('c1', 'lookup', { key: 'x' })], providerState },
    'The value is 42.',
  ]);
  const tools = recordingTools({ lookup: () => ({ value: 42 }) });

  const result = await newTurn(llm, tools).handle({ userId: 'u1', message: 'What is x?' });

  assert.equal(result.sessionId, 'u1');
  assert.equal(result.answer, 'The value is 42.');
  assert.deepEqual(result.toolSteps, [{
    call: call('c1', 'lookup', { key: 'x' }),
    result: { ok: true, name: 'lookup', result: { value: 42 } },
  }]);
  assert.deepEqual(tools.calls[0].context, { sessionId: 'u1', userId: 'u1' });

  const followUp = llm.requests[1].messages.slice(-2);
  assert.deepEqual(followUp, [
    { role: 'assistant', content: 'Checking.', toolCalls: [call('c1', 'lookup', { key: 'x' })], providerState },
    { role: 'tool', toolCallId: 'c1', toolName: 'lookup', content: '{"value":42}' },
  ]);
});

test('runs parallel tool calls from one reply and returns every result', async () => {
  const llm = scriptedLLM([{ toolCalls: [call('a1', 'a'), call('b1', 'b')] }, 'done']);
  const tools = recordingTools({ a: () => 'A', b: () => 'B' });

  const result = await newTurn(llm, tools).handle({ userId: 'u1', message: 'both' });

  assert.deepEqual(result.toolSteps.map((step) => step.call.id), ['a1', 'b1']);
  const toolMessages = llm.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => [m.toolCallId, m.content]), [['a1', '"A"'], ['b1', '"B"']]);
  assert.equal(result.sessionId, 'u1');
});

test('stops at the step cap, keeps tools declared, and asks for a final answer', async () => {
  const llm = scriptedLLM([{ toolCalls: [call('1', 'a')] }, { toolCalls: [call('2', 'a')] }, 'final']);
  const tools = recordingTools({ a: () => 1 });

  const result = await newTurn(llm, tools, { maxToolSteps: 2 }).handle({ userId: 'u1', message: 'loop' });

  assert.equal(result.toolSteps.length, 2);
  assert.equal(result.answer, 'final');
  assert.match(llm.requests[2].messages.at(-1).content, /step limit/i);
  assert.equal(llm.requests[2].tools.length, 1);
});

test('falls back to a fixed answer when the model keeps calling tools past the cap', async () => {
  const llm = scriptedLLM([{ toolCalls: [call('1', 'a')] }, { toolCalls: [call('2', 'a')] }]);
  const result = await newTurn(llm, recordingTools({ a: () => 1 }), { maxToolSteps: 1 }).handle({ userId: 'u1', message: 'x' });
  assert.equal(result.answer, STEP_LIMIT_ANSWER);
});

test('does not store a preamble as the answer when the final reply still calls tools', async () => {
  const llm = scriptedLLM([
    { toolCalls: [call('1', 'a')] },
    { content: 'Let me check the columns first.', toolCalls: [call('2', 'a')] },
  ]);
  const result = await newTurn(llm, recordingTools({ a: () => 1 }), { maxToolSteps: 1 }).handle({ userId: 'u1', message: 'x' });
  assert.equal(result.answer, STEP_LIMIT_ANSWER);
});

test('reports tool failures to the model as error results', async () => {
  const llm = scriptedLLM([{ toolCalls: [call('c1', 'boom')] }, 'Sorry, that failed.']);
  const tools = recordingTools({ boom: () => { throw new Error('kaput'); } });

  const result = await newTurn(llm, tools).handle({ userId: 'u1', message: 'x' });

  assert.deepEqual(result.toolSteps[0].result, { ok: false, name: 'boom', error: 'kaput' });
  assert.deepEqual(llm.requests[1].messages.at(-1), {
    role: 'tool', toolCallId: 'c1', toolName: 'boom', content: 'kaput', isError: true,
  });
  assert.equal(result.answer, 'Sorry, that failed.');
});

test('does not run a call whose arguments failed to parse', async () => {
  const bad = { ...call('c1', 'lookup'), argumentsError: 'Tool arguments are not valid JSON: {' };
  const llm = scriptedLLM([{ toolCalls: [bad] }, 'ok']);
  const tools = recordingTools({ lookup: () => 1 });

  const result = await newTurn(llm, tools).handle({ userId: 'u1', message: 'x' });

  assert.equal(tools.calls.length, 0);
  assert.equal(result.toolSteps[0].result.ok, false);
  assert.match(result.toolSteps[0].result.error, /not valid JSON/);
});

test('stores a tool record before the answer and replays it to later turns, but not to history readers', async () => {
  const store = new InMemoryConversationStore();
  const llm = scriptedLLM([
    { content: '', toolCalls: [call('c1', 'list_tables'), call('c2', 'lookup', { key: 'x' })] },
    'The table is shipment.',
    'Using shipment again.',
  ]);
  const tools = recordingTools({ list_tables: () => ['shipment'], lookup: () => { throw new Error('no such key'); } });
  const turn = createChatTurn({ llm, store, tools: createTools([tools]) });

  await turn.handle({ userId: 'u1', sessionId: 's1', message: 'Which tables?' });
  const session = await store.findOwnedSession('s1', 'u1');
  const stored = await session.recent();
  assert.deepEqual(stored.map((m) => m.role), ['user', 'tool', 'assistant']);
  assert.equal(stored[1].content, [
    '- list_tables({}) → ok: ["shipment"]',
    '- lookup({"key":"x"}) → error: no such key',
  ].join('\n'));

  await turn.handle({ userId: 'u1', sessionId: 's1', message: 'And again?' });
  assert.deepEqual(llm.requests[2].messages.slice(1), [
    { role: 'user', content: 'Which tables?' },
    { role: 'assistant', content: `${TOOL_RECORD_HEADING}\n${stored[1].content}\n\nThe table is shipment.` },
    { role: 'user', content: 'And again?' },
  ]);

  const history = await turn.getHistory('u1', 's1');
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('cuts long tool results in the stored tool record', async () => {
  const store = new InMemoryConversationStore();
  const llm = scriptedLLM([{ content: '', toolCalls: [call('c1', 'dump')] }, 'Done.']);
  const tools = recordingTools({ dump: () => 'x'.repeat(MAX_TOOL_RESULT_CHARS * 2) });
  await createChatTurn({ llm, store, tools: createTools([tools]) }).handle({ userId: 'u1', message: 'dump' });

  const [, record] = await (await store.findOwnedSession('u1', 'u1')).recent();
  assert.equal(record.role, 'tool');
  assert.ok(record.content.length < MAX_TOOL_RESULT_CHARS + 100);
  assert.match(record.content, /… \(truncated\)$/);
});

test('starts model context at a user message when history is truncated', async () => {
  const store = new InMemoryConversationStore();
  const session = await store.openSession('s1', 'u1');
  await session.append('user', 'old question');
  await session.append('assistant', 'old answer');
  const llm = scriptedLLM(['new answer']);
  await createChatTurn({ llm, store, tools: createTools([recordingTools({})]), contextMessages: 2 }).handle({ userId: 'u1', sessionId: 's1', message: 'new' });
  assert.deepEqual(llm.requests[0].messages.slice(1).map((m) => m.role), ['user']);
});

test('a session belongs to the user who created it', async () => {
  const store = new InMemoryConversationStore();
  const llm = scriptedLLM(['mine', 'still mine']);
  const chat = createChatTurn({ llm, store, tools: createTools([recordingTools({})]) });
  await chat.handle({ userId: 'alice', sessionId: 's1', message: 'hello' });

  await assert.rejects(chat.handle({ userId: 'mallory', sessionId: 's1', message: 'let me in' }), SessionNotFoundError);
  await assert.rejects(chat.getHistory('mallory', 's1'), SessionNotFoundError);
  await assert.rejects(chat.clearSession('mallory', 's1'), SessionNotFoundError);
  assert.equal(llm.requests.length, 1, 'the model never saw the intruding message');
  assert.equal((await chat.getHistory('alice', 's1')).length, 2);

  await chat.handle({ userId: 'alice', sessionId: 's1', message: 'again' });
  assert.equal((await chat.getHistory('alice', 's1')).length, 4);
});

test('sessions without an owner are not accessible', async (t) => {
  // Only a database can hold sessions from before per-user history.
  const { database, cleanup } = await connectTempSqlite('legacy-session');
  t.after(cleanup);
  const store = (await openAppStorage(database)).conversations;
  await database.query("INSERT INTO chat_sessions (id, user_id, created_at, updated_at) VALUES ('legacy', NULL, 'x', 'x')");
  const chat = createChatTurn({ llm: scriptedLLM([]), store, tools: createTools([recordingTools({})]) });
  await assert.rejects(chat.getHistory('alice', 'legacy'), SessionNotFoundError);
  await assert.rejects(chat.handle({ userId: 'alice', sessionId: 'legacy', message: 'x' }), SessionNotFoundError);
});

test('history and clear of a session that does not exist yet are empty no-ops', async () => {
  const chat = newTurn(scriptedLLM([]));
  assert.deepEqual(await chat.getHistory('alice', 'new'), []);
  await chat.clearSession('alice', 'new');
});

// --- Token budget ---

const usage = (total) => ({ promptTokens: total, completionTokens: 0, totalTokens: total });
const TODAY = '2026-01-01';
const ALICE = { userId: 'alice', ip: '1.2.3.4' };

/** A chat turn with a daily budget on an in-memory usage store, on a fixed day. */
function budgetedTurn(llm, budgets, tools = recordingTools({ lookup: () => 'ok' })) {
  const usageStore = new InMemoryTokenUsageStore();
  const budget = createTokenBudget(budgets, usageStore, { now: () => new Date(`${TODAY}T12:00:00Z`) });
  const store = new InMemoryConversationStore();
  return { chat: createChatTurn({ llm, store, tools: createTools([tools]), budget }), usageStore, store };
}

test('charges every LLM reply in the turn to the user and client IP', async () => {
  const llm = scriptedLLM([{ toolCalls: [call('c1', 'lookup')], usage: usage(110) }, { content: 'Done.', usage: usage(170) }]);
  const { chat, usageStore } = budgetedTurn(llm, { user: 1000 });

  await chat.handle({ userId: 'alice', clientIp: '1.2.3.4', sessionId: 's1', message: 'Look it up' });

  assert.deepEqual(await usageStore.usedOn(TODAY, ALICE), { user: 280, ip: 280, global: 280 });
});

test('a turn that fails part-way is still charged for the replies it got', async () => {
  // The second LLM call throws: the scripted model has run out of replies.
  const llm = scriptedLLM([{ toolCalls: [call('c1', 'lookup')], usage: usage(90) }]);
  const { chat, usageStore } = budgetedTurn(llm, { user: 1000 });

  await assert.rejects(chat.handle({ userId: 'alice', clientIp: '1.2.3.4', sessionId: 's1', message: 'x' }));

  assert.equal((await usageStore.usedOn(TODAY, ALICE)).user, 90);
});

test('refuses a turn once the budget is used up, before recording or asking anything', async () => {
  const llm = scriptedLLM([{ content: 'first', usage: usage(100) }, 'never sent']);
  const { chat, store } = budgetedTurn(llm, { user: 100 });
  await chat.handle({ userId: 'alice', clientIp: '1.2.3.4', sessionId: 's1', message: 'a' });

  const refused = chat.handle({ userId: 'alice', clientIp: '1.2.3.4', sessionId: 's1', message: 'b' });

  await assert.rejects(refused, (error) => error instanceof TokenBudgetExceededError && error.scope === 'user');
  assert.equal(llm.requests.length, 1);
  assert.deepEqual((await (await store.findOwnedSession('s1', 'alice')).recent()).map((m) => m.content), ['a', 'first']);
});

test('the IP budget spans users, and a missing client IP is charged as "unknown"', async () => {
  const llm = scriptedLLM([{ content: 'one', usage: usage(50) }, { content: 'two', usage: usage(5) }]);
  const { chat, usageStore } = budgetedTurn(llm, { ip: 50 });
  await chat.handle({ userId: 'alice', clientIp: '1.2.3.4', message: 'a' });

  await assert.rejects(chat.handle({ userId: 'bob', clientIp: '1.2.3.4', message: 'b' }), TokenBudgetExceededError);
  await chat.handle({ userId: 'bob', message: 'c' });
  assert.equal((await usageStore.usedOn(TODAY, { userId: 'bob', ip: 'unknown' })).ip, 5);
});

test('without a budget, usage is neither checked nor charged', async () => {
  const llm = scriptedLLM([{ content: 'big', usage: usage(1e9) }, { content: 'again', usage: usage(1e9) }]);
  const chat = newTurn(llm);
  await chat.handle({ userId: 'alice', message: 'a' });
  await chat.handle({ userId: 'alice', message: 'b' });
  assert.equal(llm.requests.length, 2);
});
