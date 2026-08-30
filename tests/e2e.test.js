const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');

let ollamaServer;
let appProcess;
let databasePath;
let baseUrl;

function startOllamaStub() {
  let requestCount = 0;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/chat') {
        response.writeHead(404).end();
        return;
      }

      requestCount += 1;
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }

      const payload = JSON.parse(body);
      const isToolFollowUp = payload.messages.some((message) =>
        message.content.includes('Tool result:'));
      const content = isToolFollowUp
        ? 'The database schema is available and the chat session is working.'
        : requestCount === 1
          ? JSON.stringify({
            name: 'get_database_schema',
            arguments: {},
          })
          : 'The database is healthy.';

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: { content } }));
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForApp() {
  const output = [];
  appProcess.stdout.on('data', (chunk) => output.push(chunk.toString()));
  appProcess.stderr.on('data', (chunk) => output.push(chunk.toString()));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The application may still be initializing its database.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Application did not start. Output: ${output.join('')}`);
}

async function request(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test.before(async () => {
  ollamaServer = await startOllamaStub();
  const address = ollamaServer.address();
  const ollamaUrl = `http://127.0.0.1:${address.port}`;
  const appPort = 3217;
  baseUrl = `http://127.0.0.1:${appPort}`;
  databasePath = path.join(os.tmpdir(), `mcp-chat-e2e-${process.pid}.db`);
  fs.rmSync(databasePath, { force: true });

  appProcess = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(appPort),
      DB_TYPE: 'sqlite',
      DB_NAME: databasePath,
      LLM_PROVIDER: 'ollama',
      LLM_MODEL: 'e2e-test-model',
      LLM_BASE_URL: ollamaUrl,
      MCP_SERVER_URLS: '',
    },
  });

  await waitForApp();
});

test('serves health and completes a chat session through the database tool flow', async () => {
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.databaseType, 'sqlite');
  assert.equal(typeof health.body.connected, 'boolean');

  const invalidChat = await request('POST', '/api/chat', { sessionId: 'e2e-session' });
  assert.equal(invalidChat.status, 400);
  assert.equal(invalidChat.body.error, 'message is required');

  const chat = await request('POST', '/api/chat', {
    sessionId: 'e2e-session',
    userId: 'e2e-user',
    message: 'Show me the database schema.',
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.sessionId, 'e2e-session');
  assert.equal(chat.body.toolCall.name, 'get_database_schema');
  assert.equal(chat.body.toolResult.ok, true);
  assert.ok(chat.body.toolResult.result.tables.some((table) => table.name === 'chat_messages'));
  assert.match(chat.body.answer, /schema/i);

  const history = await request('GET', '/api/sessions/e2e-session/history');
  assert.equal(history.status, 200);
  assert.equal(history.body.history.length, 2);
  assert.deepEqual(history.body.history.map((message) => message.role), ['user', 'assistant']);

  const cleared = await request('POST', '/api/sessions/e2e-session/clear');
  assert.deepEqual(cleared, {
    status: 200,
    body: { ok: true, sessionId: 'e2e-session' },
  });

  const emptyHistory = await request('GET', '/api/sessions/e2e-session/history');
  assert.equal(emptyHistory.status, 200);
  assert.deepEqual(emptyHistory.body.history, []);
});

test.after(async () => {
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
    await once(appProcess, 'exit');
  }
  if (ollamaServer) {
    await new Promise((resolve) => ollamaServer.close(resolve));
  }
  if (databasePath) {
    fs.rmSync(databasePath, { force: true });
  }
});