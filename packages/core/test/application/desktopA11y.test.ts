import { describe, expect, it } from 'vitest';
import {
  DesktopActTool,
  DesktopInspectTool,
  DesktopWaitTool,
  desktopA11yTools,
} from '../../src/application/desktop/DesktopA11yTools.js';
import {
  A11Y_TREE_MAX_CHARS,
  formatA11yFind,
  formatA11yTree,
} from '../../src/application/desktop/formatTree.js';
import type {
  DesktopA11yTree,
  DesktopCapability,
  DesktopWindow,
} from '../../src/ports/SandboxDriver.js';
import { effectOf, type ToolContext } from '../../src/ports/Tool.js';

const WINDOW = 's54-folder - File Manager';

const tree = (snapshot = 's3'): DesktopA11yTree => ({
  app: 'thunar',
  window: WINDOW,
  snapshot,
  nodes: [
    { ref: 'e1', depth: 0, role: 'frame', name: WINDOW, states: [], actions: [] },
    { ref: 'e2', depth: 1, role: 'menu bar', name: '', states: [], actions: [] },
    { ref: 'e3', depth: 2, role: 'menu', name: 'File', states: [], actions: ['click'] },
    { ref: 'e4', depth: 2, role: 'menu', name: 'Edit', states: [], actions: ['click'] },
    {
      ref: 'e5',
      depth: 1,
      role: 'push button',
      name: 'Open',
      states: ['disabled'],
      actions: ['click'],
    },
    { ref: 'e6', depth: 1, role: 'text field', name: 'Name', states: ['editable'], actions: [] },
  ],
  total: 6,
  truncated: false,
});

const appTree = (snapshot = 's5'): DesktopA11yTree => ({
  app: 'soffice',
  window: 'soffice',
  windows: ['Question', 'Tip of the Day'],
  snapshot,
  nodes: [
    {
      ref: 'e1',
      depth: 0,
      role: 'dialog',
      name: 'Question',
      window: 'Question',
      states: [],
      actions: [],
      matched: false,
    },
    {
      ref: 'e2',
      depth: 1,
      role: 'push button',
      name: 'Use Text CSV Format',
      window: 'Question',
      states: [],
      actions: ['click'],
      matched: true,
    },
    {
      ref: 'e3',
      depth: 0,
      role: 'dialog',
      name: 'Tip of the Day',
      window: 'Tip of the Day',
      states: [],
      actions: [],
      matched: false,
    },
    {
      ref: 'e4',
      depth: 1,
      role: 'push button',
      name: 'OK',
      window: 'Tip of the Day',
      states: [],
      actions: ['click'],
      matched: true,
    },
  ],
  total: 4,
  truncated: false,
});

const replaceTree = (snapshot = 's6'): DesktopA11yTree => ({
  app: 'soffice',
  window: 'Replace?',
  snapshot,
  nodes: [
    { ref: 'e1', depth: 0, role: 'alert', name: 'Replace?', states: [], actions: [] },
    {
      ref: 'e2',
      depth: 1,
      role: 'push button',
      name: 'Replace',
      states: ['focused'],
      actions: ['click'],
    },
  ],
  total: 2,
  truncated: false,
});

const windowItem = (id: string, title: string): DesktopWindow => ({
  id,
  title,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  desktop: 0,
});

const ctx = {
  turnId: 't1',
  sessionId: 's1',
  signal: new AbortController().signal,
  log: { info() {}, warn() {}, error() {}, debug() {} },
  events: { publish() {}, subscribe() {}, subscribePattern() {} },
  writeFenced: async <T>(fn: () => Promise<T>) => fn(),
} as unknown as ToolContext;

function setup(
  options: {
    stale?: boolean;
    failInspect?: boolean;
    owner?: boolean;
    failXdotool?: boolean;
    /** Windows returned by each successive list: before, after, and the poll after a launch. */
    windows?: DesktopWindow[][];
    /** Trees returned by each successive find, for the wait tool. */
    finds?: DesktopA11yTree[];
    /** What actOnElement reports as its run action and confirmation. */
    actResult?: { ran?: string; confirmed?: boolean };
    pollMs?: number;
  } = {},
) {
  const calls: { kind: string; request: unknown }[] = [];
  let lists = 0;
  let finds = 0;
  const desktop = {
    accessibility: true,
    screenshots: true,
    inspect: async (request: unknown) => {
      calls.push({ kind: 'inspect', request });
      if (options.failInspect) throw new Error('The accessibility tree is not available.');
      const requested = (request as { window?: string }).window;
      if (requested === 'Replace?') return replaceTree('s4');
      if (requested && requested !== WINDOW && requested !== 'Thunar') {
        return { ...tree('s4'), window: requested, app: 'soffice' };
      }
      return tree('s4');
    },
    find: async (request: unknown) => {
      calls.push({ kind: 'find', request });
      if (options.finds) {
        return options.finds[Math.min(finds++, options.finds.length - 1)]!;
      }
      return (request as { app?: string }).app ? appTree('s5') : tree('s5');
    },
    windows: async () => {
      const option = options.windows ?? [[]];
      return option[Math.min(lists++, option.length - 1)]!;
    },
    windowAction: async (request: unknown) => {
      calls.push({ kind: 'window', request });
      return options.windows ? options.windows.at(-1)! : [];
    },
    actOnElement: async (request: { action: 'click' | 'set_text' }) => {
      calls.push({ kind: 'act', request });
      if (options.stale) throw new Error('stale, take a new snapshot');
      return {
        action: request.action,
        ...(options.actResult ?? { ran: request.action, confirmed: true }),
        role: 'push button',
        name: 'Open',
        window: WINDOW,
        app: 'thunar',
      };
    },
    act: async (action: unknown) => {
      calls.push({ kind: 'xdotool', request: action });
      if (options.failXdotool) throw new Error('the keyboard failed');
    },
    accessibilityStatus: async () => ({ helper: true, apps: [], missing: [] }),
  } as unknown as DesktopCapability;
  return {
    calls,
    inspect: new DesktopInspectTool(desktop),
    wait: new DesktopWaitTool(desktop, options.pollMs ?? 1),
    act: new DesktopActTool(desktop, () => options.owner ?? false, {
      pollMs: options.pollMs ?? 1,
    }),
    tools: desktopA11yTools(desktop, () => options.owner ?? false),
  };
}

describe('desktop.inspect (S54)', () => {
  it('formats the compact tree with actionable refs and folds the window into the header', () => {
    const text = formatA11yTree(tree());
    expect(text).toContain(`window "${WINDOW}" (thunar) — snapshot s3`);
    expect(text).toContain('  menu bar');
    expect(text).toContain('    menu "File" [e3]  menu "Edit" [e4]');
    expect(text).toContain('  push button "Open" [e5] (disabled)  text field "Name" [e6]');
    expect(text).not.toContain('[e1]'); // the frame is the header, not an actionable node
    expect(text).toContain('desktop.act({ snapshot: "s3", ref: "e3", action: "click" })');
    expect(text).toContain('a ref goes stale when the window changes');
  });

  it('marks an element that a pixel click cannot reach (S56)', () => {
    const text = formatA11yTree({
      ...tree(),
      nodes: [
        { ref: 'e1', depth: 0, role: 'frame', name: WINDOW, states: [], actions: [] },
        {
          ref: 'e2',
          depth: 1,
          role: 'push button',
          name: 'Export',
          states: ['offscreen'],
          actions: ['click'],
        },
      ],
      total: 2,
    });
    expect(text).toContain('push button "Export" [e2] (offscreen)');
  });

  it('reads a tree and marks its output as untrusted', async () => {
    const { inspect, calls } = setup();
    expect(inspect.target).toBe('desktop');
    expect(inspect.untrustedOutput).toBe(true);
    expect(effectOf(inspect, { window: 'Thunar' })).toBe('read');

    const output = await inspect.run({ window: 'Thunar', depth: 3 }, ctx);
    expect(calls).toEqual([{ kind: 'inspect', request: { window: 'Thunar', depth: 3 } }]);
    expect(output.content).toContain('snapshot s4');
    expect(output.data).toMatchObject({ snapshot: 's4', window: WINDOW, elements: 6 });
  });

  it('finds by name and role through the find endpoint', async () => {
    const { inspect, calls } = setup();
    const output = await inspect.run({ window: 'Thunar', find: { name: 'Open' } }, ctx);
    expect(calls).toEqual([{ kind: 'find', request: { window: 'Thunar', name: 'Open' } }]);
    expect(output.content).toContain('Matches for name "Open"');
    expect(output.content).toContain('push button "Open" [e5]');
  });

  it('searches every window of an app and groups matches by window (#151)', async () => {
    const { inspect, calls } = setup();
    const output = await inspect.run({ app: 'soffice', find: { name: 'OK', exact: true } }, ctx);
    expect(calls).toEqual([{ kind: 'find', request: { app: 'soffice', name: 'OK', exact: true } }]);
    expect(output.content).toContain('in app "soffice" (2 windows)');
    expect(output.content).toContain('window "Question"');
    expect(output.content).toContain('window "Tip of the Day"');
    expect(output.content).toContain('push button "Use Text CSV Format" [e2]');
    expect(output.data).toMatchObject({ windows: ['Question', 'Tip of the Day'] });
  });

  it('requires find with app and refuses app with window (#151)', () => {
    const { inspect } = setup();
    expect(inspect.input.safeParse({ app: 'soffice' }).success).toBe(false);
    expect(
      inspect.input.safeParse({ app: 'soffice', window: 'Save', find: { name: 'OK' } }).success,
    ).toBe(false);
    expect(inspect.input.safeParse({ app: 'soffice', find: { name: 'OK' } }).success).toBe(true);
  });

  it('cuts a large tree at about 8,000 tokens and says how to ask for a sub-tree', () => {
    const nodes = [
      { ref: 'e1', depth: 0, role: 'frame', name: WINDOW, states: [], actions: [] },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        ref: `e${index + 2}`,
        depth: 1 + (index % 5),
        role: 'push button',
        name: `Element ${index} ${'x'.repeat(40)}`,
        states: [],
        actions: ['click'],
      })),
    ];
    const text = formatA11yTree({ ...tree(), nodes, total: nodes.length });
    expect(text.length).toBeLessThanOrEqual(A11Y_TREE_MAX_CHARS);
    expect(text).toContain('Tree cut at about 8,000 tokens');
    expect(text).toContain(`desktop.inspect({ window: "${WINDOW}", ref: "e2", depth: 3 })`);
  });

  it('formats matches as a flat list', () => {
    const text = formatA11yFind(tree('s9'), { role: 'push button' });
    expect(text).toContain(`Matches for role "push button" in window "${WINDOW}" — snapshot s9`);
    expect(text).toContain('  push button "Open" [e5] (disabled)');
    expect(text).toContain('Snapshot s9.');
  });

  it('surfaces a helper failure as an error result', async () => {
    const { inspect } = setup({ failInspect: true });
    const output = await inspect.run({ window: 'Thunar' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('not available');
  });
});

describe('desktop.act (S54)', () => {
  it('types into a ref through the keyboard after focusing it (S56)', async () => {
    const { act, calls } = setup();
    const output = await act.run({ snapshot: 's3', ref: 'e6', action: 'type', text: '42' }, ctx);
    expect(output.content).toContain('Typed 2 characters into [e6]');
    expect(output.content).toContain(
      'Focus: push button "Open" [e6] in "s54-folder - File Manager".',
    );
    expect(output.content).toContain('No window appeared or closed.');
    expect(output.content).toContain('other refs from snapshot s3 still work');
    expect(output.data).toMatchObject({ snapshot: 's3' });
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's3', ref: 'e6', action: 'click' } },
      { kind: 'xdotool', request: { kind: 'type', text: '42' } },
    ]);
  });

  it('presses an allow-listed key and says the app does not confirm it (#151)', async () => {
    const { act, calls } = setup();
    const output = await act.run({ snapshot: 's3', action: 'key', key: 'ctrl+s' }, ctx);
    expect(output.content).toContain('Pressed ctrl+s (sent, unconfirmed; no retry).');
    expect(output.content).toContain('No window appeared or closed.');
    expect(calls).toEqual([{ kind: 'xdotool', request: { kind: 'key', key: 'ctrl+s' } }]);
    expect(
      act.input.safeParse({ snapshot: 's3', action: 'key', key: 'ctrl+alt+delete' }).success,
    ).toBe(false);
    expect(act.input.safeParse({ snapshot: 's3', action: 'key' }).success).toBe(false);
  });

  it('launches an allowed app and reports the window it opens (S56, #151)', async () => {
    const { act, calls } = setup({
      windows: [[], [], [windowItem('0x2', 'LibreOffice Calc')]],
    });
    const output = await act.run({ snapshot: 's1', action: 'launch_app', app: 'libreoffice' }, ctx);
    expect(output.content).toContain('Launched libreoffice');
    expect(output.content).toContain('New window appeared: soffice — "LibreOffice Calc".');
    expect(output.data).toMatchObject({ snapshot: 's4', appeared: ['LibreOffice Calc'] });
    expect(calls).toEqual([
      { kind: 'xdotool', request: { kind: 'launch_app', app: 'libreoffice' } },
      { kind: 'inspect', request: { window: 'LibreOffice Calc' } },
    ]);
    expect(
      act.input.safeParse({ snapshot: 's1', action: 'launch_app', app: 'firefox' }).success,
    ).toBe(false);
    expect(act.input.safeParse({ snapshot: 's1', action: 'launch_app' }).success).toBe(false);
  });

  it('runs a short keyboard sequence as one call and stops at the first failure (S56 follow-up)', async () => {
    const { act, calls } = setup();
    const output = await act.run(
      { snapshot: 's1', ref: 'e3', steps: [{ type: '42' }, { key: 'Tab' }, { type: '7' }] },
      ctx,
    );
    expect(output.content).toContain('Ran 3 steps after focusing [e3]');
    expect(output.content).toContain('No window appeared or closed.');
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's1', ref: 'e3', action: 'click' } },
      { kind: 'xdotool', request: { kind: 'type', text: '42' } },
      { kind: 'xdotool', request: { kind: 'key', key: 'Tab' } },
      { kind: 'xdotool', request: { kind: 'type', text: '7' } },
    ]);
    expect(
      act.input.safeParse({
        steps: Array.from({ length: 21 }, () => ({ key: 'Tab' })),
      }).success,
    ).toBe(false);
  });

  it('says which batch step failed', async () => {
    const { act } = setup({ failXdotool: true });
    const output = await act.run({ steps: [{ type: '42' }, { key: 'Tab' }, { type: '7' }] }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('Step 1 of 3');
    expect(output.content).toContain('type "42"');
  });

  it('refuses an action while the owner has control, while inspect still reads (S55)', async () => {
    const { act, inspect, calls } = setup({ owner: true });
    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('owner has control');
    expect(output.content.split('\n')).toHaveLength(2);
    expect(output.content.split('\n')[1]).toMatch(/^Remedy: /);
    expect(calls).toEqual([]);

    const tree = await inspect.run({ window: 'Thunar' }, ctx);
    expect(tree.content).toContain('snapshot s4');
  });

  it('clicks a ref and reports its focus without re-reading the window (#151)', async () => {
    const { act, calls } = setup();
    expect(act.target).toBe('desktop');
    expect(act.untrustedOutput).toBe(true);
    expect(effectOf(act, { snapshot: 's3', ref: 'e5', action: 'click' })).toBe('write_local');

    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.content).toContain('Clicked [e5] push button "Open"');
    expect(output.content).toContain('Focus: push button "Open" [e5]');
    expect(output.content).toContain('other refs from snapshot s3 still work');
    expect(output.content).not.toContain('snapshot s4');
    expect(output.data).toMatchObject({ action: 'click', ref: 'e5', snapshot: 's3' });
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's3', ref: 'e5', action: 'click' } },
    ]);
  });

  it('tries press|click in order and reports which ran, or unconfirmed (#151)', async () => {
    const { act, calls } = setup({ actResult: { ran: 'press', confirmed: true } });
    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'press|click' }, ctx);
    expect(output.content).toContain('Ran press|click on [e5]');
    expect(output.content).toContain('(ran press)');
    expect(output.content).not.toContain('unconfirmed');
    expect(calls[0]).toEqual({
      kind: 'act',
      request: { snapshot: 's3', ref: 'e5', action: 'press|click' },
    });

    const { act: unsure } = setup({ actResult: { ran: 'focus', confirmed: false } });
    const unsureOut = await unsure.run({ snapshot: 's3', ref: 'e5', action: 'press|click' }, ctx);
    expect(unsureOut.content).toContain('(ran focus)');
    expect(unsureOut.content).toContain('sent, unconfirmed; no retry');
  });

  it('only accepts known press names in a fallback list (#151)', () => {
    const { act } = setup();
    expect(act.input.safeParse({ snapshot: 's3', ref: 'e5', action: 'press|click' }).success).toBe(
      true,
    );
    expect(act.input.safeParse({ snapshot: 's3', ref: 'e5', action: 'press|nope' }).success).toBe(
      false,
    );
    expect(act.input.safeParse({ snapshot: 's3', ref: 'e5', action: 'click' }).success).toBe(true);
    expect(act.input.safeParse({ snapshot: 's3', ref: 'e5', action: 'set_text' }).success).toBe(
      false,
    );
  });

  it('reports the modal alert a click opened, with its refs (#151)', async () => {
    const { act, calls } = setup({
      windows: [[], [windowItem('0x9', 'Replace?')]],
    });
    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.content).toContain('New window appeared: soffice — "Replace?".');
    expect(output.content).toContain('push button "Replace" [e2] (focused)');
    expect(output.content).toContain('Focus: push button "Replace" [e2] in "Replace?"');
    expect(output.content).not.toContain('other refs from snapshot s3');
    expect(output.data).toMatchObject({
      snapshot: 's4',
      window: 'Replace?',
      appeared: ['Replace?'],
    });
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's3', ref: 'e5', action: 'click' } },
      { kind: 'inspect', request: { window: 'Replace?' } },
    ]);
  });

  it('reports a window that closed (#151)', async () => {
    const { act, calls } = setup({
      windows: [[windowItem('0x9', 'Replace?')], []],
    });
    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.content).toContain('Closed window "Replace?".');
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's3', ref: 'e5', action: 'click' } },
    ]);
  });

  it('sets text as one value and never echoes it in the result', async () => {
    const { act } = setup();
    const output = await act.run(
      { snapshot: 's3', ref: 'e6', action: 'set_text', text: 'hello' },
      ctx,
    );
    expect(output.content).toContain('Set the text of [e6]');
    expect(output.content).toContain('(5 characters)');
    expect(output.content).not.toContain('hello');
  });

  it('refuses a stale ref with the message the model must act on', async () => {
    const { act } = setup({ stale: true });
    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('stale, take a new snapshot');
  });

  it('gives every error a second line with the remedy (#151)', async () => {
    const { act, inspect } = setup({ stale: true, failInspect: true });
    const stale = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    const staleLines = stale.content.split('\n');
    expect(staleLines).toHaveLength(2);
    expect(staleLines[0]).toContain('stale, take a new snapshot');
    expect(staleLines[1]).toMatch(/^Remedy: /);
    expect(staleLines[1]).toContain('desktop.inspect');

    const read = await inspect.run({ window: 'Thunar' }, ctx);
    const readLines = read.content.split('\n');
    expect(readLines).toHaveLength(2);
    expect(readLines[1]).toMatch(/^Remedy: /);
  });

  it('registers exactly the five desktop tools', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual([
      'desktop.inspect',
      'desktop.wait',
      'desktop.windows',
      'desktop.window',
      'desktop.act',
    ]);
  });
});

describe('desktop.windows and desktop.window (#151)', () => {
  const alert = { ...windowItem('0x2', 'Replace?'), app: 'soffice' };

  it('lists the windows with their app, geometry and id', async () => {
    const { tools } = setup({ windows: [[alert]] });
    const windowsTool = tools.find((tool) => tool.name === 'desktop.windows')!;
    const windowTool = tools.find((tool) => tool.name === 'desktop.window')!;
    expect(windowsTool.untrustedOutput).toBe(true);
    expect(windowTool.untrustedOutput).toBe(true);
    const output = await windowsTool.run({}, ctx);
    expect(output.content).toContain('1 window:');
    expect(output.content).toContain('window "Replace?" (soffice) 100x100 at 0,0 [0x2]');
  });

  it('moves, resizes and focuses a window by id, reporting the geometry', async () => {
    const { tools, calls } = setup({ windows: [[alert]] });
    const windowTool = tools.find((tool) => tool.name === 'desktop.window')!;

    const moved = await windowTool.run({ window: '0x2', action: 'move', x: 10, y: 20 }, ctx);
    expect(moved.content).toContain(
      'Moved window "Replace?" (soffice) 100x100 at 0,0 [0x2] to 10,20.',
    );
    expect(calls).toContainEqual({
      kind: 'window',
      request: { window: '0x2', action: 'move', x: 10, y: 20 },
    });

    const resized = await windowTool.run(
      { window: 'Replace?', action: 'resize', width: 800, height: 600 },
      ctx,
    );
    expect(resized.content).toContain('Resized window "Replace?"');
    expect(resized.content).toContain('to 800x600');

    const focused = await windowTool.run({ window: '0x2', action: 'focus' }, ctx);
    expect(focused.content).toContain('Focused window "Replace?"');
  });

  it('requires coordinates for move and a size for resize (#151)', () => {
    const { tools } = setup();
    const windowTool = tools.find((tool) => tool.name === 'desktop.window')!;
    expect(windowTool.input.safeParse({ window: 'x', action: 'move' }).success).toBe(false);
    expect(windowTool.input.safeParse({ window: 'x', action: 'resize', width: 800 }).success).toBe(
      false,
    );
    expect(windowTool.input.safeParse({ window: 'x', action: 'focus', x: 1 }).success).toBe(false);
    expect(windowTool.input.safeParse({ window: 'x', action: 'focus' }).success).toBe(true);
  });

  it('refuses to move or focus a window while the owner has control (#151)', async () => {
    const { tools, calls } = setup({ owner: true, windows: [[alert]] });
    const windowTool = tools.find((tool) => tool.name === 'desktop.window')!;
    const windowsTool = tools.find((tool) => tool.name === 'desktop.windows')!;

    const refused = await windowTool.run({ window: '0x2', action: 'focus' }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('owner has control');
    expect(refused.content.split('\n')).toHaveLength(2);
    expect(refused.content.split('\n')[1]).toMatch(/^Remedy: /);
    expect(calls).toEqual([]);

    const listed = await windowsTool.run({}, ctx);
    expect(listed.content).toContain('window "Replace?"');
  });
});

describe('desktop.wait (#151)', () => {
  it('waits for an element and returns its refs without another inspect', async () => {
    const { wait, calls } = setup();
    const output = await wait.run({ find: { name: 'OK' } }, ctx);
    expect(output.content).toContain('Present after');
    expect(output.content).toContain('Matches for name "OK"');
    expect(output.data).toMatchObject({ state: 'present', present: true, timedOut: false });
    expect(calls[0]).toEqual({ kind: 'find', request: { name: 'OK' } });
    expect(effectOf(wait, { find: { name: 'OK' } })).toBe('read');
  });

  it('polls until the element appears', async () => {
    const empty: DesktopA11yTree = { ...tree('s5'), nodes: [], total: 0 };
    const { wait, calls } = setup({ finds: [empty, empty, appTree('s9')] });
    const output = await wait.run({ find: { name: 'OK' }, timeoutMs: 5_000 }, ctx);
    expect(output.content).toContain('Present after');
    expect(output.content).toContain('Matches for name "OK"');
    expect(calls.filter((call) => call.kind === 'find')).toHaveLength(3);
  });

  it('treats a timeout as a normal result, not an error', async () => {
    const empty: DesktopA11yTree = { ...tree('s5'), nodes: [], total: 0 };
    const { wait } = setup({ finds: [empty] });
    const output = await wait.run({ find: { name: 'Nope' }, timeoutMs: 50 }, ctx);
    expect(output.isError).toBeUndefined();
    expect(output.content).toContain('Timed out after');
    expect(output.content).toContain('name "Nope"');
    expect(output.data).toMatchObject({ present: false, timedOut: true });
  });

  it('waits for a window to appear, and for one to disappear', async () => {
    const { wait } = setup({ windows: [[], [windowItem('0x3', 'Save')]] });
    const present = await wait.run({ window: 'Save', timeoutMs: 5_000 }, ctx);
    expect(present.content).toContain('Present after');
    expect(present.content).toContain('window "Save" 100x100 at 0,0');

    const { wait: disappearing } = setup({
      windows: [[windowItem('0x3', 'Save')], []],
    });
    const gone = await disappearing.run({ window: 'Save', state: 'absent', timeoutMs: 5_000 }, ctx);
    expect(gone.content).toContain('Gone after');
    expect(gone.data).toMatchObject({ state: 'absent', present: false, timedOut: false });
  });

  it('requires a target and a timeout in range (#151)', () => {
    const { wait } = setup();
    expect(wait.input.safeParse({}).success).toBe(false);
    expect(wait.input.safeParse({ find: { name: 'OK' }, timeoutMs: 1 }).success).toBe(false);
    expect(wait.input.safeParse({ find: { name: 'OK' }, app: 'soffice' }).success).toBe(true);
    expect(
      wait.input.safeParse({ window: 'Save', app: 'soffice', find: { name: 'OK' } }).success,
    ).toBe(false);
  });
});
