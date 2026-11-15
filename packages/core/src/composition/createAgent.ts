import path from 'node:path';
import { AnthropicProvider } from '../adapters/models/AnthropicProvider.js';
import { OpenAIProvider } from '../adapters/models/OpenAIProvider.js';
import { SessionStore } from '../adapters/storage/SessionStore.js';
import { CalculatorTool } from '../adapters/tools/CalculatorTool.js';
import { ExecuteCommandTool } from '../adapters/tools/ExecuteCommandTool.js';
import { FileListTool, FileReadTool, FileWriteTool } from '../adapters/tools/FileSystemTool.js';
import { SystemInfoTool } from '../adapters/tools/SystemInfoTool.js';
import { WebSearchTool } from '../adapters/tools/WebSearchTool.js';
import { Agent } from '../application/Agent.js';
import { ConfigError } from '../domain/errors.js';
import type { LLMProvider } from '../ports/LLMProvider.js';
import type { Logger } from '../ports/Logger.js';
import type { ShitsujiConfig } from './config/schema.js';
import type { CoreServices } from './services.js';

export interface ChatModel {
  provider: LLMProvider;
  /** The model name sent to the provider. */
  model: string;
  /** "provider/model", as written in the config. */
  ref: string;
}

/** Builds the provider for the `chat` purpose. Replaced by the ModelRouter in S13. */
export function createChatModel(config: ShitsujiConfig, log: Logger): ChatModel {
  const ref = config.models.purposes.chat;
  if (!ref) {
    throw new ConfigError(
      'No chat model configured. Set DEEPSEEK_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) in .env, ' +
        'or add models.providers and models.purposes.chat to shitsuji.config.yaml.',
    );
  }
  const slash = ref.indexOf('/');
  const providerId = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  const entry = config.models.providers[providerId]!; // existence checked by the schema
  const options = { baseUrl: entry.baseUrl, defaultModel: model };
  const provider =
    entry.kind === 'anthropic'
      ? new AnthropicProvider(entry.apiKey!.reveal(), log, options)
      : new OpenAIProvider(entry.apiKey?.reveal() ?? '', log, options);
  return { provider, model, ref };
}

/** The agent with today's built-in tools. Shared by the server and the TUI. */
export function createAgent(
  config: ShitsujiConfig,
  services: CoreServices,
): { agent: Agent; sessionStore: SessionStore } {
  const { log, events } = services;
  const chat = createChatModel(config, log);
  log.info('Using chat model', { model: chat.ref });

  const sessionStore = new SessionStore(path.join(config.paths.dataDir, 'sessions'), log);
  const agent = new Agent({
    name: 'Shitsuji',
    llmProvider: chat.provider,
    model: chat.model,
    sessionStore,
    log,
    events,
  });
  for (const tool of [
    new CalculatorTool(),
    new WebSearchTool(),
    new FileReadTool(),
    new FileWriteTool(),
    new FileListTool(),
    new ExecuteCommandTool(),
    new SystemInfoTool(),
  ]) {
    agent.registerTool(tool);
  }
  return { agent, sessionStore };
}
