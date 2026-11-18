import { MathEvaluateTool } from '../adapters/tools/MathEvaluateTool.js';
import { SystemStatusTool } from '../adapters/tools/SystemStatusTool.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

export interface CoreToolsOptions {
  status: () => Promise<Record<string, unknown>>;
}

/**
 * The built-in tools that are not about where the agent runs. The workspace tools belong to the
 * sandbox driver (F08, S40): composition registers the ones the open sandbox provides.
 */
export class CoreToolsPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.core-tools',
    name: 'Core tools',
    version: '0.3.0',
    provides: ['tools'],
  } as const;

  constructor(private readonly options: CoreToolsOptions) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addTools([new MathEvaluateTool(), new SystemStatusTool(this.options.status)]);
  }
}
