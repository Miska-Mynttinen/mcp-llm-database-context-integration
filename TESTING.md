# Testing

## Prerequisites

- Node.js 18 or newer. The test uses the built-in `node:test` runner and `fetch`.
- Dependencies installed with `npm install`.

The end-to-end test does not require Ollama, an LLM API key, a database server, or an MCP server. It provides a local Ollama-compatible HTTP stub and uses a temporary SQLite database.

## Run the tests

From the project root:

```bash
npm test
```

`npm test` performs these steps:

1. Compiles the root application and the `mcp-client` and `mcp-server` packages.
2. Starts `tests/e2e.test.js` with Node's built-in test runner.
3. Removes the temporary SQLite database when the test finishes.

To run only the already-built E2E test without rebuilding:

```bash
node --test tests/e2e.test.js
```

Use the second command only after a successful `npm run build`.

## What the E2E test does

The test runs the application through its real HTTP boundary:

1. Starts a local Ollama-compatible stub that returns a deterministic tool call and final answer.
2. Starts the compiled API in a child process with an isolated SQLite database and the stub as its LLM provider.
3. Waits for `/api/health` to become available.
4. Verifies the health response and the `400` response for a chat request without a message.
5. Sends a chat request asking for the database schema.
6. Verifies that the orchestrator:
   - receives the LLM tool call for `get_database_schema`;
   - executes the database tool through the SQLite adapter;
   - returns the schema containing the chat tables; and
   - sends the tool result back to the LLM stub to produce the final answer.
7. Reads the session history and verifies that the user and assistant messages were persisted.
8. Clears the session and verifies that its history is empty.
9. Stops the API and stub processes and deletes the temporary database.

This gives coverage across the Express routes, application initialization, LLM provider boundary, tool-call orchestrator, database tool registry, SQLite adapter, and conversation store.

## Test scope

The test is intentionally deterministic and focused on the main API workflow. It does not replace tests for:

- OpenAI or Anthropic provider integrations
- Live Ollama behavior
- PostgreSQL or MySQL adapters
- A live MCP server connection
- Frontend rendering and browser interactions
- Performance, load, or concurrency behavior
