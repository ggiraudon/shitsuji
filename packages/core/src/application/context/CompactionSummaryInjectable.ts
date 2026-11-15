import { BaseContextInjectable, type AgentRenderContext } from '../../ports/ContextInjectable.js';

/**
 * The compaction summary at the start of the history (F04, context 0). It replaces the older messages
 * that it covers, so it changes only when compaction runs, not on every call.
 */
export class CompactionSummaryInjectable extends BaseContextInjectable {
  readonly id = 'compaction-summary';
  readonly name = 'Compaction summary';
  readonly description = 'A summary of the older part of the conversation';
  override placement = 'context' as const;
  override order = 0;
  override condition = {
    type: 'custom' as const,
    check: (context: AgentRenderContext) => !!context.summary,
  };

  render(context: AgentRenderContext): string | null {
    if (!context.summary) return null;
    return `Earlier in this conversation (summarised):\n\n${context.summary}`;
  }
}
