import { readWorkspaceFile } from '../checks.js';
import type { Scenario } from '../types.js';

/** A workspace write is harmless and runs without asking. */
export const workspaceFile: Scenario = {
  id: 'workspace-file',
  title: 'Writes a file in the workspace',
  message: 'Write a file named notes.txt in your workspace containing the single word chestnut.',
  steps: [
    {
      toolCalls: [
        {
          id: 'w1',
          name: 'workspace.write',
          arguments: { path: 'notes.txt', content: 'chestnut' },
        },
      ],
    },
    { text: 'Written.' },
  ],
  check: async ({ workspaceDir, receipts }) => {
    const content = await readWorkspaceFile(workspaceDir, 'notes.txt');
    return [
      {
        name: 'notes.txt contains chestnut',
        passed: content?.includes('chestnut') ?? false,
        ...(content === undefined && { detail: 'notes.txt was not written' }),
      },
      {
        name: 'the write tool ran',
        passed: receipts.some((r) => r.tool === 'workspace.write' && r.outcome === 'ok'),
      },
    ];
  },
};
