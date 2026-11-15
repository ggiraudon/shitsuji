import { BaseContextInjectable } from './ContextInjectable.js';
import { type AgentRenderContext } from './ContextInjectable.js';

export interface IdentityConfig {
  name: string;
  description: string;
  capabilities?: string[];
}

export class IdentityInjectable extends BaseContextInjectable {
  readonly id = 'identity';
  readonly name = 'Agent Identity';
  readonly description = 'Defines the agent name and description';
  override priority = 100;

  constructor(private config: IdentityConfig) {
    super();
  }

  render(_context: AgentRenderContext): string {
    const capabilities = this.config.capabilities?.length
      ? `\nCapabilities:\n${this.config.capabilities.map((c) => `- ${c}`).join('\n')}`
      : '';

    return `You are ${this.config.name}, ${this.config.description}.${capabilities}`;
  }
}
