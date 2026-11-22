import { describe, expect, it } from 'vitest';
import {
  DesktopActTool,
  DesktopInspectTool,
  desktopA11yTools,
} from '../../src/application/desktop/DesktopA11yTools.js';
import {
  A11Y_TREE_MAX_CHARS,
  formatA11yFind,
  formatA11yTree,
} from '../../src/application/desktop/formatTree.js';
import type { DesktopA11yTree, DesktopCapability } from '../../src/ports/SandboxDriver.js';
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

const ctx = {
  turnId: 't1',
  sessionId: 's1',
  signal: new AbortController().signal,
  log: { info() {}, warn() {}, error() {}, debug() {} },
  events: { publish() {}, subscribe() {}, subscribePattern() {} },
  writeFenced: async <T>(fn: () => Promise<T>) => fn(),
} as unknown as ToolContext;

function setup(options: { stale?: boolean; failInspect?: boolean; owner?: boolean } = {}) {
  const calls: { kind: string; request: unknown }[] = [];
  const desktop = {
    accessibility: true,
    screenshots: true,
    inspect: async (request: unknown) => {
      calls.push({ kind: 'inspect', request });
      if (options.failInspect) throw new Error('The accessibility tree is not available.');
      return tree('s4');
    },
    find: async (request: unknown) => {
      calls.push({ kind: 'find', request });
      return tree('s5');
    },
    actOnElement: async (request: { action: 'click' | 'set_text' }) => {
      calls.push({ kind: 'act', request });
      if (options.stale) throw new Error('stale, take a new snapshot');
      return {
        action: request.action,
        role: 'push button',
        name: 'Open',
        window: WINDOW,
        app: 'thunar',
      };
    },
    act: async (action: unknown) => {
      calls.push({ kind: 'xdotool', request: action });
    },
    accessibilityStatus: async () => ({ helper: true, apps: [], missing: [] }),
  } as unknown as DesktopCapability;
  return {
    calls,
    inspect: new DesktopInspectTool(desktop),
    act: new DesktopActTool(desktop, () => options.owner ?? false),
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
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's3', ref: 'e6', action: 'click' } },
      { kind: 'xdotool', request: { kind: 'type', text: '42' } },
      { kind: 'inspect', request: { window: WINDOW } },
    ]);
  });

  it('presses an allow-listed key without a ref and re-reads the active window (S56)', async () => {
    const { act, calls } = setup();
    const output = await act.run({ snapshot: 's3', action: 'key', key: 'ctrl+s' }, ctx);
    expect(output.content).toContain('Pressed ctrl+s');
    expect(calls).toEqual([
      { kind: 'xdotool', request: { kind: 'key', key: 'ctrl+s' } },
      { kind: 'inspect', request: {} },
    ]);
    expect(
      act.input.safeParse({ snapshot: 's3', action: 'key', key: 'ctrl+alt+delete' }).success,
    ).toBe(false);
    expect(act.input.safeParse({ snapshot: 's3', action: 'key' }).success).toBe(false);
  });

  it('refuses an action while the owner has control, while inspect still reads (S55)', async () => {
    const { act, inspect, calls } = setup({ owner: true });
    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('owner has control');
    expect(calls).toEqual([]);

    const tree = await inspect.run({ window: 'Thunar' }, ctx);
    expect(tree.content).toContain('snapshot s4');
  });
  it('clicks a ref, then returns a fresh tree and snapshot', async () => {
    const { act, calls } = setup();
    expect(act.target).toBe('desktop');
    expect(act.untrustedOutput).toBe(true);
    expect(effectOf(act, { snapshot: 's3', ref: 'e5', action: 'click' })).toBe('write_local');

    const output = await act.run({ snapshot: 's3', ref: 'e5', action: 'click' }, ctx);
    expect(output.content).toContain('Clicked [e5] push button "Open"');
    expect(output.content).toContain('snapshot s4');
    expect(output.data).toMatchObject({ action: 'click', ref: 'e5', snapshot: 's4' });
    expect(calls).toEqual([
      { kind: 'act', request: { snapshot: 's3', ref: 'e5', action: 'click' } },
      { kind: 'inspect', request: { window: WINDOW } },
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

  it('registers exactly the two structure-first tools', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(['desktop.inspect', 'desktop.act']);
  });
});
