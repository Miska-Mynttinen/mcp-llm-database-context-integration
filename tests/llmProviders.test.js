// Each adapter runs its real SDK/HTTP client against a local stub that returns the documented
// response shapes, so these tests pin the wire format each provider sends and parses.
const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, startStubServer } = require('./helpers');

const { OpenAIProvider, AnthropicProvider, OllamaProvider, LLMRateLimitError, LLMUnavailableError, LLMMalformedToolCallError, createLLMProvider, readLLMConfigFromEnv } = dist('src/llm');
const { REFUSAL_ANSWER } = dist('src/llm/providers/anthropic');

const tools = [{
  name: 'get_table_columns',
  description: 'Fetch columns',
  inputSchema: { type: 'object', properties: { tableName: { type: 'string' } }, required: ['tableName'] },
}];

const conversationAfterToolCall = (reply) => [
  { role: 'system', content: 'Be helpful.' },
  { role: 'user', content: 'Columns of users?' },
  { role: 'assistant', content: reply.content, toolCalls: reply.toolCalls, providerState: reply.providerState },
  { role: 'tool', toolCallId: reply.toolCalls[0].id, toolName: 'get_table_columns', content: '{"columns":["id"]}' },
];

// --- OpenAI Chat Completions ---------------------------------------------------------------

function openAICompletion(message, finishReason = 'stop') {
  return {
    id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

test('openai: sends function tools and parses tool_calls with string arguments', async (t) => {
  const stub = await startStubServer((request, count) => ({
    body: count === 1
      ? openAICompletion({
        content: null,
        tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_table_columns', arguments: '{"tableName":"users"}' } }],
      }, 'tool_calls')
      : openAICompletion({ content: 'users has id.' }),
  }));
  t.after(stub.close);
  const provider = new OpenAIProvider('test-key', 'gpt-test', stub.url);

  const first = await provider.chat([{ role: 'user', content: 'Columns of users?' }], tools);
  assert.deepEqual(first.toolCalls, [{ id: 'call_abc', name: 'get_table_columns', arguments: { tableName: 'users' } }]);
  assert.equal(first.content, '');
  assert.deepEqual(stub.requests[0].body.tools, [{
    type: 'function',
    function: { name: 'get_table_columns', description: 'Fetch columns', parameters: tools[0].inputSchema },
  }]);

  const second = await provider.chat(conversationAfterToolCall(first), tools);
  assert.equal(second.content, 'users has id.');
  assert.deepEqual(stub.requests[1].body.messages.slice(2), [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_table_columns', arguments: '{"tableName":"users"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_abc', content: '{"columns":["id"]}' },
  ]);
});

test('openai: sends Gemini\'s thought signature back with the tool call', async (t) => {
  const extraContent = { google: { thought_signature: 'sig-1' } };
  const stub = await startStubServer((request, count) => ({
    body: count === 1
      ? openAICompletion({
        content: null,
        tool_calls: [{
          id: 'call_g', type: 'function', extra_content: extraContent,
          function: { name: 'get_table_columns', arguments: '{"tableName":"users"}' },
        }],
      }, 'tool_calls')
      : openAICompletion({ content: 'users has id.' }),
  }));
  t.after(stub.close);
  const provider = new OpenAIProvider('test-key', 'gemini-test', stub.url);

  const first = await provider.chat([{ role: 'user', content: 'Columns of users?' }], tools);
  await provider.chat(conversationAfterToolCall(first), tools);

  assert.deepEqual(stub.requests[1].body.messages[2].tool_calls[0].extra_content, extraContent);
});

test('openai: omits tools when none are given and flags malformed arguments', async (t) => {
  const stub = await startStubServer(() => ({
    body: openAICompletion({
      content: null,
      tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'get_table_columns', arguments: '{"tableName":' } }],
    }, 'tool_calls'),
  }));
  t.after(stub.close);
  const provider = new OpenAIProvider('test-key', 'gpt-test', stub.url);

  const reply = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.equal('tools' in stub.requests[0].body, false);
  assert.match(reply.toolCalls[0].argumentsError, /not valid JSON/);
});

test('openai: rejects a whitespace-only reply and names the finish reason', async (t) => {
  const stub = await startStubServer(() => ({ body: openAICompletion({ content: '\n' }, 'length') }));
  t.after(stub.close);
  const provider = new OpenAIProvider('test-key', 'gpt-test', stub.url);

  await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), /no text \(finish_reason: length\)/);
});

test('openai: flags a native call the provider blocked as malformed', async (t) => {
  const finishReason = 'function_call_filter: MALFORMED_FUNCTION_CALL';
  const stub = await startStubServer(() => ({ body: openAICompletion({ content: null }, finishReason) }));
  t.after(stub.close);
  const provider = new OpenAIProvider('test-key', 'gpt-test', stub.url);

  await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error) =>
    error instanceof LLMMalformedToolCallError && error.finishReason === finishReason);
});

// --- Anthropic Messages --------------------------------------------------------------------

function anthropicMessage(content, stopReason, extra = {}) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 6 }, ...extra,
  };
}

test('anthropic: sends tools with input_schema, echoes content blocks, groups tool results', async (t) => {
  const firstContent = [
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_table_columns', input: { tableName: 'users' } },
    { type: 'tool_use', id: 'toolu_2', name: 'get_table_columns', input: { tableName: 'orders' } },
  ];
  const stub = await startStubServer((request, count) => ({
    body: count === 1 ? anthropicMessage(firstContent, 'tool_use') : anthropicMessage([{ type: 'text', text: 'Done.' }], 'end_turn'),
  }));
  t.after(stub.close);
  const provider = new AnthropicProvider('test-key', 'claude-opus-5', stub.url);

  const first = await provider.chat([
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'Columns of users?' },
  ], tools);

  const sent = stub.requests[0];
  assert.equal(sent.path, '/v1/messages?beta=true');
  assert.equal(sent.body.system, 'Be helpful.');
  assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'Columns of users?' }]);
  assert.deepEqual(sent.body.tools, [{ name: 'get_table_columns', description: 'Fetch columns', input_schema: tools[0].inputSchema }]);
  assert.equal(sent.body.fallbacks, 'default');
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(first.content, 'Let me check.');
  assert.deepEqual(first.toolCalls.map((c) => c.id), ['toolu_1', 'toolu_2']);

  await provider.chat([
    ...conversationAfterToolCall(first),
    { role: 'tool', toolCallId: 'toolu_2', toolName: 'get_table_columns', content: 'no such table', isError: true },
  ], tools);

  assert.deepEqual(stub.requests[1].body.messages.slice(1), [
    { role: 'assistant', content: firstContent },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"columns":["id"]}' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'no such table', is_error: true },
      ],
    },
  ]);
});

test('anthropic: a refusal returns a fixed answer and never runs tools', async (t) => {
  const stub = await startStubServer(() => ({
    body: anthropicMessage(
      [{ type: 'tool_use', id: 'toolu_x', name: 'get_table_columns', input: {} }],
      'refusal',
      { stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
    ),
  }));
  t.after(stub.close);
  const provider = new AnthropicProvider('test-key', 'claude-opus-5', stub.url);

  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = originalWarn; });
  const reply = await provider.chat([{ role: 'user', content: 'x' }], tools);
  assert.deepEqual([reply.content, reply.toolCalls], [REFUSAL_ANSWER, []]);
});

test('anthropic: models without documented server fallback send no fallback params', async (t) => {
  const stub = await startStubServer(() => ({ body: anthropicMessage([{ type: 'text', text: 'hi' }], 'end_turn') }));
  t.after(stub.close);
  await new AnthropicProvider('test-key', 'claude-sonnet-5', stub.url).chat([{ role: 'user', content: 'x' }]);
  assert.equal('fallbacks' in stub.requests[0].body, false);
  assert.equal('tools' in stub.requests[0].body, false);
  assert.doesNotMatch(stub.requests[0].headers['anthropic-beta'] ?? '', /server-side-fallback/);
});

// --- Ollama /api/chat ----------------------------------------------------------------------

test('ollama: sends function tools and round-trips object arguments and tool_name results', async (t) => {
  const stub = await startStubServer((request, count) => ({
    body: count === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { index: 0, name: 'get_table_columns', arguments: { tableName: 'users' } } }] } }
      : { message: { role: 'assistant', content: 'users has id.' } },
  }));
  t.after(stub.close);
  const provider = new OllamaProvider(stub.url, 'qwen3');

  const first = await provider.chat([{ role: 'user', content: 'Columns of users?' }], tools);
  assert.deepEqual(stub.requests[0].body.options, { num_ctx: 8192 });
  assert.deepEqual(first.toolCalls, [{ id: 'ollama-call-0', name: 'get_table_columns', arguments: { tableName: 'users' } }]);
  assert.deepEqual(stub.requests[0].body.tools, [{
    type: 'function',
    function: { name: 'get_table_columns', description: 'Fetch columns', parameters: tools[0].inputSchema },
  }]);

  await provider.chat(conversationAfterToolCall(first), tools);
  assert.deepEqual(stub.requests[1].body.messages.slice(2), [
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_table_columns', arguments: { tableName: 'users' } } }] },
    { role: 'tool', tool_name: 'get_table_columns', content: '{"columns":["id"]}' },
  ]);
});

// --- Provider rate limits ------------------------------------------------------------------

/** A provider's 429; `x-should-retry: false` stops the SDKs from retrying it. */
const rateLimited = (body) => ({ status: 429, headers: { 'retry-after': '120', 'x-should-retry': 'false' }, body });

for (const [name, create, body] of [
  ['openai', (url) => new OpenAIProvider('test-key', 'gpt-test', url), { error: { message: 'Rate limit reached for requests per day', type: 'requests' } }],
  ['anthropic', (url) => new AnthropicProvider('test-key', 'claude-sonnet-5', url), { type: 'error', error: { type: 'rate_limit_error', message: 'Daily limit reached' } }],
  ['ollama', (url) => new OllamaProvider(url, 'qwen3'), { error: 'too many requests' }],
]) {
  test(`${name}: a 429 becomes an LLMRateLimitError with the provider's Retry-After`, async (t) => {
    const stub = await startStubServer(() => rateLimited(body));
    t.after(stub.close);
    await assert.rejects(create(stub.url).chat([{ role: 'user', content: 'x' }]), (error) => {
      assert.ok(error instanceof LLMRateLimitError);
      assert.equal(error.retryAfterSeconds, 120);
      assert.match(error.message, /AI service has reached its usage limit/);
      return true;
    });
  });
}

// --- Provider outages ---------------------------------------------------------------------

/** A provider's 503; `x-should-retry: false` stops the SDKs from retrying it. */
const unavailable = { status: 503, headers: { 'retry-after': '30', 'x-should-retry': 'false' } };

for (const [name, create] of [
  ['openai', (url) => new OpenAIProvider('test-key', 'gpt-test', url)],
  ['anthropic', (url) => new AnthropicProvider('test-key', 'claude-sonnet-5', url)],
  ['ollama', (url) => new OllamaProvider(url, 'qwen3')],
]) {
  test(`${name}: a 503 becomes an LLMUnavailableError with the provider's Retry-After`, async (t) => {
    const stub = await startStubServer(() => unavailable);
    t.after(stub.close);
    await assert.rejects(create(stub.url).chat([{ role: 'user', content: 'x' }]), (error) => {
      assert.ok(error instanceof LLMUnavailableError);
      assert.equal(error.retryAfterSeconds, 30);
      assert.match(error.message, /temporarily unavailable/);
      assert.match(error.providerMessage, /503/);
      return true;
    });
  });
}

test('openai: a request that gets no answer times out as an LLMUnavailableError', async (t) => {
  const stub = await startStubServer(() => new Promise(() => {}));
  t.after(stub.close);
  const provider = new OpenAIProvider('test-key', 'gpt-test', stub.url, { timeoutMs: 200, maxRetries: 0 });

  await assert.rejects(provider.chat([{ role: 'user', content: 'x' }]), (error) => {
    assert.ok(error instanceof LLMUnavailableError);
    assert.match(error.providerMessage, /timed out/i);
    return true;
  });
});

// --- Factory -------------------------------------------------------------------------------

test('factory: native tool calling by default for cloud providers, text for Ollama', () => {
  assert.equal(readLLMConfigFromEnv({ LLM_PROVIDER: 'anthropic' }).model, 'claude-opus-5');
  assert.equal(createLLMProvider({ provider: 'anthropic', apiKey: 'k' }) instanceof AnthropicProvider, true);
  assert.equal(createLLMProvider({ provider: 'openai', apiKey: 'k' }) instanceof OpenAIProvider, true);
  assert.equal(createLLMProvider({ provider: 'ollama' }) instanceof OllamaProvider, false);
  assert.equal(createLLMProvider({ provider: 'ollama', toolCalling: 'native' }) instanceof OllamaProvider, true);
  assert.throws(() => readLLMConfigFromEnv({ LLM_TOOL_CALLING: 'magic' }), /native.*text/);
  assert.equal(readLLMConfigFromEnv({ LLM_TIMEOUT_SECONDS: '45' }).timeoutSeconds, 45);
  assert.throws(() => readLLMConfigFromEnv({ LLM_TIMEOUT_SECONDS: '0' }), /LLM_TIMEOUT_SECONDS/);
  assert.throws(() => readLLMConfigFromEnv({ LLM_TIMEOUT_SECONDS: 'abc' }), /LLM_TIMEOUT_SECONDS/);
  assert.throws(() => createLLMProvider({ provider: 'anthropic' }), /LLM_API_KEY/);
});

test('factory: LLM_CONTEXT_LENGTH sets the Ollama context window', async (t) => {
  assert.equal(readLLMConfigFromEnv({}).contextLength, undefined);
  assert.equal(readLLMConfigFromEnv({ LLM_CONTEXT_LENGTH: '16384' }).contextLength, 16384);
  for (const invalid of ['0', '-1', '4096.5', 'lots']) {
    assert.throws(() => readLLMConfigFromEnv({ LLM_CONTEXT_LENGTH: invalid }), /LLM_CONTEXT_LENGTH/);
  }

  const stub = await startStubServer(() => ({ body: { message: { role: 'assistant', content: 'hi' } } }));
  t.after(stub.close);
  const provider = createLLMProvider({ provider: 'ollama', baseUrl: stub.url, toolCalling: 'native', contextLength: 16384 });
  await provider.chat([{ role: 'user', content: 'hello' }]);
  assert.deepEqual(stub.requests[0].body.options, { num_ctx: 16384 });
});
