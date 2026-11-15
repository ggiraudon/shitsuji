import { BaseTool, type ToolResult, type ToolExecuteParams } from '../base.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class ExecuteCommandTool extends BaseTool {
  readonly name = 'execute_command';
  readonly description = 'Execute a shell command and return its output. Use with caution.';
  readonly schema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['command'],
  };

  private readonly defaultTimeout = 30000;
  private readonly allowedCommands = ['ls', 'cat', 'pwd', 'echo', 'grep', 'find', 'git', 'node', 'npm', 'pnpm'];

  async execute(params: ToolExecuteParams): Promise<ToolResult> {
    const { command, timeout } = params.args as { command?: string; timeout?: number };

    if (typeof command !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Command must be a string',
      };
    }

    const cmd = command.trim();
    const isAllowed = this.allowedCommands.some(allowed => cmd.startsWith(allowed));
    
    if (!isAllowed) {
      return {
        success: false,
        result: '',
        error: `Command not allowed. Allowed: ${this.allowedCommands.join(', ')}`,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, { 
        timeout: timeout ?? this.defaultTimeout,
        maxBuffer: 1024 * 1024,
      });

      let output = stdout;
      if (stderr) {
        output += `\nStderr: ${stderr}`;
      }

      return {
        success: true,
        result: output || '(no output)',
      };
    } catch (error: unknown) {
      return {
        success: false,
        result: '',
        error: (error instanceof Error && error.message) || String(error),
      };
    }
  }
}
