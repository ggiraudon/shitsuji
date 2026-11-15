import { BaseTool, type ToolResult, type ToolExecuteParams } from '../base.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';

export class FileReadTool extends BaseTool {
  readonly name = 'file_read';
  readonly description = 'Read the contents of a file from the filesystem.';
  readonly schema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read',
      },
    },
    required: ['path'],
  };

  async execute(params: ToolExecuteParams): Promise<ToolResult> {
    const { path } = params.args;

    if (typeof path !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Path must be a string',
      };
    }

    try {
      const resolvedPath = resolve(path);

      if (!existsSync(resolvedPath)) {
        return {
          success: false,
          result: '',
          error: `File not found: ${path}`,
        };
      }

      const stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        return {
          success: false,
          result: '',
          error: `Not a file: ${path}`,
        };
      }

      const content = readFileSync(resolvedPath, 'utf-8');

      if (content.length > 10000) {
        return {
          success: true,
          result: content.slice(0, 10000) + '\n\n... (truncated)',
        };
      }

      return {
        success: true,
        result: content,
      };
    } catch (error) {
      return {
        success: false,
        result: '',
        error: `Read error: ${String(error)}`,
      };
    }
  }
}

export class FileWriteTool extends BaseTool {
  readonly name = 'file_write';
  readonly description =
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.";
  readonly schema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['path', 'content'],
  };

  async execute(params: ToolExecuteParams): Promise<ToolResult> {
    const { path, content } = params.args;

    if (typeof path !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Path must be a string',
      };
    }

    if (typeof content !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Content must be a string',
      };
    }

    try {
      const resolvedPath = resolve(path);
      const dir = dirname(resolvedPath);

      const dirExists = existsSync(dir);
      if (!dirExists) {
        return {
          success: false,
          result: '',
          error: `Directory does not exist: ${dir}`,
        };
      }

      writeFileSync(resolvedPath, content, 'utf-8');

      return {
        success: true,
        result: `Written ${content.length} bytes to ${path}`,
      };
    } catch (error) {
      return {
        success: false,
        result: '',
        error: `Write error: ${String(error)}`,
      };
    }
  }
}

export class FileListTool extends BaseTool {
  readonly name = 'file_list';
  readonly description = 'List files in a directory.';
  readonly schema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the directory to list',
      },
    },
    required: ['path'],
  };

  async execute(params: ToolExecuteParams): Promise<ToolResult> {
    const { path } = params.args;

    if (typeof path !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Path must be a string',
      };
    }

    try {
      const resolvedPath = resolve(path);

      if (!existsSync(resolvedPath)) {
        return {
          success: false,
          result: '',
          error: `Directory not found: ${path}`,
        };
      }

      const stats = statSync(resolvedPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          result: '',
          error: `Not a directory: ${path}`,
        };
      }

      const files = readdirSync(resolvedPath);
      const items = files.map((f) => {
        const fullPath = join(resolvedPath, f);
        const isDir = statSync(fullPath).isDirectory();
        return isDir ? `${f}/` : f;
      });

      return {
        success: true,
        result: items.join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        result: '',
        error: `List error: ${String(error)}`,
      };
    }
  }
}
