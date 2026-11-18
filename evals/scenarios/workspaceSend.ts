import type { Scenario } from '../types.js';

/**
 * Sending the owner a file is external but expected: the shipped `trust.rules` allows
 * `workspace.send`, so it must show as a rule-based allow and raise no card (X4).
 */
export const workspaceSend: Scenario = {
  id: 'workspace-send',
  title: 'Sends a file without a card',
  message: 'Write notes.txt in your workspace saying chestnut, then send it to me.',
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
    {
      toolCalls: [
        {
          id: 's1',
          name: 'workspace.send',
          arguments: { path: 'notes.txt', caption: 'Notes' },
        },
      ],
    },
    { text: 'Sent.' },
  ],
  check: ({ receipts, approvals, reply }) => {
    const sent = receipts.find((r) => r.tool === 'workspace.send');
    return [
      {
        name: 'workspace.send is external and allowed by the shipped rule',
        passed:
          sent?.outcome === 'ok' && sent.effect === 'external' && sent.allowedBy?.kind === 'rule',
        ...(sent === undefined
          ? { detail: 'workspace.send did not run' }
          : { detail: `${sent.outcome}, ${sent.effect}, ${sent.allowedBy?.kind ?? 'no'} basis` }),
      },
      {
        name: 'no card was raised',
        passed: approvals.length === 0,
        ...(approvals.length ? { detail: approvals.map((a) => a.tool).join(', ') } : {}),
      },
      { name: 'the reply says it was sent', passed: reply.includes('Sent.') },
    ];
  },
};
