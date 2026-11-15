import { BaseContextInjectable, type AgentRenderContext } from '../../ports/ContextInjectable.js';

/**
 * The assembled standing instructions, at the top of the header (F04, Q6). It renders the revision
 * the turn started with, never the newest one, so a revision confirmed mid-turn waits its turn.
 */
export class SoulInjectable extends BaseContextInjectable {
  readonly id = 'soul';
  readonly name = 'SOUL';
  readonly description = 'The assembled standing instructions';
  override placement = 'header' as const;
  override order = 0;

  render(context: AgentRenderContext): string | null {
    return context.soul?.body ?? null;
  }
}
