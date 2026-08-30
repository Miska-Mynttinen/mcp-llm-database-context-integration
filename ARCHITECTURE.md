# Architecture Overview

This project is a database-aware chat assistant that keeps LLM access abstract and database access abstract. The application does not hardcode a single vendor or provider. Instead, it selects a configured LLM provider and database adapter from environment variables and routes all runtime behavior through shared interfaces.

At a high level, the system has four layers:

1. API layer
2. Business logic layer
3. Tool orchestration layer
4. Provider abstraction layer

The result is a lightweight architecture where the model can request metadata, query history, and read-only database insight, while the application executes those actions safely and returns the results to the LLM for final human-readable output.

## 1. Runtime architecture

The application entry point is `index.ts`.

Responsibilities:
- Load `.env` configuration
- Initialize the configured database adapter
- Initialize the configured LLM provider
- Build the chat service and tool registry
- Expose HTTP endpoints for chat and diagnostics
- Gracefully close adapters and providers on shutdown

The main flow is:
- Client sends `POST /api/chat` with `sessionId`, `userId`, and `message`
- `ChatService` handles the message
- `ToolCallOrchestrator` builds a prompt with the current chat context and tool definitions
- LLM may respond with a tool call
- The tool call is validated and executed
- Tool result is returned to the LLM for the final response
- The assistant response is stored in the conversation history

## 2. Project structure

```
.
├── index.ts                              # app bootstrap and HTTP API
├── .env                                  # local environment defaults
├── .env.example                          # sample environment variables
├── ARCHITECTURE.md                       # this file
├── plan.md                               # product and implementation plan
├── src/
│   ├── chat/
│   │   ├── conversationStore.ts          # session/message storage
│   │   └── types.ts                     # ChatSession and ChatMessage contracts
│   ├── database/
│   │   ├── adapters/
│   │   │   ├── postgres.ts              # PostgreSQL adapter
│   │   │   ├── mysql.ts                 # MySQL adapter
│   │   │   └── sqlite.ts                # SQLite adapter
│   │   ├── factory.ts                   # DB adapter factory and global singleton
│   │   ├── index.ts                     # export barrel
│   │   └── types.ts                     # DatabaseAdapter contract
│   ├── llm/
│   │   ├── providers/
│   │   │   ├── openai.ts                # OpenAI implementation
│   │   │   ├── anthropic.ts             # Anthropic implementation
│   │   │   └── ollama.ts                # Ollama implementation
│   │   ├── factory.ts                   # LLM provider factory and global singleton
│   │   ├── index.ts                     # export barrel
│   │   └── types.ts                     # LLMProvider contract
│   ├── services/
│   │   └── chatService.ts               # high-level chat orchestration API
│   ├── tools/
│   │   ├── databaseTools.ts             # metadata/query tools and validation
│   │   ├── orchestrator.ts              # model/tool loop orchestration
│   │   └── types.ts                     # tool contracts
│   └── ...
├── mcp-client/
│   └── src/
├── mcp-server/
│   └── src/
├── frontend/
│   └── src/
├── dist/
└── node_modules/
```

## 3. Core design principles

### Database abstraction

The database layer is abstracted behind `DatabaseAdapter` in `src/database/types.ts`.

Each adapter implements a common contract:
- `connect()`
- `disconnect()`
- `query()`
- `getSchema()`
- `getTables()`
- `getColumns()`
- `getDatabaseType()`
- `isConnected()`

This allows the rest of the system to work the same way with SQLite, PostgreSQL, or MySQL, controlled entirely by environment selection.

### LLM abstraction

The LLM layer is abstracted behind `LLMProvider` in `src/llm/types.ts`.

Each provider implements:
- `complete()`
- `chat()`
- `getCapabilities()`
- `getAvailableModels()`
- `close()`

This lets the application switch between OpenAI, Anthropic, or Ollama without rewriting business logic.

### Tool-call architecture

Instead of the app trying to directly interpret every user message itself, the model is given a tool-based interface. The model may decide to call one or more safe tools such as:
- `get_database_schema`
- `list_tables`
- `get_table_columns`
- `get_conversation_history`
- `execute_readonly_query`

The application owns the validation and execution of these tools, so the system remains safe and predictable.

## 4. Request flow

### Chat request

1. Client calls `POST /api/chat` with `sessionId`, `userId`, and `message`
2. `ChatService.handleMessage()` gets a session and appends the user message
3. `ToolCallOrchestrator.processMessage()` builds a prompt containing:
   - current user request
   - recent conversation history
   - a concise tool list with descriptions
4. The configured LLM provider is called with `chat(messages)`
5. If the LLM returns a JSON tool call, it is parsed and validated
6. The tool is executed using the database adapter or conversation store
7. The tool result is appended as a follow-up message
8. The LLM is prompted again to generate the final user-facing answer
9. Final reply is stored in the conversation history and returned to the client

When `MCP_SERVER_URLS` is configured, startup creates one Streamable HTTP MCP client per URL, discovers its tools, namespaces them, and adds them to the same tool registry. Calls to those names are routed back to the owning MCP client.

### Schema lookup flow

If the model asks for database metadata:
- `get_database_schema` or `get_table_columns` is invoked
- the database adapter fetches schema information from the configured DB
- the result is returned as a compact JSON payload suitable for LLM consumption
- the final response is generated from that data

### Query execution flow

If the model asks a data question:
- tool `execute_readonly_query` receives SQL and optional params
- SQL validation rejects non-SELECT, multi-statement, or commented SQL
- the adapter executes the query
- the result is limited and returned to the LLM
- the final answer is generated in natural language

## 5. Conversation memory design

`src/chat/conversationStore.ts` is responsible for storing session and message records.

It supports:
- session creation and lookup
- message appends for user/assistant/system roles
- recent message retrieval
- clearing a session

The store intentionally supports both:
- in-memory fallback for simple local testing
- database persistence when a database adapter is available

This gives the app a safe default while still enabling persistent history for real deployments.

## 6. Tool validation and safety

`src/tools/databaseTools.ts` contains the validation logic.

It enforces:
- only SELECT statements are accepted by `execute_readonly_query`
- comments are rejected
- multiple SQL statements are rejected
- destructive SQL is blocked outright
- result size is trimmed to a reasonable limit

These checks are intentionally enforced before any query reaches the database adapter.

## 7. API surface

The app exposes a small API for chat and diagnostics:

- `POST /api/chat`
  - Request: `{ sessionId, userId, message }`
  - Response: final assistant answer and optional tool execution metadata

- `GET /api/sessions/:sessionId/history`
  - Returns recent conversation history

- `POST /api/sessions/:sessionId/clear`
  - Clears a session

- `GET /api/schema`
  - Returns schema metadata from the connected database

- `GET /api/health`
  - Returns LLM provider, DB type, connection state, and timestamp

## 8. Dependency flow

The application follows a layered dependency model:

- `index.ts` -> initializes `DatabaseAdapter` and `LLMProvider`
- `ChatService` -> depends on `LLMProvider`, `ConversationStore`, and tool registry
- `ToolCallOrchestrator` -> depends on LLM + tool executor + conversation store
- `databaseTools.ts` -> depends on `DatabaseAdapter` and `ConversationStore`
- `DatabaseAdapter` implementations -> depend only on DB SDKs
- `LLMProvider` implementations -> depend only on a model-specific SDK or HTTP transport

This keeps concerns separated and makes the platform easier to extend.

## 9. Why this architecture works

This structure gives the project a few important properties:

- Provider flexibility: swap OpenAI, Anthropic, or Ollama without changing business logic
- Database flexibility: swap SQLite, PostgreSQL, or MySQL by setting env vars
- Safe tool use: the LLM can request database metadata and queries only through explicit, validated tools
- Session continuity: chat history is preserved independently of the provider
- Extensibility: new tools can be added by registering definitions and executor functions

## 10. Extension points

Some natural next additions:
- add more tools for table summaries, row samples, or query plan inspection
- add authentication/session ownership checks
- add structured logging around tool calls and latency
- add per-user rate limiting for LLM/tool invocations
- add a frontend chat UI that calls the same API

## 11. Summary

The codebase is organized around a clean separation of concerns:

- LLM providers are abstracted and selected by factory
- Databases are abstracted and selected by factory
- chat memory is stored in a dedicated conversation store
- tool execution is centralized and validated
- the API layer remains thin and orchestrates execution

This is a flexible platform for building a secure, model-driven database assistant without coupling the business logic to a single database or LLM backend.

## 12. Container deployment topology

The root `Dockerfile` builds a per-user application image containing:

- the main API process
- the compiled MCP client package
- the production frontend, served by the main API on port `3000`

The default `docker-compose.yaml` runs that application image with a PostgreSQL container. The database MCP server remains a separate image because each MCP server can have its own database and lifecycle.

The intended deployment unit is one application container per user. A user who connects to multiple MCP servers needs one MCP client connection for each server, owned by that user's application instance. Both sides use Streamable HTTP on the MCP `/mcp` endpoint, and the main chat tool registry routes discovered remote tools through the owning client connection.
