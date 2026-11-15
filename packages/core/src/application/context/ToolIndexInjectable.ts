import { BaseContextInjectable, type AgentRenderContext } from '../../ports/ContextInjectable.js';
import type { Tool } from '../../ports/Tool.js';

/**
 * Lists the deferred tools by name and one line each. Core tools are sent as full schemas with the
 * request, so they are not repeated here (F05 deferred discovery).
 */
export class ToolIndexInjectable extends BaseContextInjectable {
  readonly id = 'tool-index';
  readonly name = 'Tool index';
  readonly description = 'Names of tools that can be found with tool_search';
  override priority = 90;

  constructor(private readonly tools: () => readonly Tool[]) {
    super();
  }

  render(_context: AgentRenderContext): string | null {
    const deferred = this.tools().filter((t) => t.deferred);
    if (!deferred.length) return null;
    const lines = deferred.map((t) => `- ${t.name}: ${firstSentence(t.description)}`);
    return [
      'More tools exist than are listed with this request. Find one with tool_search, then call it:',
      ...lines,
    ].join('\n');
  }
}

const firstSentence = (s: string) => (s.split(/(?<=\.)\s/)[0] ?? s).slice(0, 120);
