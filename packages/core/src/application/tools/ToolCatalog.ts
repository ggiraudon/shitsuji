import type { ToolSpec } from '../../ports/ModelProvider.js';
import { toolSpec, type Tool } from '../../ports/Tool.js';
import type { ToolLookup } from './ToolPipeline.js';

/** Every registered tool, by name. Names are unique. */
export class ToolCatalog implements ToolLookup {
  /** The tools by dotted name, in registration order. */
  private readonly tools = new Map<string, Tool>();

  constructor(
    /** The tools to register at construction; `add` validates each. */
    tools: readonly Tool[] = [],
  ) {
    for (const t of tools) this.add(t);
  }

  /** Registers a tool; a name that is not dotted lowercase or already taken is an error. */
  add(tool: Tool): void {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(tool.name)) {
      throw new Error(
        `Invalid tool name "${tool.name}" (use lowercase dotted names like "web.search")`,
      );
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered`);
    this.tools.set(tool.name, tool);
  }

  /** The tool with this name, or undefined; the pipeline's lookup. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Every tool in registration order, for `/tools` and for the tool index. */
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
