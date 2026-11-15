import 'dotenv/config';
import { join } from 'path';
import { configManager } from './composition/config.js';
import { createCoreServices, type CoreServices } from './composition/services.js';
import { Agent } from './application/Agent.js';
import { OpenAIProvider } from './adapters/models/OpenAIProvider.js';
import { AnthropicProvider } from './adapters/models/AnthropicProvider.js';
import { CalculatorTool } from './adapters/tools/CalculatorTool.js';
import { WebSearchTool } from './adapters/tools/WebSearchTool.js';
import { FileReadTool, FileWriteTool, FileListTool } from './adapters/tools/FileSystemTool.js';
import { ExecuteCommandTool } from './adapters/tools/ExecuteCommandTool.js';
import { SystemInfoTool } from './adapters/tools/SystemInfoTool.js';
import { ChannelManager } from './composition/ChannelManager.js';
import { SessionStore } from './adapters/storage/SessionStore.js';

let channelManager: ChannelManager | null = null;
let agent: Agent | null = null;
let services: CoreServices | null = null;

export async function startServer(): Promise<void> {
  services = createCoreServices();
  const { log, events } = services;
  log.info('Shitsuji starting...');

  events.publish('system.ready', { version: '0.1.0' });

  const configDir = configManager.getConfigDir();
  const dataDir = join(configDir, 'data');

  log.info('Configuration loaded', { configDir, dataDir });

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!openaiKey && !anthropicKey) {
    log.error('No API key set (OPENAI_API_KEY or ANTHROPIC_API_KEY)');
    process.exit(1);
  }

  let llm;
  let model = 'gpt-4o-mini';

  if (anthropicKey) {
    llm = new AnthropicProvider(anthropicKey, log);
    model = 'claude-3-5-sonnet-20241022';
    log.info('Using Anthropic provider');
  } else if (openaiKey) {
    llm = new OpenAIProvider(openaiKey, log);
    log.info('Using Openai provider');
  }

  const sessionStore = new SessionStore(join(dataDir, 'sessions'), log);

  agent = new Agent({
    name: 'Shitsuji Assistant',
    llmProvider: llm!,
    model,
    sessionStore,
    log,
    events,
  });

  agent.registerTool(new CalculatorTool());
  agent.registerTool(new WebSearchTool());
  agent.registerTool(new FileReadTool());
  agent.registerTool(new FileWriteTool());
  agent.registerTool(new FileListTool());
  agent.registerTool(new ExecuteCommandTool());
  agent.registerTool(new SystemInfoTool());

  channelManager = new ChannelManager(log);

  const cliChannel = await channelManager.createChannel('cli');
  const webhookChannel = await channelManager.createChannel('webhook', { port: 3000 });

  cliChannel.onMessage(async (message, _destination) => {
    log.info(`Received message: ${message.content.substring(0, 50)}...`);

    try {
      const response = await agent!.send(message.content);
      await cliChannel.send('cli', response);
    } catch (error) {
      log.error('Error processing message', { error: String(error) });
      await cliChannel.send('cli', `Error: ${String(error)}`);
    }
  });

  webhookChannel.onMessage(async (message, destination) => {
    log.info(`[Webhook] Received message: ${message.content.substring(0, 50)}...`);

    try {
      const response = await agent!.send(message.content);
      await webhookChannel.send(destination, response);
    } catch (error) {
      log.error('[Webhook] Error processing message', { error: String(error) });
    }
  });

  await channelManager.startAll();

  const sessions = sessionStore.list();
  if (sessions.length > 0) {
    log.info(`Loaded ${sessions.length} existing sessions`);
  }

  console.log(`
╔════════════════════════════════════════╗
║         Shitsuji AI Agent             ║
║════════════════════════════════════════║
║  Type your message and press Enter    ║
║  Commands:                             ║
║    /help  - Show help                 ║
║    /exit  - Exit                      ║
║                                      ║
║  Webhook: http://localhost:3000/webhook ║
╚════════════════════════════════════════╝
`);

  log.info('Shitsuji ready - use CLI or POST to http://localhost:3000/webhook');
}

export async function stopServer(): Promise<void> {
  if (channelManager) {
    await channelManager.stopAll();
  }
  services?.log.info('Shitsuji stopped');
}

export function getAgent(): Agent | null {
  return agent;
}
