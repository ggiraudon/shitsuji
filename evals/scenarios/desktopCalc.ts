import { readWorkspaceFile, ran } from '../checks.js';
import type { Scenario } from '../types.js';
import { CalcDesktop } from '../calcDesktop.js';

/** The same Calc task through the tree, with no pixel sent to the model (S56). */
export const desktopCalcStructure: Scenario = {
  id: 'desktop-calc-structure',
  title: 'Calc through desktop.inspect and desktop.act',
  message:
    'Open LibreOffice Calc, put 42 in A1 and 7 in B1, save it as calc.csv in /workspace, and show me the file.',
  exec: true,
  desktop: (workspaceDir) => new CalcDesktop(workspaceDir),
  steps: [
    {
      toolCalls: [
        {
          id: 's0',
          name: 'desktop.act',
          arguments: { snapshot: 's1', action: 'launch_app', app: 'libreoffice' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's1',
          name: 'desktop.inspect',
          arguments: { window: 'LibreOffice Calc' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's2',
          name: 'desktop.act',
          arguments: { snapshot: 's1', ref: 'e3', action: 'type', text: '42' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's3',
          name: 'desktop.act',
          arguments: { snapshot: 's1', action: 'key', key: 'Return' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's4',
          name: 'desktop.act',
          arguments: { snapshot: 's1', ref: 'e4', action: 'type', text: '7' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's5',
          name: 'desktop.act',
          arguments: { snapshot: 's1', action: 'key', key: 'Return' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's6',
          name: 'desktop.act',
          arguments: { snapshot: 's1', action: 'key', key: 'ctrl+s' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 's7',
          name: 'workspace.exec',
          arguments: { program: 'cat', args: ['calc.csv'] },
        },
      ],
    },
    { text: 'Saved 42 and 7 in /workspace/calc.csv.' },
  ],
  check: async ({ workspaceDir, receipts, reply, imagesSent }) => {
    const content = await readWorkspaceFile(workspaceDir, 'calc.csv');
    return [
      {
        name: 'calc.csv has the two values',
        passed: content?.includes('42') === true && content.includes('7'),
        ...(content === undefined && { detail: 'calc.csv was not written' }),
      },
      {
        name: 'the tree tools did the work',
        passed: ran(receipts, 'desktop.inspect') && ran(receipts, 'desktop.act'),
      },
      {
        name: 'no screenshot reached the model',
        passed: imagesSent === 0,
        ...(imagesSent !== 0 && { detail: `${imagesSent} image parts` }),
      },
      {
        name: 'no computer.act call',
        passed: receipts.every((receipt) => receipt.tool !== 'computer.act'),
      },
      {
        name: 'the reply names the file',
        passed: reply.includes('/workspace/calc.csv'),
        ...(!reply.includes('/workspace/calc.csv') && { detail: reply }),
      },
    ];
  },
};

/** The same Calc task through pixels, for the token comparison (S56). */
export const desktopCalcScreens: Scenario = {
  id: 'desktop-calc-screens',
  title: 'Calc through computer.act',
  message:
    'Open LibreOffice Calc, put 42 in A1 and 7 in B1, save it as calc.csv in /workspace, and show me the file.',
  exec: true,
  vision: true,
  desktop: (workspaceDir) => new CalcDesktop(workspaceDir),
  steps: [
    {
      toolCalls: [
        { id: 'c1', name: 'computer.act', arguments: { action: 'launch_app', app: 'libreoffice' } },
      ],
    },
    {
      toolCalls: [
        { id: 'c2', name: 'computer.act', arguments: { action: 'click', x: 100, y: 200 } },
      ],
    },
    {
      toolCalls: [{ id: 'c3', name: 'computer.act', arguments: { action: 'type', text: '42' } }],
    },
    {
      toolCalls: [{ id: 'c4', name: 'computer.act', arguments: { action: 'key', key: 'Tab' } }],
    },
    {
      toolCalls: [{ id: 'c5', name: 'computer.act', arguments: { action: 'type', text: '7' } }],
    },
    {
      toolCalls: [
        { id: 'c6', name: 'computer.act', arguments: { action: 'click', x: 900, y: 40 } },
      ],
    },
    {
      toolCalls: [
        {
          id: 'c7',
          name: 'workspace.exec',
          arguments: { program: 'cat', args: ['calc.csv'] },
        },
      ],
    },
    { text: 'Saved 42 and 7 in /workspace/calc.csv.' },
  ],
  check: async ({ workspaceDir, receipts, reply, imagesSent }) => {
    const content = await readWorkspaceFile(workspaceDir, 'calc.csv');
    return [
      {
        name: 'calc.csv has the two values',
        passed: content?.includes('42') === true && content.includes('7'),
        ...(content === undefined && { detail: 'calc.csv was not written' }),
      },
      {
        name: 'computer.act did the work',
        passed: ran(receipts, 'computer.act'),
      },
      {
        name: 'screenshots reached the model',
        passed: (imagesSent ?? 0) > 0,
        detail: `${imagesSent ?? 0} image parts`,
      },
      {
        name: 'the reply names the file',
        passed: reply.includes('/workspace/calc.csv'),
        ...(!reply.includes('/workspace/calc.csv') && { detail: reply }),
      },
    ];
  },
};
