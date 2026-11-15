import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const globalConfigSchema = z.object({
  llm: z.object({
    defaultProvider: z.enum(['openai', 'anthropic', 'ollama']).default('openai'),
    apiKeys: z.record(z.string()).optional(),
  }).default({}),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),
  dataDir: z.string().default('~/.shitsuji/data'),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

const agentConfigSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  rules: z.array(z.string()).optional(),
  maxTokens: z.number().optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export class ConfigManager {
  private globalConfig: GlobalConfig;
  private agentConfigs = new Map<string, AgentConfig>();
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(homedir(), '.shitsuji');
    this.globalConfig = this.loadGlobalConfig();
  }

  private loadGlobalConfig(): GlobalConfig {
    const configPath = join(this.configDir, 'config.json');
    
    if (existsSync(configPath)) {
      try {
        const data = JSON.parse(readFileSync(configPath, 'utf-8'));
        return globalConfigSchema.parse(data);
      } catch (error) {
        console.warn('Failed to load config, using defaults:', error);
      }
    }
    
    const defaults = globalConfigSchema.parse({});
    this.saveGlobalConfig(defaults);
    return defaults;
  }

  saveGlobalConfig(config: GlobalConfig): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    const configPath = join(this.configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.globalConfig = config;
  }

  getGlobal(): GlobalConfig {
    return this.globalConfig;
  }

  updateGlobal(updates: Partial<GlobalConfig>): void {
    this.globalConfig = { ...this.globalConfig, ...updates };
    this.saveGlobalConfig(this.globalConfig);
  }

  getAgentConfig(agentId: string): AgentConfig | undefined {
    if (this.agentConfigs.has(agentId)) {
      return this.agentConfigs.get(agentId);
    }

    const agentPath = join(this.configDir, 'agents', agentId, 'config.json');
    if (existsSync(agentPath)) {
      try {
        const data = JSON.parse(readFileSync(agentPath, 'utf-8'));
        const config = agentConfigSchema.parse(data);
        this.agentConfigs.set(agentId, config);
        return config;
      } catch (error) {
        console.warn(`Failed to load agent config for ${agentId}:`, error);
      }
    }
    return undefined;
  }

  saveAgentConfig(agentId: string, config: AgentConfig): void {
    const agentDir = join(this.configDir, 'agents', agentId);
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }
    const agentPath = join(agentDir, 'config.json');
    writeFileSync(agentPath, JSON.stringify(config, null, 2));
    this.agentConfigs.set(agentId, config);
  }

  getConfigDir(): string {
    return this.configDir;
  }
}

export const configManager = new ConfigManager();
