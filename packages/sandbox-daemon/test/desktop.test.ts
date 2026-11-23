import { describe, expect, it } from 'vitest';
import {
  DesktopService,
  type DesktopBinaryResult,
  type DesktopCommandRunner,
  type DesktopCommandResult,
} from '../src/desktop.js';
import { SandboxHttpError } from '../src/errors.js';

const ok = (stdout = ''): DesktopCommandResult => ({
  stdout,
  stderr: '',
  code: 0,
  signal: null,
  timedOut: false,
});
const bin = (): DesktopBinaryResult => ({
  stdout: Buffer.from('PNGDATA'),
  stderr: '',
  code: 0,
  signal: null,
  timedOut: false,
});

const service = (runner: DesktopCommandRunner) => new DesktopService({ runner });

const fake = () => {
  const calls: string[][] = [];
  const inputs: (string | Uint8Array | undefined)[] = [];
  const runner: DesktopCommandRunner = {
    async run(argv, options) {
      calls.push([...argv]);
      if (argv[0] === 'xclip' && argv.includes('-i')) inputs.push(options?.input);
      if (argv[0] === 'xdpyinfo') {
        return ok('  dimensions:    1440x900 pixels (381x238 millimeters)');
      }
      if (argv[0] === 'wmctrl') {
        return ok(
          '0x01e00028  0 0 0 1440 900 host xfdesktop.Xfdesktop Desktop\n0x02e00033  0 10 20 500 400 host thunar.Thunar s53-folder - File Manager\n',
        );
      }
      if (argv[0] === 'xclip') return ok('clip text');
      if (argv[0] === 'tesseract') return ok('S53-MARKER\n');
      return ok();
    },
    async runBinary(argv) {
      calls.push([...argv]);
      return bin();
    },
    async startDetached(argv) {
      calls.push([...argv]);
    },
  };
  return { runner, calls, inputs };
};

describe('sandboxd desktop service (S53)', () => {
  it('reports the screen and captures a PNG through a pipe, scaled to fit 1280 px', async () => {
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
    const capture = calls.find((call) => call[0] === 'ffmpeg')!;
    expect(capture).toContain('pipe:1');
    expect(capture.some((arg) => arg.endsWith('.png'))).toBe(false);
  });

  it('captures scale=1 without a temp rename or scale filter', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);
    const shot = await desktop.screenshot(1);
    expect(shot).toMatchObject({ width: 1440, height: 900, scale: 1 });
    const capture = calls.find((call) => call[0] === 'ffmpeg')!;
    expect(capture).not.toContain('-vf');
    expect(capture).not.toContain('scale=1440:900');
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

  it('pastes é ç ü through the clipboard and restores the previous text (#151)', async () => {
    const { runner, calls, inputs } = fake();
    const desktop = service(runner);
    await desktop.keyboard({ action: 'type', text: 'éçü' });
    expect(calls.some((call) => call[0] === 'xdotool' && call[1] === 'type')).toBe(false);
    expect(calls).toContainEqual(['xclip', '-selection', 'clipboard', '-o']);
    expect(calls).toContainEqual(['xdotool', 'key', '--clearmodifiers', 'ctrl+v']);
    expect(inputs).toEqual(['éçü', 'clip text']);
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
        {
          id: '0x01e00028',
          desktop: 0,
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          title: 'Desktop',
          app: 'xfdesktop',
        },
        {
          id: '0x02e00033',
          desktop: 0,
          x: 10,
          y: 20,
          width: 500,
          height: 400,
          title: 's53-folder - File Manager',
          app: 'thunar',
        },
      ],
    });
    await expect(desktop.readClipboard()).resolves.toEqual({ text: 'clip text' });
  });

  it('moves, resizes and focuses a window by id or title (#151)', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);

    await desktop.windowAction({ window: '0x02e00033', action: 'move', x: 40, y: 60 });
    expect(calls).toContainEqual(['wmctrl', '-i', '-r', '0x02e00033', '-e', '0,40,60,-1,-1']);

    await desktop.windowAction({
      window: 'File Manager',
      action: 'resize',
      width: 800,
      height: 600,
    });
    expect(calls).toContainEqual(['wmctrl', '-i', '-r', '0x02e00033', '-e', '0,-1,-1,800,600']);

    await desktop.windowAction({ window: 'file manager', action: 'focus' });
    expect(calls).toContainEqual(['wmctrl', '-i', '-a', '0x02e00033']);

    await expect(
      desktop.windowAction({ window: 'no such window', action: 'focus' }),
    ).rejects.toBeInstanceOf(SandboxHttpError);
  });

  it('OCRs through ffmpeg stdin and tesseract stdin, with no temp path', async () => {
    const { runner, calls } = fake();
    const desktop = service(runner);
    await expect(
      desktop.ocr({ region: { x: 10, y: 20, width: 300, height: 100 } }),
    ).resolves.toEqual({ text: 'S53-MARKER' });
    const tesseract = calls.find((call) => call[0] === 'tesseract')!;
    expect(tesseract).toEqual(['tesseract', 'stdin', 'stdout', '-l', 'eng', '--psm', '6']);
    expect(calls.some((call) => call.some((arg) => arg.endsWith('.png')))).toBe(false);
    await expect(
      desktop.ocr({ region: { x: 1400, y: 0, width: 100, height: 100 } }),
    ).rejects.toBeInstanceOf(SandboxHttpError);
  });
});
