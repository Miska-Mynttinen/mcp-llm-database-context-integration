const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { dist, scriptedLLM } = require('./helpers');

const { createMetrics, createTelemetry } = dist('src/observability');
const { createLogger, createSilentLogger } = require('@mcp-llm/runtime');
const { createChatTurn } = dist('src/chat/chatTurn');
const { InMemoryConversationStore } = dist('src/chat/stores/inMemoryConversationStore');
const { createTools } = dist('src/tools/tools');
const { createMcpServerMetrics } = require(path.join(__dirname, '..', 'packages', 'mcp-server', 'dist', 'metrics'));

const DASHBOARD = path.join(__dirname, '..', 'monitoring', 'grafana', 'dashboards', 'llm-app-overview.json');
const ALERTS = path.join(__dirname, '..', 'monitoring', 'prometheus', 'alerts.yml');
const LABELS = { provider: 'fake', model: 'fake-model' };
const logger = createSilentLogger();

// The chat app and the MCP server both log through this logger.
test('log redaction hides credentials, including inside serialized errors', () => {
  const lines = [];
  const log = createLogger({ service: 'test', destination: { write: (line) => lines.push(JSON.parse(line)) } });
  const error = Object.assign(new Error('upstream failed'), {
    config: { headers: { authorization: 'Bearer sk-live', 'x-api-key': 'sk-ant-live' } },
    headers: { 'set-cookie': 'session=abc' },
  });

  log.error({ err: error, user: { password: 'hunter22', apiKey: 'k', passwordHash: 'scrypt$x' }, token: 't' }, 'failed');

  const text = JSON.stringify(lines);
  for (const secret of ['Bearer sk-live', 'sk-ant-live', 'session=abc', 'hunter22', 'scrypt$x', '"k"', '"t"']) {
    assert.ok(!text.includes(secret), `log line leaked ${secret}`);
  }
  assert.equal(lines[0].err.message, 'upstream failed');
  assert.equal(lines[0].service, 'test');
});

/** Telemetry without metrics whose logger records `{ level, msg }` per line. */
function loggingTelemetry() {
  const lines = [];
  const log = createLogger({ service: 'test', destination: { write: (line) => lines.push(JSON.parse(line)) } });
  return { telemetry: createTelemetry(log), lines, messages: () => lines.map((line) => line.msg) };
}

test('without metrics, telemetry still logs chat turns, failed LLM requests, failed tools and rejections', async () => {
  const { telemetry, lines, messages } = loggingTelemetry();
  const tools = telemetry.tools(createTools([{
    definitions: [{ name: 'bad_tool', description: '', inputSchema: {} }],
    execute: async () => { throw new Error('boom'); },
  }]));
  const llm = telemetry.llm(scriptedLLM([{ toolCalls: [{ id: '1', name: 'bad_tool', arguments: { sql: 'SELECT x' } }] }, 'done']), LABELS);
  const chat = telemetry.chat(createChatTurn({ llm, store: new InMemoryConversationStore(), tools }));

  await chat.handle({ userId: 'u1', message: 'hi' });
  await assert.rejects(chat.handle({ userId: 'u1', message: 'again' }));
  telemetry.rateLimited('api', { ip: '1.2.3.4' });
  telemetry.budgetRefused('user', { ip: '1.2.3.4' });

  assert.equal(telemetry.metrics, undefined);
  assert.deepEqual(messages(), [
    'Tool call failed', 'Chat turn completed', 'LLM request failed', 'Rate limit exceeded', 'Token budget exceeded',
  ]);
  assert.equal(lines[0].arguments, '{"sql":"SELECT x"}');
});

/** The value of one series, or 0 when it hasn't been recorded. */
async function valueOf(metric, labels = {}) {
  const { values } = await metric.get();
  const match = values.find((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value));
  return match ? match.value : 0;
}

async function histogramCount(metric, labels = {}) {
  const { values } = await metric.get();
  const match = values.find((entry) => entry.metricName.endsWith('_count')
    && Object.entries(labels).every(([key, value]) => entry.labels[key] === value));
  return match ? match.value : 0;
}

test('LLM telemetry counts outcomes and tokens and rethrows failures', async () => {
  const metrics = createMetrics();
  const llm = createTelemetry(logger, metrics).llm(scriptedLLM([
    { content: 'hi', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } },
  ]), LABELS);

  assert.equal((await llm.chat([{ role: 'user', content: 'hello' }])).content, 'hi');
  await assert.rejects(llm.chat([{ role: 'user', content: 'again' }]), /ran out of replies/);

  assert.equal(await valueOf(metrics.llm.requests, { ...LABELS, outcome: 'success' }), 1);
  assert.equal(await valueOf(metrics.llm.requests, { ...LABELS, outcome: 'error' }), 1);
  assert.equal(await valueOf(metrics.llm.tokens, { ...LABELS, type: 'prompt' }), 10);
  assert.equal(await valueOf(metrics.llm.tokens, { ...LABELS, type: 'completion' }), 3);
  assert.equal(await histogramCount(metrics.llm.duration, LABELS), 2);
});

test('tool telemetry counts outcomes per tool, including calls that never reach a tool', async () => {
  const metrics = createMetrics();
  const context = { sessionId: 's', userId: 'u' };
  const inner = createTools([{
    definitions: ['ok_tool', 'bad_tool'].map((name) => ({ name, description: '', inputSchema: {} })),
    execute: async (name) => {
      if (name === 'bad_tool') throw new Error('boom');
      return { fine: true };
    },
  }]);
  const tools = createTelemetry(logger, metrics).tools(inner);

  assert.equal(tools.definitions, inner.definitions);
  assert.deepEqual(await tools.call({ name: 'ok_tool', arguments: {} }, context), { ok: true, name: 'ok_tool', result: { fine: true } });
  assert.deepEqual(await tools.call({ name: 'bad_tool', arguments: {} }, context), { ok: false, name: 'bad_tool', error: 'boom' });
  await tools.call({ name: 'ok_tool', arguments: {}, argumentsError: 'not JSON' }, context);
  await tools.call({ name: 'made_up_by_model', arguments: {} }, context);

  assert.equal(await valueOf(metrics.tools.calls, { tool: 'ok_tool', outcome: 'success' }), 1);
  assert.equal(await valueOf(metrics.tools.calls, { tool: 'ok_tool', outcome: 'error' }), 1);
  assert.equal(await valueOf(metrics.tools.calls, { tool: 'bad_tool', outcome: 'error' }), 1);
  assert.equal(await valueOf(metrics.tools.calls, { tool: 'unknown', outcome: 'error' }), 1);
});

test('chat turn telemetry records outcome and tool steps', async () => {
  const metrics = createMetrics();
  const tools = createTools([{ definitions: [{ name: 'lookup', description: '', inputSchema: {} }], execute: async () => 42 }]);
  const chat = createTelemetry(logger, metrics).chat(createChatTurn({
    llm: scriptedLLM([
      { toolCalls: [{ id: '1', name: 'lookup', arguments: {} }] },
      'the answer is 42',
    ]),
    store: new InMemoryConversationStore(),
    tools,
  }));

  const result = await chat.handle({ userId: 'u1', message: 'what is it?' });
  assert.equal(result.answer, 'the answer is 42');
  await assert.rejects(chat.handle({ userId: 'u1', message: 'again' }), /ran out of replies/);

  assert.equal(await valueOf(metrics.chat.turns, { outcome: 'success' }), 1);
  assert.equal(await valueOf(metrics.chat.turns, { outcome: 'error' }), 1);
  const steps = (await metrics.chat.toolSteps.get()).values;
  assert.equal(steps.find((entry) => entry.metricName.endsWith('_sum')).value, 1);
});

/** Metric names referenced by PromQL: identifiers with an underscore, minus functions and variables. */
function metricNamesIn(promql) {
  const functions = new Set(['histogram_quantile', 'clamp_min', 'count_over_time']);
  return (promql.match(/(?<![$\w])[a-z]+(?:_[a-z0-9]+)+/g) || []).filter((name) => !functions.has(name));
}

async function knownMetricNames() {
  const names = new Set();
  for (const registry of [createMetrics().registry, createMcpServerMetrics().registry]) {
    for (const metric of await registry.getMetricsAsJSON()) {
      names.add(metric.name);
      if (metric.type === 'histogram') {
        ['_bucket', '_sum', '_count'].forEach((suffix) => names.add(metric.name + suffix));
      }
    }
  }
  return names;
}

test('dashboard and alert queries only use metrics that exist', async () => {
  const dashboard = JSON.parse(fs.readFileSync(DASHBOARD, 'utf8'));
  const prometheusQueries = dashboard.panels
    .filter((panel) => panel.datasource?.uid === 'prometheus')
    .flatMap((panel) => panel.targets.map((target) => target.expr));
  const alertQueries = [...fs.readFileSync(ALERTS, 'utf8').matchAll(/expr:\s*\|?\s*\n?([\s\S]*?)(?=\n\s+for:)/g)]
    .map((match) => match[1]);
  assert.ok(prometheusQueries.length > 10);
  assert.ok(alertQueries.length >= 5);

  const known = await knownMetricNames();
  // postgres-exporter series come from the exporter, not from this codebase.
  const unknown = [...prometheusQueries, ...alertQueries]
    .flatMap(metricNamesIn)
    .filter((name) => !known.has(name) && !name.startsWith('pg_'));
  assert.deepEqual([...new Set(unknown)], []);
});

test('dashboard panels have unique ids and a title', () => {
  const { panels } = JSON.parse(fs.readFileSync(DASHBOARD, 'utf8'));
  const ids = panels.map((panel) => panel.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(panels.every((panel) => typeof panel.title === 'string' && panel.title.length > 0));
});
