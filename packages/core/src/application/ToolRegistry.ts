import { type Tool, type ToolResult, type ToolExecuteParams } from '../ports/Tool.js';
import type { ToolSpec as ToolDefinition } from '../ports/ModelProvider.js';
import type { Logger } from '../ports/Logger.js';

export class ToolRegistry {
  constructor(private readonly log: Logger) {}

  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} already registered`);
    }
    this.tools.set(tool.name, tool);
    this.log.info(`Registered tool: ${tool.name}`);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.log.info(`Unregistered tool: ${name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    }));
  }

  async execute(name: string, params: ToolExecuteParams): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        result: '',
        error: `Tool ${name} not found`,
      };
    }

    try {
      return await tool.execute(params);
    } catch (error) {
      return {
        success: false,
        result: '',
        error: String(error),
      };
    }
  }
}
