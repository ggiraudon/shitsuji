import type { ToolSpec } from '../../ports/ModelProvider.js';
import { toolSpec, type Tool } from '../../ports/Tool.js';
import type { ToolLookup } from './ToolPipeline.js';

/** Every registered tool, by name. Names are unique. */
export class ToolCatalog implements ToolLookup {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: Tool): void {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(tool.name)) {
      throw new Error(
        `Invalid tool name "${tool.name}" (use lowercase dotted names like "web.search")`,
      );
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * The tools sent with every request: the non-deferred ones only. This list stays the same for a whole
   * session, whatever the model discovers, so the provider's prompt cache is never invalidated by it;
   * deferred tools are reached through tool_call.
   */
  specs(): ToolSpec[] {
    return this.list()
      .filter((t) => !t.deferred)
      .map(toolSpec);
  }
}
