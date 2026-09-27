const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');

let ollamaServer;
let mcpServerProcess;
let appProcess;
let databasePath;
let baseUrl;
let metricsUrl;
let token;

const USER1 = { username: 'user1', password: 'e2e-user-password' };
const MCP_AUTH_TOKEN = 'e2e-mcp-token-that-is-at-least-32-chars';
// The database context tools, as the app's MCP registry names them.
const SCHEMA_TOOL = 'mcp_server_1_get_database_schema';

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
        message.content.includes('Tool result for'));
      const content = isToolFollowUp
        ? 'The database schema is available and the chat session is working.'
        : requestCount === 1
          ? JSON.stringify({
            name: SCHEMA_TOOL,
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

/** Resolves once `child` prints `marker`; rejects if it exits first. */
function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(marker)) {
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`Process exited with ${code} before "${marker}". Output: ${output}`)));
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
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
  const mcpPort = 3218;
  metricsUrl = 'http://127.0.0.1:3219/metrics';
  baseUrl = `http://127.0.0.1:${appPort}`;
  databasePath = path.join(os.tmpdir(), `mcp-chat-e2e-${process.pid}.db`);
  fs.rmSync(databasePath, { force: true });

  // The database context tools come only from the MCP server, on the same database.
  mcpServerProcess = spawn(process.execPath, [path.join(__dirname, '..', 'packages', 'mcp-server', 'dist', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(mcpPort), DB_TYPE: 'sqlite', DB_NAME: databasePath, DB_READONLY_USER: '', MCP_AUTH_TOKEN },
  });
  await waitForOutput(mcpServerProcess, 'running on Streamable HTTP');

  appProcess = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(appPort),
      METRICS_ENABLED: 'true',
      METRICS_PORT: '3219',
      METRICS_HOST: '127.0.0.1',
      DB_TYPE: 'sqlite',
      DB_NAME: databasePath,
      // SQLite has no logins; a DB_READONLY_USER from a local .env.database would stop startup.
      DB_READONLY_USER: '',
      LLM_PROVIDER: 'ollama',
      LLM_MODEL: 'e2e-test-model',
      LLM_BASE_URL: ollamaUrl,
      // The stub speaks the text tool protocol; a local .env.llm may select native.
      LLM_TOOL_CALLING: 'text',
      MCP_SERVER_URLS: `http://127.0.0.1:${mcpPort}/mcp`,
      MCP_AUTH_TOKEN,
      JWT_SECRET: 'e2e-secret-that-is-at-least-32-characters',
      SEED_USER_PASSWORD: USER1.password,
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

  const unauthenticated = await request('POST', '/api/chat', { sessionId: 'e2e-session', message: 'hi' });
  assert.equal(unauthenticated.status, 401);

  const login = await request('POST', '/api/auth/login', USER1);
  assert.equal(login.status, 200);
  token = login.body.token;

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
  assert.equal(chat.body.toolSteps.length, 1);
  const [step] = chat.body.toolSteps;
  assert.equal(step.call.name, SCHEMA_TOOL);
  assert.equal(step.result.ok, true);
  const tableNames = step.result.result.tables.map((table) => table.name);
  for (const internal of ['app_users', 'chat_sessions', 'chat_messages', 'llm_token_usage']) {
    assert.ok(!tableNames.includes(internal), `LLM must not see ${internal}`);
  }
  assert.match(chat.body.answer, /schema/i);

  const history = await request('GET', '/api/sessions/e2e-session/history');
  assert.equal(history.status, 200);
  assert.equal(history.body.history.length, 2);
  assert.deepEqual(history.body.history.map((message) => message.role), ['user', 'assistant']);

  // Another seeded user can log in but cannot see user1's session.
  const user1Token = token;
  const user2 = await request('POST', '/api/auth/login', { username: 'user2', password: USER1.password });
  assert.equal(user2.status, 200);
  assert.equal(user2.body.user.role, 'user');
  token = user2.body.token;
  assert.equal((await request('GET', '/api/sessions/e2e-session/history')).status, 404);
  token = user1Token;

  const cleared = await request('POST', '/api/sessions/e2e-session/clear');
  assert.deepEqual(cleared, {
    status: 200,
    body: { ok: true, sessionId: 'e2e-session' },
  });

  const emptyHistory = await request('GET', '/api/sessions/e2e-session/history');
  assert.equal(emptyHistory.status, 200);
  assert.deepEqual(emptyHistory.body.history, []);

  assert.equal((await fetch(`${baseUrl}/metrics`)).status, 404);
  const metrics = await (await fetch(metricsUrl)).text();
  assert.match(metrics, /chat_turns_total\{outcome="success"\} 1/);
  assert.match(metrics, /llm_requests_total\{provider="ollama",model="e2e-test-model",outcome="success"\} 2/);
  assert.match(metrics, new RegExp(`tool_calls_total\\{tool="${SCHEMA_TOOL}",outcome="success"\\} 1`));
});

test.after(async () => {
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
    await once(appProcess, 'exit');
  }
  if (mcpServerProcess && mcpServerProcess.exitCode === null) {
    mcpServerProcess.kill('SIGTERM');
    await once(mcpServerProcess, 'exit');
  }
  if (ollamaServer) {
    await new Promise((resolve) => ollamaServer.close(resolve));
  }
  if (databasePath) {
    fs.rmSync(databasePath, { force: true });
  }
});