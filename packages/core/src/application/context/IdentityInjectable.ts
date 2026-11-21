import { BaseContextInjectable } from '../../ports/ContextInjectable.js';
import { type AgentRenderContext } from '../../ports/ContextInjectable.js';

/** Who the assistant says it is: name, a short role description, and optional capabilities. */
export interface IdentityConfig {
  /** The agent's name, e.g. `Shitsuji`. */
  name: string;
  /** What it is, completing "You are <name>, …", e.g. "a helpful butler". */
  description: string;
  /** Optional bullet list of what it can do; omitted when empty. */
  capabilities?: string[];
}

/**
 * The first header injectable (order -1): one sentence naming the assistant, plus its capabilities.
 * It comes before every other header piece so the identity is always the opening line (F04).
 */
export class IdentityInjectable extends BaseContextInjectable {
  readonly id = 'identity';
  readonly name = 'Agent Identity';
  readonly description = 'Defines the agent name and description';
  override placement = 'header' as const;
  override order = -1;

  constructor(
    /** The name, role and capabilities; supplied by `Agent` from its options. */
    private config: IdentityConfig,
  ) {
    super();
  }

  /** The identity line, with a capability list only when one was configured. */
  render(_context: AgentRenderContext): string {
    const capabilities = this.config.capabilities?.length
      ? `\nCapabilities:\n${this.config.capabilities.map((c) => `- ${c}`).join('\n')}`
      : '';

    return `You are ${this.config.name}, ${this.config.description}.${capabilities}`;
  }
}
