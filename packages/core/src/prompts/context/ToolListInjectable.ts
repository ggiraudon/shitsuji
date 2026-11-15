import { BaseContextInjectable } from './ContextInjectable.js';
import { type AgentRenderContext } from './ContextInjectable.js';
import { type ToolDefinition } from '../../llm/types.js';

export class ToolListInjectable extends BaseContextInjectable {
  readonly id = 'tool-list';
  readonly name = 'Available Tools';
  readonly description = 'Lists available tools the agent can use';
  override priority = 90;

  constructor(private tools: ToolDefinition[]) {
    super();
  }

  render(_context: AgentRenderContext): string {
    if (this.tools.length === 0) {
      return 'You have no tools available.';
    }

    const toolList = this.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

    return `Available tools:\n${toolList}\n\nWhen you need to use a tool, respond with a tool call.`;
  }
}

export class ToolContextInjectable extends BaseContextInjectable {
  readonly id = 'tool-context';
  readonly name = 'Tool Context';
  readonly description = 'Provides context when a tool is being used';
  override priority = 80;

  constructor() {
    super();
    this.condition = { type: 'tool_used', toolNames: [] };
  }

  render(context: AgentRenderContext): string | null {
    if (!context.toolCalls || context.toolCalls.length === 0) {
      return null;
    }

    const toolNames = context.toolCalls.map((tc) => tc.name).join(', ');
    return `You are now using tool(s): ${toolNames}. Provide the appropriate response.`;
  }

  setCondition(toolNames: string[]): void {
    this.condition = { type: 'tool_used', toolNames };
  }
}
