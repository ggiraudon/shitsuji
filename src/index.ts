import 'dotenv/config';
import { logger } from './utils/logger.js';
import { configManager } from './utils/config.js';
import { messageBus } from './core/MessageBus.js';
import { Agent } from './core/Agent.js';
import { OpenAIProvider } from './llm/OpenAIProvider.js';
import { CalculatorTool, WebSearchTool, FileReadTool, FileWriteTool, FileListTool } from './tools/index.js';

async function main() {
  logger.info('Seahorse starting...');
  
  messageBus.publish('system.ready', { version: '0.1.0' });
  
  logger.info('Configuration loaded', { 
    configDir: configManager.getConfigDir(),
  });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  const llm = new OpenAIProvider(apiKey);
  
  const agent = new Agent({
    name: 'Seahorse Assistant',
    llmProvider: llm,
    model: 'gpt-4o-mini',
  });

  agent.registerTool(new CalculatorTool());
  agent.registerTool(new WebSearchTool());
  agent.registerTool(new FileReadTool());
  agent.registerTool(new FileWriteTool());
  agent.registerTool(new FileListTool());

  messageBus.subscribe('llm.request', (payload: unknown) => {
    const p = payload as { model?: string };
    logger.info(`LLM Request: ${p.model}`);
  });

  messageBus.subscribe('llm.response', (payload: unknown) => {
    const p = payload as { contentLength: number; hasToolCalls: boolean };
    logger.info(`LLM Response: ${p.contentLength} chars, tools: ${p.hasToolCalls}`);
  });

  messageBus.subscribe('tool.called', (payload: unknown) => {
    const p = payload as { toolName: string };
    logger.info(`Tool called: ${p.toolName}`);
  });

  const session = agent.createSession();
  logger.info('Starting conversation...');

  const response1 = await agent.send('Hello! What can you do?', session.id);
  logger.info(`Assistant: ${response1}`);

  const response2 = await agent.send('What is 25 * 4?', session.id);
  logger.info(`Assistant: ${response2}`);

  const response3 = await agent.send('What is the square root of 144?', session.id);
  logger.info(`Assistant: ${response3}`);

  logger.info('Seahorse demo complete');
}

main().catch((error) => {
  logger.error('Error', { error: String(error) });
  process.exit(1);
});
