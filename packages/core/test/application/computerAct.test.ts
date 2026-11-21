import { describe, expect, it } from 'vitest';
import { ComputerActTool } from '../../src/application/desktop/ComputerActTool.js';
import type { DesktopCapability, SandboxFiles } from '../../src/ports/SandboxDriver.js';
import type { ToolContext } from '../../src/ports/Tool.js';

const image = {
  mediaType: 'image/png' as const,
  data: new Uint8Array([1, 2, 3]),
  width: 1280,
  height: 800,
  originalWidth: 1440,
  originalHeight: 900,
  scale: 1280 / 1440,
};

const setup = (scale = 1280 / 1440) => {
  const writes: { ref: string; bytes: Uint8Array }[] = [];
  const files = {
    resolve: async (ref: string) => `/workspace/${ref}`,
    writeBytes: async (absolute: string, bytes: Uint8Array) => {
      writes.push({ ref: absolute, bytes });
    },
  } as unknown as SandboxFiles;
  const actions: unknown[] = [];
  const desktop = {
    accessibility: false,
    screenshots: true,
    state: async () => ({ display: ':0', width: 1440, height: 900 }),
    screenshot: async () => ({ ...image, scale }),
    windows: async () => [],
    act: async (action: unknown) => {
      actions.push(action);
    },
    ocr: async () => ({ text: 'S53-MARKER' }),
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
  } as unknown as DesktopCapability;
  const ctx = {
    turnId: 't1',
    sessionId: 's1',
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    events: { publish() {}, subscribe() {}, subscribePattern() {} },
    writeFenced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as ToolContext;
  return { tool: new ComputerActTool(files, desktop), writes, actions, ctx };
};

describe('computer.act (S53)', () => {
  it('performs the click and returns a fresh screenshot reference, never bytes', async () => {
    const { tool, writes, actions, ctx } = setup();
    const output = await tool.run({ action: 'click', x: 10, y: 20 }, ctx);

    expect(actions).toEqual([{ kind: 'click', x: 11, y: 23 }]);
    expect(writes).toEqual([
      { ref: '/workspace/sessions/s1/images/computer-t1-1.png', bytes: image.data },
    ]);
    expect(output.images).toEqual([
      {
        mediaType: 'image/png',
        ref: 'sessions/s1/images/computer-t1-1.png',
        name: 'computer-t1-1.png',
      },
    ]);
    expect(output.content).toContain('Clicked left at (10, 20).');
    expect(output.content).toContain('1280x800 px');
    expect(JSON.stringify(output)).not.toContain('base64');
  });

  it('maps input with the scale of the last screenshot, not a fresh fit', async () => {
    const { tool, actions, ctx } = setup(0.5);
    await tool.run({ action: 'screenshot' }, ctx);
    await tool.run({ action: 'click', x: 100, y: 100 }, ctx);
    expect(actions).toEqual([{ kind: 'click', x: 200, y: 200 }]);
  });

  it('marks screenshot, move and OCR as read, the rest write_local', () => {
    const { tool } = setup();
    expect(tool.effect({ action: 'screenshot' })).toBe('read');
    expect(tool.effect({ action: 'move', x: 1, y: 2 })).toBe('read');
    expect(tool.effect({ action: 'ocr' })).toBe('read');
    expect(tool.effect({ action: 'click', x: 1, y: 2 })).toBe('write_local');
    expect(tool.effect({ action: 'type', text: 'x' })).toBe('write_local');
    expect(tool.effect({ action: 'launch_app', app: 'thunar' })).toBe('write_local');
  });

  it('includes OCR text and still returns the screenshot', async () => {
    const { tool, ctx } = setup();
    const output = await tool.run(
      { action: 'ocr', region: { x: 1, y: 2, width: 300, height: 100 } },
      ctx,
    );
    expect(output.content).toContain('S53-MARKER');
    expect(output.images).toHaveLength(1);
  });

  it('waits without touching the desktop, then screenshots', async () => {
    const { tool, actions, ctx } = setup();
    const output = await tool.run({ action: 'wait', ms: 1 }, ctx);
    expect(actions).toEqual([]);
    expect(output.content).toContain('Waited 1 ms.');
    expect(output.images).toHaveLength(1);
  });
});
