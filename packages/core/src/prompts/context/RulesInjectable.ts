import { BaseContextInjectable } from './ContextInjectable.js';
import { type AgentRenderContext } from './ContextInjectable.js';

export interface Rule {
  id: string;
  text: string;
}

export class RulesInjectable extends BaseContextInjectable {
  readonly id = 'rules';
  readonly name = 'Agent Rules';
  readonly description = 'Safety and behavioral guidelines';
  override priority = 70;

  constructor(private rules: Rule[]) {
    super();
  }

  render(_context: AgentRenderContext): string {
    if (this.rules.length === 0) {
      return '';
    }

    const ruleList = this.rules.map((r) => `- ${r.text}`).join('\n');

    return `Guidelines:\n${ruleList}`;
  }

  addRule(id: string, text: string): void {
    this.rules.push({ id, text });
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }
}
