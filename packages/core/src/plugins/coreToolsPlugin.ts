import { MathEvaluateTool } from '../adapters/tools/MathEvaluateTool.js';
import { SystemStatusTool } from '../adapters/tools/SystemStatusTool.js';
import {
  WorkspaceExecTool,
  WorkspaceListTool,
  WorkspaceReadTool,
  WorkspaceRoot,
  WorkspaceWriteTool,
  type ExecOptions,
} from '../adapters/tools/workspace.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

export interface CoreToolsOptions {
  /** The folder the file and exec tools are confined to (decision Q1). */
  workspaceDir: string;
  exec: ExecOptions & { enabled: boolean };
  status: () => Promise<Record<string, unknown>>;
}

/**
 * The built-in tools. The file and exec tools run in the core process, confined to the workspace
 * folder, until the workspace container takes over (F08).
 */
export class CoreToolsPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.core-tools',
    name: 'Core tools',
    version: '0.2.0',
    provides: ['tools'],
  } as const;

  constructor(private readonly options: CoreToolsOptions) {}

  register(ctx: PluginRegistrationContext): void {
    const ws = new WorkspaceRoot(this.options.workspaceDir);
    ctx.addTools([
      new MathEvaluateTool(),
      new SystemStatusTool(this.options.status),
      new WorkspaceReadTool(ws),
      new WorkspaceWriteTool(ws),
      new WorkspaceListTool(ws),
      ...(this.options.exec.enabled ? [new WorkspaceExecTool(ws, this.options.exec)] : []),
    ]);
  }
}
