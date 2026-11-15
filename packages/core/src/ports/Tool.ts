export interface ToolExecuteParams {
  sessionId: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  result: string;
  error?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;

  execute(params: ToolExecuteParams): Promise<ToolResult>;
}

export abstract class BaseTool implements Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly schema: Record<string, unknown>;

  abstract execute(params: ToolExecuteParams): Promise<ToolResult>;
}
