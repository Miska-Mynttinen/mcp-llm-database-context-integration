# Architecture

How the app fits together and where to change things. For setup, see [README.md](README.md).

## Overview

The app is a thin HTTP layer around a **chat turn**, which loops between an LLM provider and a set of tools.

```mermaid
flowchart LR
  client[Browser UI / HTTP client] --> app[createApp<br/>src/app.ts]
  app --> turn[Chat turn<br/>src/chat/chatTurn.ts]
  turn --> llm[LLMProvider<br/>OpenAI · Anthropic · Ollama]
  turn --> store[ConversationStore<br/>SQL · in-memory]
  turn --> tools[Tools<br/>createTools]
  tools --> history[History tool] --> store
  tools --> mcptools[MCP tool registry] --> mcp[MCP servers<br/>Streamable HTTP] --> db[(DatabaseAdapter<br/>SQLite · PostgreSQL · MySQL)]
  store --> db
  app -. /api/schema .-> db
```

Three rules hold the code together:

- **`index.ts` is the only place that wires things up.** It reads the environment and creates the real adapters. Everything else receives its dependencies as arguments, so tests pass in fakes.
- **The core is provider-neutral.** The chat turn only knows `LLMProvider`, `Tools` and `ConversationStore`. Wire formats and SQL dialects stay inside the adapters.
- **Untrusted access has one path.** Anything the model or an API client sees of the database goes through `createUntrustedDatabase`, which has no raw `query`.

## Layout

```
.
├── index.ts               # composition root: reads env, wires real adapters, listens
├── .env*.example          # config templates, one per concern
├── Dockerfile, docker-compose*.yaml
├── monitoring/            # Prometheus, alert rules, Loki, Alloy, Grafana
├── src/
│   ├── app.ts             # Express routes and input validation
│   ├── auth/              # JWT, password hashing, origin check, user store, seeding
│   ├── chat/              # chat turn, ConversationStore and its SQL/in-memory stores
│   ├── llm/               # LLMProvider, providers/, text tool protocol, factory
│   ├── tools/             # createTools, history tool, MCP tool registry
│   ├── rateLimit/         # request rate limits
│   ├── tokenBudget/       # daily token budgets
│   ├── observability/     # logs and metrics
│   ├── storage/           # openAppStorage: creates app tables, returns stores
│   ├── seed/              # npm run seed
│   └── config/            # env loading and parsers
├── packages/
│   ├── runtime/           # env files, secrets check, logger, metric helpers
│   ├── database/          # adapters, APP_TABLES, SQL guard, createUntrustedDatabase
│   ├── mcp-client/        # Streamable HTTP client
│   └── mcp-server/        # the database MCP server (own Dockerfile)
├── frontend/              # React + Vite chat UI
└── tests/                 # node:test suites, run against dist/
```

The packages are npm workspaces. The app and the MCP server share `database` and `runtime`, and neither imports the other.

## Startup

`index.ts` does the following, in order:

1. Loads `.env.llm`, `.env.database`, `.env.mcp`, `.env.limits` and `.env`. Existing variables are never overwritten, so the shell wins.
2. In production, refuses to start if any secret still has its template value (`assertNoDevelopmentSecrets`).
3. Validates the config: auth, limits, budgets, `TRUST_PROXY` and the MCP servers.
4. Connects to the database. `openAppStorage` creates the app tables, sets up the read-only login and seeds the users.
5. Creates the LLM provider, and connects to each MCP server to discover its tools. Unreachable servers are skipped.
6. Builds the tools and the chat turn, then starts the API on `PORT` and metrics on `METRICS_PORT`.

## Chat turn

`createChatTurn` in `src/chat/chatTurn.ts`:

```mermaid
sequenceDiagram
  participant C as Client
  participant T as Chat turn
  participant S as ConversationStore
  participant L as LLMProvider
  participant R as Tools
  C->>T: { sessionId?, userId (from token), message }
  T->>S: openSession (owner must be userId), append user message
  T->>S: recent 18 messages
  loop up to 4 tool steps
    T->>L: chat(system prompt + history + tool results, tool definitions)
    L-->>T: { content, toolCalls }
    alt no tool calls
      T-->>T: final answer
    else tool calls
      T->>R: call(toolCall, { sessionId, userId }) for each call
      R-->>T: ToolOutcome (ok + result, or error)
    end
  end
  T->>S: append tool record (if tools ran), then assistant answer
  T-->>C: { sessionId, answer, toolSteps }
```

- **Ownership.** A session belongs to whoever created it. Anyone else gets `404`.
- **Budget.** A turn is refused up front if the user's daily token budget is spent, and each LLM reply is charged as it arrives.
- **Context** is the system prompt plus the last 18 messages. When a turn ran tools, a summary of the calls is saved with the answer, so later turns remember table and column names.
- **Tools never throw.** Bad arguments, unknown tools and errors come back as `ok: false` results, and the model sees them.
- **Step cap.** After 4 rounds of tools, the model is asked to answer with what it has.
- An LLM error fails the turn with `500`. The user's message stays saved.

## LLM providers

`LLMProvider` (`src/llm/types.ts`) has `chat(messages, tools)` and `close()`. Each adapter translates the neutral messages into its own wire format:

| Provider | Tools sent as | Calls returned as | Results sent as |
| --- | --- | --- | --- |
| OpenAI | `tools: [{ type: "function", function }]` | `message.tool_calls` (JSON string args) | `role: "tool"` + `tool_call_id` |
| Anthropic | `tools: [{ name, description, input_schema }]` | `tool_use` blocks | `tool_result` blocks in one user message |
| Ollama | `tools: [{ type: "function", function }]` | `message.tool_calls` (object args) | `role: "tool"` + `tool_name` |

- **Anthropic:** replies are echoed back unchanged within a turn, thinking blocks included. A refusal returns a fixed answer.
- **OpenAI-compatible:** raw tool calls are echoed back too. Gemini needs this for its thought signatures.
- **Text protocol** (`LLM_TOOL_CALLING=text`): for models without native tool calling. The tools are described in the prompt, and a JSON reply is parsed into a call.

## Tools

`createTools` merges tool registries and routes each call by name. The session and user ids come from the chat turn, never from the model.

| Tool | Source | Does |
| --- | --- | --- |
| `get_database_schema` | MCP server | Tables and columns |
| `list_tables` | MCP server | Table names |
| `get_table_columns` | MCP server | Columns of one table |
| `execute_readonly_query` | MCP server | One guarded `SELECT` (`sql`, `params?`, `limit?`) |
| `get_conversation_history` | App | The user's earlier messages |

MCP tools are exposed as `mcp_server_<n>_<tool>`. The database tools live in `packages/mcp-server/src/contextTools.ts`. The history tool runs in the app because it reads the app's own tables.

## API

Routes are in `src/app.ts`. Login, register and health are public. Everything else needs `Authorization: Bearer <jwt>`.

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/auth/login` | `{ username, password }` | `{ token, user }` |
| `POST /api/auth/register` | `{ username, password }` | `201 { token, user }` |
| `GET /api/auth/me` | | `{ user }` |
| `POST /api/chat` | `{ sessionId?, message }` | `{ sessionId, answer, toolSteps }` |
| `GET /api/sessions/:id/history` | | `{ sessionId, history }` (last 50) |
| `POST /api/sessions/:id/clear` | | `{ ok, sessionId }` |
| `GET /api/schema` | | `{ schema: { tables, columns } }` |
| `GET /api/health` | | `{ ok, llmProvider, databaseType, connected, timestamp }` |

- Messages can be up to 20,000 characters. Usernames are 3–64 characters from `[A-Za-z0-9_.-]`, and passwords are 8+ characters.
- Each `toolSteps` entry is `{ call: { id, name, arguments }, result: { ok, result?, error? } }`.
- Errors are `{ error }` with `400`, `401`, `403` (foreign origin), `404` (someone else's session), `409` (username taken), `429` (with `Retry-After`) or `500`.

## Database and SQL safety

`packages/database` defines one `DatabaseAdapter` interface for SQLite, PostgreSQL and MySQL. Callers write one SQL dialect, and the adapters handle the differences:

- `?` is the only placeholder style. Postgres converts it to `$1…`.
- Exact numbers come back as numbers, and DATE comes back as `'YYYY-MM-DD'` text.
- `maxRows` caps a query in SQL.

`createUntrustedDatabase` is what the model and `/api/schema` get. It hides the app tables from listings, and its only way to run SQL is `readOnlyQuery`, which:

1. allows exactly one statement, with no comments
2. requires it to start with `SELECT` or `WITH`
3. rejects write keywords (`INSERT`, `UPDATE`, DDL, `INTO`, `PRAGMA`, …)
4. rejects any mention of an app table, and functions that could reach one indirectly
5. rejects system catalogues (`pg_catalog`, `information_schema`, `sqlite_master`, …)
6. applies a row limit (100 by default, 1000 max)

The app tables are defined once, in `APP_TABLES`. A test fails if the app creates a table that the guard doesn't hide.

The guard is a keyword check, not a sandbox, so the **read-only login** backs it up at the database level:

- **Postgres:** `SELECT` on `public`, including future tables, but revoked on the app tables.
- **MySQL:** `SELECT` granted table by table, skipping the app tables. Rerun the seed after adding tables.
- **SQLite:** no logins. The MCP server opens the file with `query_only`, so writes fail, but only the guard hides the app tables.

`DB_STATEMENT_TIMEOUT_MS` (default 30 s) kills runaway queries on Postgres and MySQL.

## Conversation store

`ConversationStore` has `openSession`, `findOwnedSession` and `getRecentMessagesForUser`. The first two return an `OwnedSession` (`append`, `recent`, `clear`), which is tied to both the session id and the owner, and is the only way to touch messages. There are SQL and in-memory implementations, and one contract test runs against both.

## Observability

`createTelemetry` wraps the LLM provider, the tools and the chat turn in decorators that log failures and record Prometheus metrics: `llm_*`, `tool_calls_*`, `chat_turn_*`, `http_*`, `rate_limit_rejections_total` and `token_budget_rejections_total`. The MCP server has its own `mcp_*` metrics. Metrics are served on a separate port (`9464`), so they never go through the public proxy. Logs are pino JSON with credentials redacted. Neither logs nor metrics include message text, SQL or user ids.

## Deployment

There are two images: the app (API, UI, MCP client) and the MCP server. Each MCP server can have its own database and lifecycle. `docker-compose.yaml` is for development, and `docker-compose.prod.yaml` hardens it for production.

The intended setup is **one app container per user**, with its own MCP connections, because MCP sessions and credentials can be user-specific.

## Extending

**New LLM provider:** implement `LLMProvider` in `src/llm/providers/`. Register it in `src/llm/factory.ts` (`LLMProviderType`, `DEFAULT_MODELS`, `DEFAULT_TOOL_CALLING`, the switch), export it, add an example to `.env.llm.example`, and add a stub-server test in `tests/llmProviders.test.js`.

**New database:** implement `DatabaseAdapter` in `packages/database/src/adapters/`. Register it in `factory.ts`, and add it to `DATABASE_TYPES` in `tests/helpers.js` so the contract tests cover it. Handle the `?` placeholders, exact numbers, `maxRows` and `ensureReadOnlyLogin`.

**New tool:** database tools go in `packages/mcp-server/src/contextTools.ts`, using `UntrustedDatabase`. Tools that need the current user go in `src/tools/`. Or just run another MCP server and add it to `MCP_SERVER_URLS`.

## Known limitations

- There are no admin users, and anyone can sign up.
- Tokens can't be revoked. Rotating `JWT_SECRET` logs everyone out.
- On SQLite, the SQL guard is the only thing protecting the app tables.
- MCP tools are discovered only at startup. If the MCP server was down then, restart the app.
- Rate limits are in memory, per instance. Token budgets are in the database, but a turn can overshoot them.
- The MCP token identifies the app, not the user.
- There are no timeouts on LLM calls beyond the SDK defaults.
- Tool calls within one reply run one after another.
- There is no tracing, and alerts aren't delivered anywhere.

## Testing

The suite runs offline. It uses fakes, temporary SQLite files and local HTTP stubs that mimic the OpenAI, Anthropic and Ollama APIs.

```bash
npm test                                              # build + run everything
node --test tests/chatTurn.test.js                    # one file (after a build)
node --test --test-name-pattern="step cap" tests/*.test.js
```

To also run the SQL tests against real servers:

```bash
docker run -d --rm --name test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
docker run -d --rm --name test-mysql -e MYSQL_ROOT_PASSWORD=test -p 53306:3306 mysql:8.4
TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
TEST_MYSQL_URL=mysql://root:test@127.0.0.1:53306/mysql \
  node --test tests/*.test.js
```

Tests are CommonJS, and they load compiled code from `dist/`, so rebuild after you change TypeScript. Useful helpers in `tests/helpers.js`:

| Helper | Use |
| --- | --- |
| `dist(path)` | Require a compiled module |
| `connectTempSqlite(label)` | SQLite on a temp file |
| `scriptedLLM(replies)` | A fake LLM that returns canned replies |
| `startStubServer(respond)` | Local HTTP stub for provider clients |
| `startApp(t, replies)` | The full app on temp SQLite, logged in as `user1` |

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, scriptedLLM } = require('./helpers');

const { createChatTurn } = dist('src/chat/chatTurn');
const { InMemoryConversationStore } = dist('src/chat/stores/inMemoryConversationStore');

test('answers directly when the model calls no tools', async () => {
  const turn = createChatTurn({
    llm: scriptedLLM(['Hello']),
    store: new InMemoryConversationStore(),
    tools: { definitions: [], execute: async () => { throw new Error('unexpected'); } },
  });

  const result = await turn.handle({ sessionId: 's1', userId: 'u1', message: 'Hi' });

  assert.equal(result.answer, 'Hello');
  assert.deepEqual(result.toolSteps, []);
});
```

The suite doesn't cover real LLMs, frontend rendering (beyond `login.ts`), the Docker images or load.
