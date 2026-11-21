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
    /** Rendered exactly when the render context carries a summary. */
    type: 'custom' as const,
    /** True when a compaction summary exists for this session. */
    check: (context: AgentRenderContext) => !!context.summary,
  };

  /** The summary as an "earlier, summarised" note, or null when there is none. */
  render(context: AgentRenderContext): string | null {
    if (!context.summary) return null;
    return `Earlier in this conversation (summarised):\n\n${context.summary}`;
  }
}
