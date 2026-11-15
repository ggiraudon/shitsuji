import 'dotenv/config';
import type { Agent } from './application/Agent.js';
import { loadConfig } from './composition/config/loadConfig.js';
import { createAgent } from './composition/createAgent.js';
import { createCoreServices, type CoreServices } from './composition/services.js';
import { ChannelManager } from './composition/ChannelManager.js';

let channelManager: ChannelManager | null = null;
let agent: Agent | null = null;
let services: CoreServices | null = null;

export async function startServer(): Promise<void> {
  const { config, source } = loadConfig();
  services = createCoreServices(config.logging);
  const { log, events } = services;
  log.info('Shitsuji starting...');

  events.publish('system.ready', { version: '0.1.0' });

  log.info('Configuration loaded', {
    source: source ?? '(defaults and environment)',
    dataDir: config.paths.dataDir,
  });

  const created = createAgent(config, services);
  agent = created.agent;
  const { sessionStore } = created;

  channelManager = new ChannelManager(log);

  const cliChannel = await channelManager.createChannel('cli');
  const webhookChannel = await channelManager.createChannel('webhook', {
    port: config.channels.webhook.port,
    path: config.channels.webhook.path,
  });

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
