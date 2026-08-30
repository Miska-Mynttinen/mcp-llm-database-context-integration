import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { DatabaseAdapter, initializeDatabaseAdapter, closeDatabaseAdapter, getDatabaseAdapter } from './src/database';
import { initializeLLMProvider, closeLLMProvider } from './src/llm';
import { DatabaseConversationStore } from './src/chat/conversationStore';
import { createDatabaseToolRegistry } from './src/tools/databaseTools';
import { MCPConnectionRegistry, readMCPServerConfig } from './src/tools/mcpConnectionRegistry';
import { ChatService } from './src/services/chatService';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

let chatService: ChatService | null = null;
let mcpRegistry: MCPConnectionRegistry | null = null;

async function initializeApp(): Promise<void> {
  const databaseAdapter = await initializeDatabaseAdapter();
  const llmProvider = initializeLLMProvider();
  const conversationStore = new DatabaseConversationStore(databaseAdapter);
  const localToolRegistry = createDatabaseToolRegistry(databaseAdapter, conversationStore);
  mcpRegistry = new MCPConnectionRegistry(llmProvider);
  const remoteToolRegistry = await mcpRegistry.initialize(readMCPServerConfig());
  const toolDefinitions = [...localToolRegistry.definitions, ...remoteToolRegistry.definitions];
  const executeTool = async (name: string, args: Record<string, any>) => {
    if (name.startsWith('mcp_')) {
      return remoteToolRegistry.execute(name, args);
    }
    return localToolRegistry.execute(name, args);
  };

  chatService = new ChatService(
    llmProvider,
    databaseAdapter,
    conversationStore,
    toolDefinitions,
    executeTool,
  );

  app.post('/api/chat', async (req, res) => {
    try {
      const { sessionId, userId, message } = req.body || {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }

      const response = await chatService!.handleMessage({ sessionId, userId, message });
      return res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  app.get('/api/sessions/:sessionId/history', async (req, res) => {
    try {
      const history = await chatService!.getHistory(req.params.sessionId, 50);
      return res.json({ sessionId: req.params.sessionId, history });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/sessions/:sessionId/clear', async (req, res) => {
    try {
      await chatService!.clearSession(req.params.sessionId);
      return res.json({ ok: true, sessionId: req.params.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  app.get('/api/schema', async (_req, res) => {
    try {
      const adapter = getDatabaseAdapter();
      const schema = await adapter.getSchema();
      return res.json({ schema });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message });
    }
  });

  app.get('/api/health', (_req, res) => {
    const adapter = getDatabaseAdapter();
    res.json({
      ok: true,
      llmProvider: process.env.LLM_PROVIDER || 'ollama',
      databaseType: adapter.getDatabaseType(),
      connected: adapter.isConnected(),
      timestamp: new Date().toISOString(),
    });
  });
}

const PORT = Number(process.env.PORT || 3000);

initializeApp()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Chat server running on port ${PORT}`);
      console.log(`LLM Provider: ${process.env.LLM_PROVIDER || 'ollama'}`);
      console.log(`DB Type: ${process.env.DB_TYPE || 'sqlite'}`);
    });

    process.on('SIGINT', async () => {
      console.log('Shutting down gracefully...');
      server.close();
      await mcpRegistry?.close();
      await closeDatabaseAdapter();
      await closeLLMProvider();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('Shutting down gracefully...');
      server.close();
      await mcpRegistry?.close();
      await closeDatabaseAdapter();
      await closeLLMProvider();
      process.exit(0);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize app:', error);
    process.exit(1);
  });
