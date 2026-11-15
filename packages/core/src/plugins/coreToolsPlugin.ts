import { CalculatorTool } from '../adapters/tools/CalculatorTool.js';
import { ExecuteCommandTool } from '../adapters/tools/ExecuteCommandTool.js';
import { FileListTool, FileReadTool, FileWriteTool } from '../adapters/tools/FileSystemTool.js';
import { SystemInfoTool } from '../adapters/tools/SystemInfoTool.js';
import { WebSearchTool } from '../adapters/tools/WebSearchTool.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

/**
 * Today's built-in tools. The shell and file tools run on the host without a sandbox (bugs 6 and 7
 * in docs/00-current-state.md) until F05 and F08 move them into the workspace container.
 */
export class CoreToolsPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.core-tools',
    name: 'Core tools',
    version: '0.1.0',
    provides: ['tools'],
  } as const;

  register(ctx: PluginRegistrationContext): void {
    ctx.addTools([
      new CalculatorTool(),
      new WebSearchTool(),
      new FileReadTool(),
      new FileWriteTool(),
      new FileListTool(),
      new ExecuteCommandTool(),
      new SystemInfoTool(),
    ]);
  }
}
