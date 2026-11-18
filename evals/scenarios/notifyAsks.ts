import type { Scenario } from '../types.js';

/** The request is vague, so the judge asks; the harness approves and the action runs once. */
export const notifyAsks: Scenario = {
  id: 'notify-asks',
  title: 'Asks before notifying when the request is vague',
  message: 'Let the team know how the build went.',
  steps: [
    {
      toolCalls: [{ id: 'n2', name: 'test.notify', arguments: { text: 'The build passed.' } }],
    },
    { text: 'They know.' },
  ],
  judge: 'ask',
  approvals: 'approve',
  check: ({ mailbox, approvals, receipts }) => [
    {
      name: 'one notification after the approval',
      passed:
        mailbox.notifications.length === 1 &&
        mailbox.notifications[0]!.text.includes('build passed'),
      detail: `${mailbox.notifications.length} notification(s)`,
    },
    {
      name: 'a card was asked and approved',
      passed: approvals.some((a) => a.tool === 'test.notify' && a.status === 'approved'),
      detail: approvals.map((a) => `${a.tool}:${a.status}`).join(', '),
    },
    {
      name: 'the notify tool ran once',
      passed: receipts.filter((r) => r.tool === 'test.notify' && r.outcome === 'ok').length === 1,
    },
  ],
};
