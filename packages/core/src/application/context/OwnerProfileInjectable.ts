import { BaseContextInjectable, type AgentRenderContext } from '../../ports/ContextInjectable.js';

/**
 * Who the owner is, without the clock: the profile changes rarely, so it belongs in the cached header
 * (F04, header 3). The time of day is a separate tail injectable.
 */
export class OwnerProfileInjectable extends BaseContextInjectable {
  readonly id = 'owner-profile';
  readonly name = 'Owner profile';
  readonly description = 'Your name, time zone and locale';
  override placement = 'header' as const;
  override order = 3;

  render(context: AgentRenderContext): string | null {
    const owner = context.owner;
    if (!owner) return null;
    return [
      'Your owner:',
      `- Name: ${owner.displayName}`,
      `- Time zone: ${owner.timezone}`,
      `- Locale: ${owner.locale}`,
    ].join('\n');
  }
}
