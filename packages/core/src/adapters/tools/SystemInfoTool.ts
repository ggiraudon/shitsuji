import { BaseTool, type ToolResult, type ToolExecuteParams } from '../../ports/LegacyTool.js';
import { hostname, cpus, totalmem, freemem, uptime, platform, arch, version } from 'os';

export class SystemInfoTool extends BaseTool {
  readonly name = 'system_info';
  readonly description = 'Get information about the system running the agent.';
  readonly schema = {
    type: 'object',
    properties: {},
  };

  async execute(_params: ToolExecuteParams): Promise<ToolResult> {
    const info = {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      nodeVersion: version(),
      uptime: `${Math.floor(uptime() / 3600)}h ${Math.floor((uptime() % 3600) / 60)}m`,
      cpus: cpus().length,
      memory: {
        total: `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB`,
        free: `${Math.round(freemem() / 1024 / 1024 / 1024)} GB`,
      },
    };

    return {
      success: true,
      result: JSON.stringify(info, null, 2),
    };
  }
}
