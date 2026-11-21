import { BaseContextInjectable } from '../../ports/ContextInjectable.js';
import { type AgentRenderContext } from '../../ports/ContextInjectable.js';

/** One standing rule in the header: a stable id and the line the model reads. */
export interface Rule {
  /** Stable id, so a rule can be removed without matching its text. */
  id: string;
  /** The instruction itself, one line. */
  text: string;
}

/**
 * Puts the agent's standing rules in the header as a bullet list (F04). Header placement because the
 * rules do not change between calls; an empty list renders nothing, so no "Guidelines:" heading is
 * sent when there are none.
 */
export class RulesInjectable extends BaseContextInjectable {
  readonly id = 'rules';
  readonly name = 'Agent Rules';
  readonly description = 'Safety and behavioral guidelines';
  override placement = 'header' as const;
  override order = 2;

  constructor(
    /** The rules to render; `addRule`/`removeRule` change them at runtime. */
    private rules: Rule[],
  ) {
    super();
  }

  /** The rules as Markdown bullets, or an empty string when there are none. */
  render(_context: AgentRenderContext): string {
    if (this.rules.length === 0) {
      return '';
    }

    const ruleList = this.rules.map((r) => `- ${r.text}`).join('\n');

    return `Guidelines:\n${ruleList}`;
  }

  /** Appends a rule; it appears in the next context build, not a request already sent. */
  addRule(id: string, text: string): void {
    this.rules.push({ id, text });
  }

  /** Removes the rule with this id, if there is one. */
  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }
}
