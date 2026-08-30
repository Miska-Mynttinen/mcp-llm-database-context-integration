# Quick Start

This project is a database-aware LLM chat assistant. It lets an external LLM answer questions about a database by using safe, read-only tools exposed by the application.

## Supported setup

- Databases: SQLite, PostgreSQL, MySQL
- LLM providers: OpenAI, Anthropic, Ollama

## Fastest local setup

Use SQLite + Ollama for the easiest local test flow.

1. Make sure Ollama is running locally.
2. Pull a model if needed:

```bash
ollama pull llama2
```

3. Set the environment values:

```bash
export LLM_PROVIDER=ollama
export LLM_MODEL=llama2
export LLM_BASE_URL=http://localhost:11434
export DB_TYPE=sqlite
export DB_NAME=database.db
```

4. Install dependencies:

```bash
npm install
```

5. Build and run:

```bash
npx tsc
node dist/index.js
```

6. Start asking questions:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo",
    "userId": "user1",
    "message": "Show me the schema for the main tables"
  }'
```

## Example prompts

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo",
    "userId": "user1",
    "message": "What tables are in this database?"
  }'
```

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo",
    "userId": "user1",
    "message": "Describe the schema for the users table"
  }'
```

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo",
    "userId": "user1",
    "message": "List the recent conversation history"
  }'
```

## Useful endpoints

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/sessions/demo/history
curl http://localhost:3000/api/schema
```

## Safety rules

The app is intentionally restricted to read-only tools:
- SELECT-only database execution
- no destructive SQL
- no multi-statement SQL
- validation before execution

## Switching providers or databases

Change the environment variables:

```bash
export LLM_PROVIDER=openai
export LLM_MODEL=gpt-4
export LLM_API_KEY=your_key

export DB_TYPE=postgres
export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=postgres
export DB_PASSWORD=password
export DB_NAME=testdb
```

Then restart the app.

## Troubleshooting

- If Ollama is not running: start it and confirm `http://localhost:11434` responds
- If SQLite database file is missing: a new file will be created when the app initializes if the path is valid
- If DB connection fails: check the DB host/user/password values and ensure the DB is running
- If the LLM returns empty results: confirm the provider is configured correctly and the model is available
