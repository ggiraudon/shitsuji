import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopService, type DesktopCommandRunner } from '../src/desktop.js';
import { SandboxHttpError } from '../src/errors.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-test-'));
});
afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const service = (runner: DesktopCommandRunner) => new DesktopService({ runner, tempDir });

const fake = () => {
  const calls: string[][] = [];
  const runner: DesktopCommandRunner = {
    async run(argv) {
      calls.push([...argv]);
      if (argv[0] === 'xdpyinfo') {
        return {
          stdout: '  dimensions:    1440x900 pixels (381x238 millimeters)',
          stderr: '',
          code: 0,
          signal: null,
          timedOut: false,
        };
      }
      if (argv[0] === 'wmctrl') {
        return {
          stdout:
            '0x01e00028  0 0 0 1440 900 host Desktop\n0x02e00033  0 10 20 500 400 host s53-folder - File Manager\n',
          stderr: '',
          code: 0,
          signal: null,
          timedOut: false,
        };
      }
      if (argv[0] === 'xclip') {
        return { stdout: 'clip text', stderr: '', code: 0, signal: null, timedOut: false };
      }
      if (argv[0] === 'tesseract') {
        return { stdout: 'S53-MARKER\n', stderr: '', code: 0, signal: null, timedOut: false };
      }
      // scrot writes the output file; ffmpeg writes the scaled file.
      const target = argv.at(-1);
      if (typeof target === 'string' && target.endsWith('.png')) {
        await fs.writeFile(target, Buffer.from('PNGDATA'));
      }
      return { stdout: '', stderr: '', code: 0, signal: null, timedOut: false };
    },
    async startDetached(argv) {
      calls.push([...argv]);
    },
  };
  return { runner, calls };
};

describe('sandboxd desktop service (S53)', () => {
  it('reports the screen and returns a PNG scaled to fit 1280 px', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);

    await expect(desktop.state()).resolves.toEqual({
      display: ':0',
      width: 1440,
      height: 900,
    });
    const shot = await desktop.screenshot();
    expect(shot).toMatchObject({
      encoding: 'base64',
      mediaType: 'image/png',
      width: 1280,
      height: 800,
      originalWidth: 1440,
      originalHeight: 900,
    });
    expect(shot.scale).toBeCloseTo(1280 / 1440);
    expect(Buffer.from(shot.content, 'base64').toString()).toBe('PNGDATA');
    expect(calls.some((call) => call[0] === 'scrot')).toBe(true);
    expect(calls.some((call) => call[0] === 'ffmpeg')).toBe(true);
  });

  it('validates coordinates against the screen before running xdotool', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);

    await desktop.mouse({ action: 'move', x: 100, y: 200 });
    expect(calls.at(-1)).toEqual(['xdotool', 'mousemove', '100', '200']);

    await expect(
      desktop.mouse({ action: 'click', x: 5000, y: 1, button: 'left' }),
    ).rejects.toBeInstanceOf(SandboxHttpError);
  });

  it('passes typed text as one argument and only allow-listed keys', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);

    await desktop.keyboard({ action: 'type', text: 'hello; rm -rf /' });
    expect(calls.at(-1)).toEqual([
      'xdotool',
      'type',
      '--clearmodifiers',
      '--delay',
      '20',
      '--',
      'hello; rm -rf /',
    ]);
    await desktop.keyboard({ action: 'key', key: 'ctrl+l' });
    expect(calls.at(-1)).toEqual(['xdotool', 'key', '--clearmodifiers', 'ctrl+l']);
  });

  it('launches only an allowed app, detached', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);
    await desktop.launch('thunar');
    expect(calls.at(-1)).toEqual(['/usr/bin/thunar']);
    await desktop.launch('libreoffice');
    expect(calls.at(-1)).toEqual(['/usr/bin/libreoffice', '--norestore']);
  });

  it('lists windows and reads the clipboard', async () => {
    const { runner } = fake();
    const desktop = service(runner);
    await expect(desktop.windows()).resolves.toEqual({
      windows: [
        { id: '0x01e00028', desktop: 0, x: 0, y: 0, width: 1440, height: 900, title: 'Desktop' },
        {
          id: '0x02e00033',
          desktop: 0,
          x: 10,
          y: 20,
          width: 500,
          height: 400,
          title: 's53-folder - File Manager',
        },
      ],
    });
    await expect(desktop.readClipboard()).resolves.toEqual({ text: 'clip text' });
  });

  it('OCRs a validated region and returns the text', async () => {
    const { runner } = fake();
    const desktop = service(runner);
    await expect(
      desktop.ocr({ region: { x: 10, y: 20, width: 300, height: 100 } }),
    ).resolves.toEqual({ text: 'S53-MARKER' });
    await expect(
      desktop.ocr({ region: { x: 1400, y: 0, width: 100, height: 100 } }),
    ).rejects.toBeInstanceOf(SandboxHttpError);
  });
});
