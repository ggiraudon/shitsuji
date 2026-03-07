import 'dotenv/config';
import { join } from 'path';
import { logger } from './utils/logger.js';
import { configManager } from './utils/config.js';
import { messageBus } from './core/MessageBus.js';
import { Agent } from './core/Agent.js';
import { OpenAIProvider } from './llm/OpenAIProvider.js';
import { CalculatorTool, WebSearchTool, FileReadTool, FileWriteTool, FileListTool } from './tools/index.js';
import { CLIChannel, WebhookChannel, ChannelManager } from './channels/index.js';
import { SessionStore } from './memory/SessionStore.js';

async function main() {
  logger.info('Seahorse starting...');
  
  messageBus.publish('system.ready', { version: '0.1.0' });
  
  const configDir = configManager.getConfigDir();
  const dataDir = join(configDir, 'data');
  
  logger.info('Configuration loaded', { configDir, dataDir });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  const llm = new OpenAIProvider(apiKey);
  const sessionStore = new SessionStore(join(dataDir, 'sessions'));
  
  const agent = new Agent({
    name: 'Seahorse Assistant',
    llmProvider: llm,
    model: 'gpt-4o-mini',
    sessionStore,
  });

  agent.registerTool(new CalculatorTool());
  agent.registerTool(new WebSearchTool());
  agent.registerTool(new FileReadTool());
  agent.registerTool(new FileWriteTool());
  agent.registerTool(new FileListTool());

  const channelManager = new ChannelManager();
  
  const cliChannel = await channelManager.createChannel('cli');
  const webhookChannel = await channelManager.createChannel('webhook', { port: 3000 });

  cliChannel.onMessage(async (message, _destination) => {
    logger.info(`Received message: ${message.content.substring(0, 50)}...`);
    
    try {
      const response = await agent.send(message.content);
      await cliChannel.send('cli', response);
    } catch (error) {
      logger.error('Error processing message', { error: String(error) });
      await cliChannel.send('cli', `Error: ${String(error)}`);
    }
  });

  webhookChannel.onMessage(async (message, destination) => {
    logger.info(`[Webhook] Received message: ${message.content.substring(0, 50)}...`);
    
    try {
      const response = await agent.send(message.content);
      await webhookChannel.send(destination, response);
    } catch (error) {
      logger.error('[Webhook] Error processing message', { error: String(error) });
    }
  });

  await channelManager.startAll();

  const sessions = sessionStore.list();
  if (sessions.length > 0) {
    logger.info(`Loaded ${sessions.length} existing sessions`);
  }

  console.log(`
╔════════════════════════════════════════╗
║         Seahorse AI Agent             ║
║════════════════════════════════════════║
║  Type your message and press Enter    ║
║  Commands:                            ║
║    /help  - Show help                ║
║    /exit  - Exit                     ║
║                                      ║
║  Webhook: http://localhost:3000/webhook ║
╚════════════════════════════════════════╝
`);

  logger.info('Seahorse ready - use CLI or POST to http://localhost:3000/webhook');
}

main().catch((error) => {
  logger.error('Error', { error: String(error) });
  process.exit(1);
});
