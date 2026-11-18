import type { Scenario } from '../types.js';

/** A plain question: the model answers without touching any tool. */
export const plainAnswer: Scenario = {
  id: 'plain-answer',
  title: 'Answers a plain question with no tools',
  message: 'Good evening. In one sentence, who are you?',
  steps: [{ text: 'I am Shitsuji, your butler.' }],
  check: ({ reply, receipts }) => [
    { name: 'reply names the butler', passed: /shitsuji/i.test(reply), detail: reply },
    { name: 'no tools ran', passed: receipts.length === 0 },
  ],
};
