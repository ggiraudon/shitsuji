import type { Clock } from '../../ports/Clock.js';
import { BaseContextInjectable, type AgentRenderContext } from '../../ports/ContextInjectable.js';

/**
 * The local date and time, in the tail (F04, tail 2): it changes on every call, so putting it in the
 * header would break the provider's prompt cache for the whole conversation.
 */
export class ClockInjectable extends BaseContextInjectable {
  readonly id = 'clock';
  readonly name = 'Clock';
  readonly description = 'The current local date and time';
  override placement = 'tail' as const;
  override order = 2;

  constructor(private readonly clock: Clock) {
    super();
  }

  render(context: AgentRenderContext): string {
    const now = this.clock.now();
    const timeZone = context.owner?.timezone ?? 'UTC';
    const locale = context.owner?.locale ?? 'en';
    let local: string;
    try {
      local = new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone,
      }).format(now);
    } catch {
      // An unknown zone or locale must not fail a turn; UTC in English always works.
      local = new Intl.DateTimeFormat('en', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(now);
    }
    return `Current local date and time for your owner: ${local} (${timeZone}).`;
  }
}
