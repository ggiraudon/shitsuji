import type { SandboxFiles } from '../../../ports/SandboxDriver.js';
import type { Tool } from '../../../ports/Tool.js';
import {
  WorkspaceExecTool,
  WorkspaceListTool,
  WorkspaceReadTool,
  WorkspaceSendTool,
  WorkspaceWriteTool,
  type ExecOptions,
} from './workspace.js';

/**
 * The workspace tools a sandbox provides (F08): the file tools when it has files, `workspace.exec`
 * only when it can also run programs and the config allows it (decision Q1). Core owns these
 * definitions; a driver only supplies the capabilities.
 */
export function workspaceTools(
  files: SandboxFiles,
  exec: (ExecOptions & { enabled: boolean }) | undefined,
): Tool[] {
  return [
    new WorkspaceReadTool(files),
    new WorkspaceWriteTool(files),
    new WorkspaceListTool(files),
    new WorkspaceSendTool(files),
    ...(exec?.enabled ? [new WorkspaceExecTool(files, exec)] : []),
  ];
}
