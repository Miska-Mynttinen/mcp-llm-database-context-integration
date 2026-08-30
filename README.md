# Database-Aware LLM Chat Assistant

## What the application is

This project is a flexible, database-aware chat application built around the Model Context Protocol (MCP) style of tool calling. It gives a hosted or local LLM access to a database through a controlled tool layer, while keeping the application database-agnostic and model-agnostic.

The system is designed for use cases such as:
- asking questions about database schema
- exploring tables and columns
- retrieving recent chat context
- executing safe, read-only SQL queries through a validated tool layer
- using different LLM backends without changing the application logic

This is not tied to a single database vendor or model provider. The application chooses the provider based on environment variables and uses provider-specific adapters behind shared interfaces.

## What it can be used for

Examples of intended use:
- Data exploration in a local SQLite dev database
- Querying Postgres or MySQL schema and table metadata from a chat interface
- Asking an LLM to explain available tables, columns, and relationships
- Using safe SELECT-only query tools to inspect rows without allowing destructive SQL
- Replacing the LLM backend between OpenAI, Anthropic, and Ollama without modifying the application behavior

Typical workflow:

1. Start the app with a configured database and LLM provider.
2. Send a natural-language question like:
   - "Show me the schema for the main tables"
   - "What columns are in users?"
   - "List the tables in this database"
   - "Fetch the last 20 rows from orders"
3. The LLM decides whether it needs tool help.
4. The app validates the tool call and executes safe database metadata or query operations.
5. The LLM produces a final answer using the returned results.

## Supported databases

The project supports the following database adapters through the shared `DatabaseAdapter` interface:

- SQLite
- PostgreSQL
- MySQL

Database selection is environment-driven via `DB_TYPE`.

Examples:

- SQLite:
  - `DB_TYPE=sqlite`
  - `DB_NAME=database.db`

- PostgreSQL:
  - `DB_TYPE=postgres`
  - `DB_HOST=localhost`
  - `DB_PORT=5432`
  - `DB_USER=postgres`
  - `DB_PASSWORD=password`
  - `DB_NAME=testdb`

- MySQL:
  - `DB_TYPE=mysql`
  - `DB_HOST=localhost`
  - `DB_PORT=3306`
  - `DB_USER=root`
  - `DB_PASSWORD=password`
  - `DB_NAME=mydb`

## Supported LLM providers

The project supports the following LLM providers through the shared `LLMProvider` interface:

- OpenAI
- Anthropic
- Ollama

Selection is environment-driven via `LLM_PROVIDER`.

Examples:

- OpenAI:
  - `LLM_PROVIDER=openai`
  - `LLM_MODEL=gpt-4`
  - `LLM_API_KEY=...`

- Anthropic:
  - `LLM_PROVIDER=anthropic`
  - `LLM_MODEL=claude-3-sonnet-20240229`
  - `LLM_API_KEY=...`

- Ollama:
  - `LLM_PROVIDER=ollama`
  - `LLM_MODEL=llama2`
  - `LLM_BASE_URL=http://localhost:11434`

For Ollama, no API key is required, but the local Ollama service must be running.

## Configuration

Use the included `.env` file or copy `.env.example` and customize it.

Example default values in `.env`:

```env
LLM_PROVIDER=ollama
LLM_MODEL=llama2
LLM_BASE_URL=http://localhost:11434

DB_TYPE=sqlite
DB_NAME=database.db
```

## Running the application

### 1. Install dependencies

```bash
npm install
```

### 2. Start the application

```bash
node dist/index.js
```

If you want to compile first:

```bash
npx tsc
node dist/index.js
```

The server listens on port `3000` by default.

## Running containers

The default Compose setup runs one per-user application container containing the main API, the built frontend, and the MCP client package. Open `http://localhost:3000` after starting it:

```bash
docker compose up --build
```

Postgres runs as a separate container. The `mcp-server` image is also available as a separate service for MCP deployments. It exposes Streamable HTTP at `http://localhost:3001/mcp`, which is the endpoint used by `mcp-client`.

Set `MCP_SERVER_URLS` to a comma-separated list to connect the application to multiple servers. Compose uses `http://mcp-server:3001/mcp` automatically. Remote tools are registered with names such as `mcp_server_1_database_context` to avoid collisions.

For a multi-user deployment, run one application container per user. Each application instance should own one MCP client connection per MCP server assigned to that user; do not share a client process when session or credentials are user-specific.

For container configuration, check:
- `docker-compose.yaml`
- `Dockerfile`
- `.dockerignore`

## Making prompts to the system

The main application exposes a chat endpoint:

### HTTP example

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo-session",
    "userId": "user-1",
    "message": "Show me the schema for the main tables"
  }'
```

### Another example

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo-session",
    "userId": "user-1",
    "message": "What tables exist and what columns do they have?"
  }'
```

### Query example

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo-session",
    "userId": "user-1",
    "message": "List the first 10 rows from the users table if it exists"
  }'
```

The LLM may call special tools to:
- inspect schema metadata
- fetch table definitions
- inspect recent conversation history
- execute SELECT-only queries

The chat endpoint will return the final answer plus tool metadata if a tool was invoked.

## Checking chat history

```bash
curl http://localhost:3000/api/sessions/demo-session/history
```

## Clearing a chat session

```bash
curl -X POST http://localhost:3000/api/sessions/demo-session/clear
```

## Health check

```bash
curl http://localhost:3000/api/health
```

Expected output includes the database type and connection state.

## Notes on safety

The database tool layer is intentionally constrained:
- only SELECT queries are allowed
- multiple statements are rejected
- comments and destructive statements are blocked
- result sets are limited before returning to the model

This makes the app suitable for schema exploration and read-only usage without exposing arbitrary database control.

## Summary

This project is a reusable database-aware assistant framework. It allows you to:
- plug in different LLM providers
- plug in different databases
- keep chat memory per session
- safely expose database metadata and read-only query tools to an LLM
- use the exact same app logic across local development and production-like deployments

The application is best used as a structured, safe interface between a natural-language assistant and a database back end.
