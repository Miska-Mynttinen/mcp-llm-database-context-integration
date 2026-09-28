# Architecture

This document explains how the application is put together, how a chat request flows through it, and where to make changes. For setup and configuration, see [README.md](README.md).

## 1. Overview

The app is a thin HTTP layer over a **chat turn**, which runs a loop between an **LLM provider** and a **tool registry**. Each of those is an interface with swappable implementations chosen at startup from environment variables, which come from the per-concern config files `.env.llm`, `.env.database`, `.env.mcp`, `.env.limits`, and `.env`:

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

Three rules shape the code:

- **One composition root.** `index.ts` is the only module that reads `process.env` for app wiring or creates real adapters. Everything else receives its dependencies as arguments, so tests build the same modules with fakes.
- **Provider-neutral core.** The chat turn only sees `LLMProvider`, `Tools`, and `ConversationStore`. Vendor wire formats and SQL dialects stay inside their adapters.
- **One path for untrusted access.** Everything the model, an MCP client or an API client may see of the database goes through `createUntrustedDatabase`, which has no raw `query` (see [§8](#8-database-layer-and-sql-safety)).

### Glossary

**Chat turn**: one user message and everything that answers it — the budget check, the LLM/tool loop, and recording both messages. `src/chat/chatTurn.ts`.

**Session**: a named conversation owned by exactly one user. Session ids are global; ownership is checked on every access.

**Owned session**: a session the caller has proven it owns, returned by `openSession` or `findOwnedSession`. The only way to read, append to, or clear a session's messages. Bound to the session's id *and* owner.

**Token budget**: the daily (UTC) cap on LLM tokens per user, per client IP, and overall. A chat turn opens a **turn meter** (`budget.openTurn`), which refuses the turn when over budget and is charged every LLM reply. `src/tokenBudget/`, configured by `CHAT_TOKENS_DAILY_*`. Not to be confused with **request rate limits**, which count HTTP requests per window, live in Express middleware (`src/rateLimit/`), and are the only thing `RATE_LIMIT_ENABLED` turns off.

**Telemetry**: the app's logs and optional metrics (`src/observability/telemetry.ts`). Its decorators always log; metrics are recorded only when `METRICS_ENABLED` is not `false`. Request rate-limit rejections (`rateLimited`) and token-budget refusals (`budgetRefused`) are reported through it as separate events with separate metrics.

**Untrusted database**: the view of the database that LLM- and MCP-client-authored requests get: read-only queries, with the app's own tables hidden.

**Read-only login**: the database login the MCP server connects as (`DB_READONLY_USER`), so the database itself enforces what the untrusted database's SQL guard checks: it can read every table but the **app tables**, and write nothing. Created or updated by `openAppStorage` (app startup, `npm run seed`, Compose's `db-seed`). PostgreSQL and MySQL only; SQLite has no logins.

**Database context tools**: the tool catalogue (`get_database_schema`, `list_tables`, `get_table_columns`, `execute_readonly_query`) defined and served only by the MCP server. The app gets them over MCP, as `mcp_server_<n>_<tool>`, and never serves them itself.

**App tables**: the app's own tables (users, chat sessions and messages, token usage), defined once in `APP_TABLES` (`@mcp-llm/database`) with their columns and indexes. Exactly these are created at startup and exactly these are hidden from the **untrusted database**.

**Tools**: every tool the LLM may call in a chat turn, built from **tool registries** (the app's conversation-history tool, and the MCP servers, which serve the database context tools). Calling one never throws: it returns a **tool outcome**, either a result or an error message the model reads. Registries may throw; `Tools` turns that into an outcome.

**Login** (frontend): the tab's bearer token and username, and the **session** the tab is chatting in. A login change always starts a new session, because sessions belong to one user. `frontend/src/login.ts`.

## 2. Project structure

```
.
├── index.ts               # composition root: reads env, wires real adapters, listens
├── .env*.example          # config templates, one per concern (see README)
├── Dockerfile, docker-compose*.yaml
├── monitoring/            # Prometheus, alert rules, Loki, Alloy, Grafana provisioning + dashboard
├── src/
│   ├── app.ts             # createApp(deps): Express routes and input validation
│   ├── auth/              # tokens, password hashing, requireAuth, origin check, user store, seeding
│   ├── chat/              # chatTurn.ts, ConversationStore contract, SQL and in-memory stores
│   ├── llm/               # LLMProvider, providers/ (openai, anthropic, ollama), text tool protocol, factory
│   ├── tools/             # createTools, the history tool, the MCP tool registry
│   ├── rateLimit/         # request rate limits (RATE_LIMIT_*)
│   ├── tokenBudget/       # daily token budgets (CHAT_TOKENS_DAILY_*) and their usage store
│   ├── observability/     # createTelemetry, metrics, instrumented decorators
│   ├── storage/           # openAppStorage: creates the app tables, returns the SQL stores
│   ├── seed/              # npm run seed: users and the sample data
│   └── config/            # env file list, durations, TRUST_PROXY, shared setting parsers
├── packages/              # npm workspaces
│   ├── runtime/           # @mcp-llm/runtime: env files, secrets check, logger, shared metric helpers
│   ├── database/          # @mcp-llm/database: adapters, APP_TABLES, readOnlyQuery, createUntrustedDatabase
│   ├── mcp-client/        # @mcp-llm/mcp-client: Streamable HTTP client, new session on 404
│   └── mcp-server/        # @mcp-llm/mcp-server: HTTP app, access control, contextTools.ts catalogue; own Dockerfile
├── frontend/              # React + Vite chat UI (separate npm project); login.ts holds the tab's login and session
├── tests/                 # node:test suites, run against dist/ (see §14)
└── dist/                  # compiled root app; dist/frontend holds the built UI
```

Package boundaries are real npm dependencies. The root app and the MCP server both import `@mcp-llm/database` and `@mcp-llm/runtime`, and neither reaches into the other's source.

## 3. Startup

`index.ts`:

1. Loads the config files from the working directory with `loadConfigEnvFiles` (`src/config/envFiles.ts`): `.env.llm`, `.env.database`, `.env.mcp`, `.env.limits`, then `.env`. Missing files are skipped. It uses Node's `process.loadEnvFile`, which never overwrites a variable that is already set. So shell variables win, then the per-concern files, and `.env` only fills gaps.
2. With `NODE_ENV=production`, refuses to start if any of `JWT_SECRET`, `SEED_USER_PASSWORD`, `MCP_AUTH_TOKEN` or `DB_PASSWORD` still has its public development value (`assertNoDevelopmentSecrets`, `@mcp-llm/runtime`; the MCP server runs the same check).
3. Creates the `Telemetry` (`createTelemetry`): the logger, plus metrics unless `METRICS_ENABLED=false`. Its decorators always log, so turning metrics off never silences a log line.
4. Reads and validates the rest of the config before connecting to anything: auth (`readAuthConfigFromEnv`; a missing or short `JWT_SECRET` is an error), request limits (`readRequestLimitsFromEnv`; `RATE_LIMIT_ENABLED=false` only logs a warning), token budgets (`readTokenBudgetsFromEnv`; all `off` only logs a warning), `TRUST_PROXY` (`readTrustProxyHopsFromEnv`) and MCP servers (`readMCPServerConfig`; `MCP_SERVER_URLS` without a valid `MCP_AUTH_TOKEN` is an error).
5. Connects the `DatabaseAdapter` (`connectDatabaseAdapter`, from `DB_*`) and calls `openAppStorage`, which creates every app table and index where missing and returns the user, conversation and token-usage stores. It wraps the adapter with `createUntrustedDatabase` for everything untrusted. It seeds `app_users` with `seedFromConfig`: `user1` … `user5` with `SEED_USER_PASSWORD`, if it is set. Each is created if missing and never overwritten. Then it builds the `AuthService`.
6. Creates the `LLMProvider` (`createLLMProvider`, from `LLM_*`), wrapped in the text tool protocol when that mode is selected, and in `telemetry.llm`.
7. Connects to each MCP server and discovers its tools. Unreachable servers are skipped with a warning, and no MCP tools at all logs a warning: the database tools come only from MCP.
8. Composes the history tool and the MCP tools into `Tools` (`createTools`), wrapped in `telemetry.tools`. A duplicate tool name is a startup error.
9. Builds the token budget on the token-usage store and the chat turn, wrapped in `telemetry.chat` (see [§10](#10-logging-and-metrics)), and calls `createApp` with the untrusted database, the `AuthService`, `dist/frontend` as the static UI directory, the telemetry, the request limits, `TRUST_PROXY` and `ALLOWED_ORIGINS`. Then it listens on `PORT`. With metrics on, it also starts `createMetricsApp` on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`), a separate server that serves only `GET /metrics`; if that port can't be bound, the process exits.

On `SIGINT` or `SIGTERM` it closes the HTTP server and the metrics server, then the MCP connections, the database, and the LLM provider.

## 4. The chat turn

`createChatTurn` (`src/chat/chatTurn.ts`) handles one `POST /api/chat`:

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

Details:

- **Session id.** It is `sessionId`, else `userId`.
- **Ownership.** The store enforces it: a session's messages are reachable only through the `OwnedSession` that `openSession` or `findOwnedSession` return. A new session is created with the requesting user as owner, safely when two requests create it at once. `handle`, `getHistory(userId, sessionId)` and `clearSession(userId, sessionId)` throw `SessionNotFoundError` (HTTP `404`) for a session with another owner or none. History of a session that doesn't exist yet is empty, and clearing it does nothing.
- **Token budget.** The turn first calls `budget.openTurn({ userId, clientIp })` (`src/tokenBudget/tokenBudget.ts`), which throws `TokenBudgetExceededError` before anything is recorded when today's usage is over budget, and otherwise returns a meter. Each LLM reply is charged to the meter as it arrives, so a turn that fails partway still pays for the replies it got. A failed charge is logged and the turn goes on. Without a budget the turn is unlimited.
- **Context.** The system prompt followed by the 18 most recent stored messages, which already end with the new user message. The history is trimmed to start at a user message, because some providers reject a conversation that opens with an assistant turn. A turn that ran tools also stores a `tool` row before its answer: one line per call with its arguments and its result or error, each result cut to `MAX_TOOL_RESULT_CHARS`. Later turns see it folded into that answer, so the model keeps table and column names it already looked up. Tool rows are never returned by `GET /api/sessions/:id/history` or the history tool.
- **Tool execution.** Calls run one after another, in the order the model returned them. `Tools.call` never rejects: a call whose arguments could not be parsed, an unknown tool, and a tool that throws all come back as `ok: false` outcomes, which reach the model as error results (`isError`) it can react to, so a tool never fails the request.
- **Step cap.** After 4 rounds of tool calls, the model gets one more request asking it to answer from the results so far. Tool definitions are still sent, because providers reject tool history without them. If that reply is empty, the fixed `STEP_LIMIT_ANSWER` is returned.
- **Failures.** An LLM error fails the whole turn with a `500`. The user message stays in the history, but no assistant message is stored.

## 5. LLM abstraction

`LLMProvider` (`src/llm/types.ts`) has two methods:

- `chat(messages, tools)` returns `{ content, toolCalls, providerState?, usage? }`
- `close()`

Messages are provider-neutral: `system`, `user`, `assistant` (which may carry `toolCalls`), and `tool` (the result for one call id). Each adapter translates them to its own wire format:

| Provider | Tools sent as | Calls returned as | Results sent as |
| --- | --- | --- | --- |
| OpenAI | `tools: [{ type: "function", function }]` | `message.tool_calls` (arguments are a JSON string) | `role: "tool"` with `tool_call_id` |
| Anthropic | `tools: [{ name, description, input_schema }]` | `tool_use` content blocks | `tool_result` blocks, grouped in one user message |
| Ollama | `tools: [{ type: "function", function }]` | `message.tool_calls` (arguments are an object) | `role: "tool"` with `tool_name` |

`toToolCall` (`toolArguments.ts`) normalizes arguments from all three. Malformed JSON, or anything that isn't an object, becomes `argumentsError` instead of throwing.

Provider-specific behavior:

- **Anthropic.** Replies are echoed back unchanged, including thinking blocks, for the rest of the turn through the opaque `providerState` field. A `refusal` stop reason returns a fixed answer and drops any tool calls, because a refusal can cut a tool call off mid-input. On models that support it, requests opt into the server-side refusal fallback.
- **OpenAI and compatible endpoints.** The raw `tool_calls` go into `providerState` and are sent back unchanged on the next tool step. This keeps fields the SDK doesn't type, such as the thought signature Gemini 3 attaches to each call (`extra_content.google.thought_signature`), which Gemini requires back; for OpenAI itself, the request is unchanged. Earlier turns are replayed as text, so nothing provider-specific is stored. A reply with no text and no tool calls throws. When its `finish_reason` contains `MALFORMED_FUNCTION_CALL` (Gemini blocked a function call it considered invalid), the error is `LLMMalformedToolCallError` (`src/llm/errors.ts`).
- **Text tool protocol.** `withTextToolProtocol` wraps any provider for models without native tool calling. It appends the tool list to the system prompt, states that native function calling is unavailable, asks for a bare (or ```` ```json ````-fenced) object `{ "name", "arguments" }`, and turns a reply naming a known tool into a tool call. A reply that wraps such an object in prose ("Let me check: {...}") counts too, because small models often announce the call instead of just making it. A native call the model makes anyway is kept. If the provider blocks it instead (`LLMMalformedToolCallError`), the request is retried once with a closing user message asking for the JSON as plain text; a second failure, or any other error, fails the turn. Tool results go back as user messages. It supports one call per reply. `LLM_TOOL_CALLING` picks the mode; the default is `native` for OpenAI and Anthropic and `text` for Ollama.

## 6. Tools

`Tools` (`src/tools/types.ts`, built by `createTools` in `tools.ts`) is what the chat turn calls: JSON Schema `definitions` plus `call(toolCall, context)`, which returns a `ToolOutcome` (`{ ok: true, result }` or `{ ok: false, error }`) and never rejects. Behind it sit `ToolRegistry` adapters: `definitions` plus `execute(name, args, context)`, which may throw. `createTools` routes each call to the registry that defined the name, rejects duplicate names at startup, and turns unparsed arguments, unknown names and thrown errors into outcomes. `context` carries the session id and user id from the chat turn, never from the model.

**Database context tools** come only from the MCP server's catalogue (`packages/mcp-server/src/contextTools.ts`, `createDatabaseContextTools`); the app reaches them as `mcp_server_<n>_<tool>`. The catalogue validates arguments, and its SQL tool description names the database and the `?` placeholders every dialect takes:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_database_schema` | `tableName?` | All tables and columns, or the columns of one table |
| `list_tables` | `schema?` | `{ tables }` |
| `get_table_columns` | `tableName`, `schema?` | `{ tableName, columns }` |
| `execute_readonly_query` | `sql`, `params?`, `limit?` | `{ rows, rowCount, truncated }` through `UntrustedDatabase.readOnlyQuery` |

**History tool** (`historyTools.ts`), the app's only in-process tool, because it reads the app's own tables for the chat turn's user:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_conversation_history` | `scope?` (`previous` default, or `session`), `limit?` (default 20, capped at 100; unusable values mean the default) | User and assistant messages from the current user's other sessions, or the current session's (including messages older than the model's context), as `{ role, content, createdAt }`. Ids come from the `ToolContext`, never from arguments |

**MCP tools** (`mcpToolRegistry.ts`). Each URL in `MCP_SERVER_URLS` becomes one client named `server_<n>`. Its tools are registered as `mcp_server_<n>_<tool>`, lower-cased with non-alphanumerics replaced by `_`, for example `mcp_server_1_execute_readonly_query`. Results are unwrapped: a single text block is parsed as JSON when possible, and MCP `isError` results become thrown errors, which `Tools` turns back into outcomes. The MCP server sends a failure's bare message, so the model reads the catalogue's own error text.

## 7. API surface

Routes are defined in `createApp` (`src/app.ts`). All bodies are JSON.

Every `/api` request first passes an origin check (`requireAllowedOrigin`, `src/auth/origin.ts`): a browser `Origin` must match the `Host` header or be in `ALLOWED_ORIGINS`, else `403`. `POST /api/auth/login`, `POST /api/auth/register` and `GET /api/health` are public. `requireAuth` is mounted on `/api` after them, so every route registered later needs `Authorization: Bearer <jwt>`. Tokens are HS256 JWTs with `sub` (user id), `username`, `role` (always `user`) and `exp` (from `JWT_EXPIRES_IN`). Verification accepts only HS256, and the server keeps no token state, so logout only discards the token on the client.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /api/auth/login` | `{ username, password }` | `{ token, user: { id, username, role } }`, or `401` for any wrong username or password |
| `POST /api/auth/register` | `{ username, password }` | `201 { token, user }` for a new `user`-role account; `400` for an invalid name or password, `409` if taken |
| `GET /api/auth/me` | | `{ user }` from the token |
| `POST /api/chat` | `{ sessionId?, message }` | `{ sessionId, answer, toolSteps: [{ call, result }] }` |
| `GET /api/sessions/:sessionId/history` | | `{ sessionId, history }`: the 50 most recent messages, oldest first |
| `POST /api/sessions/:sessionId/clear` | | `{ ok: true, sessionId }` after deleting the session and its messages |
| `GET /api/schema` | | `{ schema: { tables, columns } }`, without the app's own tables |
| `GET /api/health` | | `{ ok, llmProvider, databaseType, connected, timestamp }` |
| `GET /metrics` | | Prometheus text format. Not on this app: `createMetricsApp` serves it on `METRICS_PORT` when metrics are on |

- `message` is required, non-blank, and at most 20,000 characters. Ids are optional strings of at most 255 characters. The session's owner is the token's `sub`, and a session owned by someone else returns `404`.
- `username` (at most 255 characters) and `password` (at most 1024) are required for login. Sign-up also requires `^[A-Za-z0-9_.-]{3,64}$` and a password of at least 8 characters (`src/auth/credentials.ts`).
- In `toolSteps`, `call` is `{ id, name, arguments, argumentsError? }` and `result` is `{ ok, name, result?, error? }`.
- When `createApp` gets `requestLimits`, over-limit requests return `429 { error }` with `Retry-After` (`src/rateLimit/`): sign-up per IP and globally, failed logins per IP, chat per user and per IP, and every `/api` route per IP. These counters are in memory, so they are per instance. Static files are not limited; `/metrics` is on its own port.
- `POST /api/chat` passes the client IP to the chat turn, which enforces the daily token budgets (per user, per IP, overall; see the chat turn above). The app maps `TokenBudgetExceededError` to `429 { error }` with `Retry-After` until 00:00 UTC. Usage lives in `llm_token_usage` via the `tokenUsage` store (`SqlTokenUsageStore`, from `openAppStorage`), which is an internal table hidden from LLM SQL; `index.ts` builds the budget on it.
- `createApp` sets Express `trust proxy` from `trustProxyHops` (`TRUST_PROXY`) whether or not request limits are on, because token budgets and logs use `req.ip` too.
- Invalid input returns `400 { error }`. A missing, malformed, forged or expired token returns `401 { error }`. Any other failure, including LLM and database errors, returns `500 { error }`, and the error is logged.
- Other paths are served as static files from the UI directory (`dist/frontend`), if it exists.

## 8. Database layer and SQL safety

`@mcp-llm/database` (`packages/database`) defines the `DatabaseAdapter` contract:

| Method | Purpose |
| --- | --- |
| `connect()`, `disconnect()`, `isConnected()` | Lifecycle |
| `query(sql, params?, { maxRows? })` | Runs one statement, the same way in every dialect (below); returns `{ rows, rowCount }` |
| `getSchema(schema?)`, `getTables(schema?)`, `getColumns(table, schema?)` | Metadata |
| `getDatabaseType()` | `postgres`, `mysql`, or `sqlite` |
| `ensureIndex(index)` | Idempotent index creation |

Every SQL dialect difference stays inside the adapters, so callers write one SQL for all three:

- **Placeholders.** `?` is the only one. The PostgreSQL adapter numbers them `$1, $2…`, skipping any inside strings, quoted identifiers and comments (`adapters/sqlText.ts`). Since a `?` is always a placeholder, PostgreSQL's `?` jsonb operators need their function forms (`jsonb_exists`).
- **Bound `LIMIT` / `OFFSET`.** They work everywhere. mysql2's prepared statements reject a number bound there, so the MySQL adapter sends those values as text.
- **Numbers.** BIGINT (COUNT, SUM of integers), NUMERIC and DECIMAL come back as numbers when the number is exact (a safe integer, or at most 15 significant digits), otherwise as their decimal text. The drivers return them as text by default.
- **Dates.** DATE comes back as `'YYYY-MM-DD'` text in every dialect. node-postgres and mysql2 would otherwise return a `Date` at local midnight, which serializes as the previous day east of UTC.
- **Metadata.** `ColumnInfo.isNullable` is a boolean, and `characterMaximumLength` a number, in every dialect.
- **Row caps.** `maxRows` caps a single SELECT in SQL. PostgreSQL and SQLite wrap it as `SELECT * FROM (...) AS read_only_query LIMIT n`. MySQL rejects a derived table with duplicate column names, so there a statement without a top-level `LIMIT` of its own (ignoring subqueries and strings) gets one appended instead.
- **Errors.** They name the dialect and keep the driver's error, with its code, as `cause`.

`tests/databaseAdapters.test.js` runs one contract against all three adapters (see [§14](#14-testing)).

`readDatabaseConfigFromEnv` and `createDatabaseAdapter` pick the implementation from `DB_TYPE`, which must name one of the three. The app and the MCP server both load `.env.database` with `loadEnvFiles` from `@mcp-llm/runtime`.

**`createUntrustedDatabase(adapter)`** (`untrustedDatabase.ts`) is the only path by which the model, MCP clients and `GET /api/schema` reach a database. It has no raw `query`: its listings (`getSchema`, `getTables`, `getColumns`) omit the app's own tables, and `readOnlyQuery` is the only way to run SQL. The app's stores keep the raw adapter. `readOnlyQuery`:

1. strips one trailing semicolon, then rejects anything containing another `;`
2. rejects comments (`--`, `/*`, `*/`)
3. requires the statement to start with `SELECT` or `WITH ... SELECT`
4. rejects writing keywords anywhere: `INSERT`, `UPDATE`, `DELETE`, DDL, `INTO`, `PRAGMA`, `ATTACH`, and similar
5. rejects any reference to the tables in `APP_TABLES` (`app_users`, `chat_sessions`, `chat_messages`, `llm_token_usage`) as a case-insensitive substring, whatever the quoting. It also rejects PostgreSQL Unicode escapes (`U&`) and functions that read a table or query named by a string (`*_to_xml`, `dblink*`, `pg_read_file`, `lo_get`, `ts_stat`, …), since those could spell the name indirectly
6. rejects system catalogues (`pg_catalog`, `pg_stat*`, `information_schema`, `performance_schema`, `mysql.` and `sys.`, `sqlite_master`, `pragma_*` functions, …). A query can filter those by a computed table name (`'app_' || 'users'`), and some hold sampled column values (`pg_stats`) or other sessions' SQL. The schema tools already describe the database
7. runs it with `maxRows: n+1`, so the database applies the row limit (default 100, maximum 1000) and one extra row reports `truncated`

`APP_TABLES` (`appTables.ts`) defines the app's own tables once: names, columns and indexes. `createAppTables` (called by `openAppStorage`) creates exactly those, and the untrusted view hides exactly those, and `tests/appStorage.test.js` fails if the app creates a table the untrusted view doesn't hide.

This is a keyword guard, not a sandbox. It can reject valid queries that mention these words (for example in a string literal), and it cannot stop an expensive read.

**The read-only login** is the database's own enforcement. `readReadOnlyLoginFromEnv` reads `DB_READONLY_USER` and `DB_READONLY_PASSWORD` (PostgreSQL and MySQL only). `openAppStorage(database, { readOnlyLogin })`, called by the app at startup and by `npm run seed`, creates the app tables and then calls `grantReadOnlyLogin`, which asks the adapter's `ensureReadOnlyLogin(login, INTERNAL_TABLES)` to create or update the login. That login can read every table but the app tables and writes nothing:

- **PostgreSQL:** `SELECT` on every table in `public`, including tables the owner creates later (default privileges), revoked on the app tables. Revoking also removes their rows from `pg_stats`. Sessions default to read-only transactions.
- **MySQL:** privileges only add up, so it revokes everything and then grants `SELECT` table by table on every table that exists except the app tables, plus `SHOW VIEW` on the database so the login can connect before there is anything to read. Account statements go over the text protocol, because re-running a prepared `ALTER USER ... IDENTIFIED BY` breaks the password.
- **SQLite** has no logins. The MCP server opens the file with `readOnly`, which sets `PRAGMA query_only`, so the database refuses its writes; the guard alone keeps it from reading the app tables. (`query_only` rather than a read-only open, because the MCP server may start before the app has created the file.)

**Connections.** `readDatabaseConfigFromEnv` also reads `DB_SSL` (TLS for PostgreSQL and MySQL) and `DB_STATEMENT_TIMEOUT_MS` (default 30 s): PostgreSQL sets `statement_timeout` on each pooled connection, MySQL sets `max_execution_time`, which cancels `SELECT`s. The PostgreSQL pool listens for errors on idle clients (a server restart) and reports them through `onBackgroundError`, which the app and the MCP server send to their logs; without a listener, Node would exit. SQLite waits up to 5 s for another process's lock, and the writer (the app) switches the file to WAL so the MCP server can read while it writes.

The MCP server connects as the read-only login whenever one is set, and warns (an error in production) when the database has logins but none is set. In Docker Compose, the one-shot `db-seed` service runs `npm run seed`'s entry point as the owner before `mcp-server` starts, and `mcp-server` only ever gets `mcp_reader`'s credentials.

## 9. Conversation memory

`ConversationStore` (`src/chat/conversationStore.ts`) covers `openSession(sessionId, userId)` (creates the session for its user, or reopens it; throws `SessionNotFoundError` for another owner), `findOwnedSession` (both return an `OwnedSession`), and `getRecentMessagesForUser` (the newest N, oldest first, across every session a user owns; optionally only some roles, or leaving one session out). An `OwnedSession` has `append` (the session must still exist), `recent` (the newest N, oldest first, optionally only some roles) and `clear`. Every one of them is scoped to the session's id and owner, so a handle kept past a clear can't reach a session that another user has since opened under the same id. History limits are clamped by the store (`clampHistoryLimit`: default 20, at most 100).

- **`SqlConversationStore`** stores data in the configured database, in the `chat_sessions` and `chat_messages` tables, with plain `?` SQL; the adapter handles the dialect. It keeps:
  - tables defined in `APP_TABLES` with columns portable across the three databases, created once at startup by `openAppStorage`
  - an atomic `openSession`: a failed insert that lost a race re-reads the winner's row
  - strictly increasing ISO timestamps, so messages written in the same millisecond keep their order
- **`InMemoryConversationStore`** keeps history in process memory. It is used by tests.

`tests/conversationStore.test.js` runs one contract suite against both.

## 10. Logging and metrics

Logs and metrics go through one `Telemetry` (`createTelemetry(logger, metrics?)` in `src/observability/telemetry.ts`), built only in `index.ts`, so the chat turn, providers, and registries stay unaware of it. Its decorators always log; they record metrics only when metrics are on (`METRICS_ENABLED`):

| Telemetry | Wraps | Logs | Records (metrics on) |
| --- | --- | --- | --- |
| `telemetry.llm` | `LLMProvider` | `warn` per failed request | `llm_requests_total{provider,model,outcome}`, `llm_request_duration_seconds`, `llm_tokens_total{type}` from `ChatReply.usage` |
| `telemetry.tools` | `Tools` | `warn` per failed call | `tool_calls_total{tool,outcome}`, `tool_call_duration_seconds`, from each outcome, including calls rejected before reaching a tool; names the model made up are labelled `unknown` |
| `telemetry.chat` | `ChatTurn` | `info` per completed turn | `chat_turns_total{outcome}`, `chat_turn_duration_seconds`, `chat_turn_tool_steps` |
| `telemetry.rateLimited` | request rate limiters | `warn` per rejection | `rate_limit_rejections_total{limiter}` |
| `telemetry.budgetRefused` | token budget | `warn` per refused turn | `token_budget_rejections_total{budget}` (`user`, `ip`, `global`) |
| `httpMetricsMiddleware` | Express | | `http_requests_total{method,route,status}`, `http_request_duration_seconds` |

- `GET /metrics` is served by `createMetricsApp` (`src/observability/metricsApp.ts`) on a separate port (`METRICS_PORT`, default `9464`), so the public port behind the reverse proxy never exposes it. Compose binds it to `0.0.0.0` but doesn't publish it; Prometheus scrapes `app:9464`.
- `createMetrics()` uses its own `prom-client` registry plus the default Node process metrics, so every app instance and test has independent series.
- The `route` label is the matched route template, such as `/api/sessions/:sessionId/history`. Unmatched requests are `static` or `unmatched`.
- Labels and info logs never include message text, SQL, tool arguments, session ids, or user ids.
- Logs are pino JSON on stdout with `service` and a string `level`, with credentials redacted (`createLogger`, `@mcp-llm/runtime`). The MCP server uses the same logger and serves its own `/metrics` (`mcp_active_sessions`, `mcp_requests_total`, `mcp_tool_calls_total`, `mcp_tool_call_duration_seconds`).

`tests/observability.test.js` checks that every metric used by the Grafana dashboard and alert rules exists, so renaming a metric without updating `monitoring/` fails the tests.

## 11. Container deployment topology

The root `Dockerfile` builds the application image in two stages. The runtime stage contains:

- the compiled API
- the `@mcp-llm/runtime`, `@mcp-llm/database` and `@mcp-llm/mcp-client` packages
- the production frontend in `dist/frontend`, served on port `3000`

`docker-compose.yaml` runs three services:

```mermaid
flowchart LR
  user[Browser] -->|:3000| app[app<br/>API + UI + MCP client]
  app -->|SQL| pg[(postgres :5432)]
  app -->|Streamable HTTP /mcp<br/>Bearer MCP_AUTH_TOKEN| mcp[mcp-server :3001]
  mcp -->|SQL| pg
  app -->|LLM_BASE_URL| llm[Ollama on host<br/>or hosted LLM]
```

`docker-compose.yaml` is the local-development setup: it sets `NODE_ENV=development` and uses the development secrets. `docker-compose.prod.yaml` is layered on top to deploy. It sets `NODE_ENV=production`, which is also the image default. In production, `index.ts` and the MCP server refuse to start with the public development secrets (`assertNoDevelopmentSecrets` in `@mcp-llm/runtime`). The override also removes the host ports of PostgreSQL, the MCP server and Prometheus, binds the app and Grafana to loopback for a reverse proxy (the app's metrics port `9464` is never published, in either file), and requires `POSTGRES_PASSWORD`.

The MCP server has its own image (`packages/mcp-server/Dockerfile`) because each MCP server can have its own database and lifecycle. The image is built from the repository root so it can use the root lockfile, and it installs only the `@mcp-llm/runtime`, `@mcp-llm/database` and `@mcp-llm/mcp-server` workspaces.

The `monitoring` Compose profile adds the observability stack (`docker compose --profile monitoring up`):

```mermaid
flowchart LR
  app[app :9464/metrics] --> prom[prometheus :9090]
  mcp[mcp-server /metrics] --> prom
  pgx[postgres-exporter] --> prom
  pgx --> pg[(postgres)]
  docker[Docker socket<br/>container stdout] --> alloy[alloy] --> loki[loki]
  prom --> grafana[grafana :3002]
  loki --> grafana
```

Prometheus pulls metrics every 15 seconds and evaluates `monitoring/prometheus/alerts.yml`. Alloy reads the logs of this Compose project's containers and labels them with `service` and `level`. Grafana is provisioned with both data sources and the **LLM App Overview** dashboard from `monitoring/grafana/`.

The intended deployment unit is **one application container per user**. That instance owns one MCP client connection per MCP server assigned to the user. Connections aren't shared across users, because MCP sessions and credentials can be user-specific.

## 12. Extending the system

### Add an LLM provider

1. Implement `LLMProvider` in `src/llm/providers/<name>.ts`. Translate the neutral `Message` types and `ToolSpec` to the wire format, and build tool calls with `toToolCall`.
2. In `src/llm/factory.ts`, add the name to `LLMProviderType`, `DEFAULT_MODELS`, `DEFAULT_TOOL_CALLING`, and the `createBaseProvider` switch.
3. Export it from `src/llm/index.ts`.
4. Add an example to `.env.llm.example`.
5. Add a case to `tests/llmProviders.test.js` that runs the real client against `startStubServer`.

### Add a database

1. Implement `DatabaseAdapter` in `packages/database/src/adapters/<name>.ts`.
2. In `packages/database/src/factory.ts`, add it to `DatabaseType`, `DEFAULT_PORTS`, and the `createDatabaseAdapter` switch.
   Add an example to `.env.database.example`.
3. Keep the dialect inside the adapter: accept `?` placeholders, return exact numbers, honour `maxRows`, make `ensureIndex` idempotent, and implement `ensureReadOnlyLogin` (or throw, like SQLite). Add the type to `DATABASE_TYPES` in `tests/helpers.js` so `tests/databaseAdapters.test.js` and the store contracts run against it. Also check that the column definitions in `APP_TABLES` are valid in the new dialect.

### Add a tool

- **Database context tool:** add a definition and a handler in `packages/mcp-server/src/contextTools.ts`; the app gets it over MCP. Work only through `UntrustedDatabase`.
- **App-only tool:** only for tools that need the chat turn's user or the app's own tables, like `src/tools/historyTools.ts`. Take identity from `context`, never from arguments.
- **New tool source:** implement `ToolRegistry`, then add it to the `createTools([...])` call in `index.ts`.
- **No code change:** run an MCP server and add its URL to `MCP_SERVER_URLS`.

## 13. Known limitations

- **No admin.** Every account has the `user` role and the same access, and there is no way to list, disable or delete users other than the database itself. Rows with any other role (such as an `admin` seeded by an earlier version) can't log in.
- **Open sign-up.** Anyone who can reach the app can create an account, within the sign-up rate limits.
- **Tokens can't be revoked** before they expire, except by rotating `JWT_SECRET`, which logs everyone out. There is no refresh token.
- **The app tables share the database with LLM-readable data.** On PostgreSQL and MySQL the read-only login keeps the MCP server out of them. On SQLite, which has no logins, the textual SQL guard is the only protection.
- **No database tools without the MCP server.** The app serves only the history tool itself. If the MCP server is down at startup, the LLM has no database tools until the app restarts (see discovery below).
- **Session ids are global.** Ownership is checked on every access, but a user who guesses another user's future session id first would own it; the frontend uses random UUIDs.
- **Request rate limits are in memory.** They reset on restart and aren't shared between app instances; several instances need a shared store such as Redis. Daily token budgets are in the database and are shared.
- **Token budgets can overshoot.** The budget is checked before a turn and charged after each LLM reply, so a turn can go over by what it uses, and turns that start together all pass the check. `llm_token_usage` gets one row per LLM reply and is never pruned.
- **The MCP server (`:3001`) has no rate limits.** Only the app, which holds `MCP_AUTH_TOKEN`, can call it, so its load is bounded by the app's chat limits. A per-IP limit there would throttle the app itself.
- **The MCP token identifies the app, not the user.** The MCP server knows a request came from the app, and so from inside a logged-in user's chat turn, but not which user. Per-user authorization on the MCP side would need the app to forward a signed user token with each call.
- **No timeouts on LLM or tool calls,** beyond the SDKs' own defaults. The database cancels statements after `DB_STATEMENT_TIMEOUT_MS` (PostgreSQL: every statement, MySQL: `SELECT`s, SQLite: none), and PostgreSQL connections time out after 2 seconds. A single chat turn can still run long.
- **MCP discovery happens only at startup.** Servers that come up later, or tools they add later, need an app restart.
- **Tool calls in one reply run sequentially.**
- **No tracing.** Metrics show which stage is slow in aggregate, but individual requests can't be followed across the app and MCP server.
- **Alerts aren't delivered.** No Alertmanager or Grafana contact point is configured.

## 14. Testing

The suite is deterministic and self-contained: it needs no Ollama, LLM API key, database server, MCP server, or network access. Tests inject fakes for each module's dependencies, use temporary SQLite files, and run local HTTP stubs that speak the OpenAI, Anthropic, and Ollama wire formats.

```bash
npm test                                                      # build, then every tests/*.test.js
node --test tests/*.test.js                                   # skip the build
node --test tests/chatTurn.test.js                            # one file
node --test --test-name-pattern="step cap" tests/*.test.js    # tests whose name matches
```

`npm test` runs `build:backend`, which builds the packages and the root app but not the frontend, then runs Node's built-in `node:test` runner: 289 tests in 18 files, with 62 skipped unless PostgreSQL and MySQL are configured. Tests load the compiled code from `dist/` and `packages/*/dist`, so rebuild after editing TypeScript. The exception is `login.test.js`, which imports the frontend's dependency-free `login.ts` directly.

**Against PostgreSQL and MySQL.** The SQL contract tests (adapters, the SQL conversation store, `SqlTokenUsageStore`, the read-only login and seeding) always run against SQLite, and also against these servers when they're configured. Each test creates and drops its own database and logins, so the user needs to be able to create databases and manage users:

```bash
docker run -d --rm --name test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
docker run -d --rm --name test-mysql -e MYSQL_ROOT_PASSWORD=test -p 53306:3306 mysql:8.4
TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
TEST_MYSQL_URL=mysql://root:test@127.0.0.1:53306/mysql \
  node --test tests/*.test.js
```

### What each file covers

Each file tests one module through its public interface:

| File | Covers |
| --- | --- |
| `databaseAdapters.test.js` | The `DatabaseAdapter` contract on every configured database: placeholders, bound `LIMIT`, exact numbers, dates, timeouts, `maxRows`, errors, and the read-only login |
| `readOnlyQuery.test.js` | `createUntrustedDatabase`: statement validation, the hidden app tables, indirect access and system catalogues, row limits |
| `appStorage.test.js` | `openAppStorage`: app tables created idempotently and all hidden; the read-only login across restarts |
| `auth.test.js` | Password hashing, JWTs (expired, forged, `alg: none`), auth config, seeding and `resetPassword` |
| `seed.test.js` | Users and sample data on every configured database, idempotency, the composite foreign key, the `npm run seed` CLI |
| `conversationStore.test.js` | The `ConversationStore` contract on the in-memory and SQL stores: ownership, concurrent opens, limit clamping |
| `toolRegistry.test.js` | `createTools` routing and failures as outcomes, MCP namespacing, `MCP_SERVER_URLS`, the history tool's scoping |
| `chatTurn.test.js` | Session ownership, direct answers, single, parallel and multi-step tool calls, the step cap, tool failures, token usage |
| `llmProviders.test.js` | Each real SDK or HTTP client against a local stub: tool definitions and calls, echoed tool calls (Gemini's thought signature), empty and blocked replies, refusals, default tool-calling mode |
| `textToolProtocol.test.js` | Tool instructions in the prompt, JSON reply parsing, unknown tool names, native calls made anyway, the one retry after a blocked call |
| `mcpServer.test.js` | The MCP server in-process with the real client: the catalogue, the SQL guard, `Host`, token and origin checks, session expiry, the built entry point |
| `app.test.js` | `createApp`: validation, chat, history, `401`/`403`/`404` paths, sign-up, metric labels, `/metrics` not on the public app, `createMetricsApp` |
| `rateLimit.test.js` | Every request limit, `off` limits, `RATE_LIMIT_*` and `TRUST_PROXY` parsing |
| `tokenBudget.test.js` | Budgets per user, IP and overall, the daily reset, failed charges, `SqlTokenUsageStore` on every database |
| `envFiles.test.js` | Config file loading and precedence, the production secrets check, the `MCP_AUTH_TOKEN` rule |
| `login.test.js` | The frontend's login and session handling, with and without `sessionStorage` |
| `observability.test.js` | Log redaction, telemetry decorators, and that every metric in the dashboard and alert rules exists |
| `e2e.test.js` | The whole process (below) |

`e2e.test.js` starts an Ollama-compatible stub, the built MCP server and `dist/index.js` on a temporary SQLite database. It sets `LLM_TOOL_CALLING=text` and its other settings through environment variables, so they override any local `.env*` files. It logs in as a seeded user and asks for the schema, then checks that the tool ran over MCP without exposing the app tables. It also checks history, per-user isolation, clearing a session, and the `/metrics` counters on `METRICS_PORT` (and that the public port returns 404 for it).

### Writing a test

Tests are CommonJS files named `tests/<module>.test.js`, using `node:test` and `node:assert/strict`, with these helpers from `tests/helpers.js`:

| Helper | Use |
| --- | --- |
| `dist('src/chat/chatTurn')` | Requires a compiled root module from `dist/` |
| `connectTempSqlite(label)` | A SQLite adapter on a fresh temp file. Returns `{ database, cleanup }` |
| `scriptedLLM(replies)` | A fake `LLMProvider` that returns scripted replies in order and records requests in `.requests` |
| `startStubServer(respond)` | A local HTTP server for testing real provider clients against canned responses |
| `startApp(t, replies, extraDeps)` | `createApp` on a temp SQLite database with a scripted LLM, logged in as `USER1`. Returns `request(method, route, body, { token })` |

Workspace packages are required by name, for example `require('@mcp-llm/database')`.

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

Test through the module's interface and inject fakes: every module below `index.ts` takes its dependencies as arguments, so no mocking library is needed. Register cleanup with `t.after(...)`, and keep tests offline.

### Not covered

- Live LLM APIs and live Ollama behavior, including how well a model follows the tool protocol. To check by hand, use the [Things to try](README.md#using-the-api) prompts.
- Frontend rendering. Only `login.ts` is tested, and `npm run build` in `frontend/` type-checks the rest.
- The Docker images and the monitoring stack at runtime. Only the metric names they reference are checked. See [Monitoring](README.md#monitoring) for a manual check.
- Performance, load, and concurrency.
