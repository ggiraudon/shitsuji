import { spawn } from 'node:child_process';
import {
  DESKTOP_APPS,
  DESKTOP_MAX_LONG_SIDE,
  type DesktopApp,
  type DesktopClipboardReply,
  type DesktopKey,
  type DesktopMouseRequest,
  type DesktopOcrRequest,
  type DesktopOcrReply,
  type DesktopScreenshotReply,
  type DesktopStateReply,
  type DesktopWindow,
  type DesktopWindowActionRequest,
  type DesktopWindowsReply,
} from '@shitsuji/sandbox-protocol';
import { invalidRequest, SandboxHttpError } from './errors.js';
import { setprivCommand } from './exec.js';

/** One desktop command's result; it is bounded and already timed out before this resolves. */
export interface DesktopCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

/** Binary output (a screenshot) with its own cap; never written to a shared file. */
export interface DesktopBinaryResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface DesktopCommandRunner {
  run(
    argv: readonly string[],
    options?: { timeoutMs?: number; input?: string | Uint8Array; maxOutputBytes?: number },
  ): Promise<DesktopCommandResult>;
  runBinary(
    argv: readonly string[],
    options?: { timeoutMs?: number; input?: string | Uint8Array; maxOutputBytes?: number },
  ): Promise<DesktopBinaryResult>;
  startDetached(argv: readonly string[]): Promise<void>;
}

export interface DesktopRunnerOptions {
  /** The command uid/gid; the daemon itself stays 1001 (S46). */
  uid: number;
  gid: number;
  setprivPath: string;
  env: Record<string, string>;
  /** The command runner's default deadline. */
  timeoutMs: number;
  maxOutputBytes: number;
  /** Screenshots are larger than text output; this cap is separate. */
  maxBinaryBytes: number;
}

/**
 * Runs desktop tools as the command uid. Every call has a deadline and a bounded output, and nothing
 * is retried: a hung xdotool/scrot/OCR is killed, not repeated (S53).
 */
export class SetprivDesktopRunner implements DesktopCommandRunner {
  constructor(private readonly options: DesktopRunnerOptions) {}

  async run(
    argv: readonly string[],
    options: { timeoutMs?: number; input?: string | Uint8Array; maxOutputBytes?: number } = {},
  ): Promise<DesktopCommandResult> {
    const result = await this.execute(argv, options, this.options.maxOutputBytes);
    return { ...result, stdout: result.stdout.toString() };
  }

  async runBinary(
    argv: readonly string[],
    options: { timeoutMs?: number; input?: string | Uint8Array; maxOutputBytes?: number } = {},
  ): Promise<DesktopBinaryResult> {
    return this.execute(argv, options, this.options.maxBinaryBytes);
  }

  private execute(
    argv: readonly string[],
    options: { timeoutMs?: number; input?: string | Uint8Array; maxOutputBytes?: number },
    defaultMaxBytes: number,
  ): Promise<DesktopBinaryResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? this.options.timeoutMs, 60_000);
    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxBytes;
    const command = setprivCommand([...argv], {
      uid: this.options.uid,
      gid: this.options.gid,
      setprivPath: this.options.setprivPath,
    });
    return new Promise((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), {
        env: this.options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process may already be gone.
        }
      };
      const finish = (result: DesktopBinaryResult) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= maxOutputBytes) return;
        const kept = chunk.subarray(0, Math.max(0, maxOutputBytes - stdoutBytes));
        if (kept.length) stdout.push(kept);
        stdoutBytes += kept.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= maxOutputBytes) return;
        stderr += chunk.subarray(0, Math.max(0, maxOutputBytes - stderrBytes)).toString();
        stderrBytes += chunk.length;
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        reject(error);
      });
      child.once('close', (code, signal) =>
        finish({ stdout: Buffer.concat(stdout), stderr, code, signal, timedOut }),
      );

      const deadline = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        graceTimer = setTimeout(() => killGroup('SIGKILL'), 1_000);
      }, timeoutMs);
      child.once('spawn', () => {
        if (options.input !== undefined) child.stdin?.end(options.input);
        else child.stdin?.end();
      });
    });
  }

  async startDetached(argv: readonly string[]): Promise<void> {
    const command = setprivCommand([...argv], {
      uid: this.options.uid,
      gid: this.options.gid,
      setprivPath: this.options.setprivPath,
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), {
        env: this.options.env,
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}

export interface DesktopServiceOptions {
  runner: DesktopCommandRunner;
  /** The X display reported to core and captured by ffmpeg. */
  display?: string;
}

const MEDIA_TYPE = 'image/png' as const;

/**
 * The daemon-side desktop API (S53): screen state, scaled PNG screenshots, xdotool input, wmctrl
 * windows, xclip and tesseract OCR. Every command goes through the injected runner, so it runs as
 * uid 1000 with a deadline; the daemon itself stays 1001. Screenshots and OCR images travel through
 * pipes, never through a shared temp file a sandbox command could swap.
 */
export class DesktopService {
  private readonly display: string;

  constructor(private readonly options: DesktopServiceOptions) {
    this.display = options.display ?? ':0';
  }

  async state(): Promise<DesktopStateReply> {
    const result = await this.run(['xdpyinfo'], 5_000);
    const match = /dimensions:\s+(\d+)x(\d+) pixels/.exec(result.stdout);
    if (!match) throw new SandboxHttpError(500, 'internal', 'The display is not available.');
    return { display: this.display, width: Number(match[1]), height: Number(match[2]) };
  }

  async screenshot(scale?: number): Promise<DesktopScreenshotReply> {
    const state = await this.state();
    const fit = Math.min(1, DESKTOP_MAX_LONG_SIDE / Math.max(state.width, state.height));
    const applied = Math.max(0.05, Math.min(1, scale ?? fit));
    const width = Math.max(1, Math.round(state.width * applied));
    const height = Math.max(1, Math.round(state.height * applied));
    const args = [
      'ffmpeg',
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-video_size',
      `${state.width}x${state.height}`,
      '-i',
      `${this.display}.0`,
      '-frames:v',
      '1',
      ...(width !== state.width || height !== state.height
        ? ['-vf', `scale=${width}:${height}`]
        : []),
      '-an',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ];
    const result = await this.options.runner.runBinary(args, { timeoutMs: 20_000 });
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new SandboxHttpError(500, 'internal', 'The screen could not be captured.');
    }
    return {
      encoding: 'base64',
      content: result.stdout.toString('base64'),
      mediaType: MEDIA_TYPE,
      width,
      height,
      originalWidth: state.width,
      originalHeight: state.height,
      scale: applied,
    };
  }

  async mouse(request: DesktopMouseRequest): Promise<void> {
    const state = await this.state();
    const inside = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < state.width && y < state.height;
    switch (request.action) {
      case 'move':
        this.check(inside(request.x, request.y), request.x, request.y, state);
        await this.run(['xdotool', 'mousemove', String(request.x), String(request.y)]);
        return;
      case 'click':
        this.check(inside(request.x, request.y), request.x, request.y, state);
        await this.run([
          'xdotool',
          'mousemove',
          String(request.x),
          String(request.y),
          'click',
          button(request.button),
        ]);
        return;
      case 'double_click':
        this.check(inside(request.x, request.y), request.x, request.y, state);
        await this.run([
          'xdotool',
          'mousemove',
          String(request.x),
          String(request.y),
          'click',
          '--repeat',
          '2',
          '--delay',
          '100',
          '1',
        ]);
        return;
      case 'right_click':
        this.check(inside(request.x, request.y), request.x, request.y, state);
        await this.run([
          'xdotool',
          'mousemove',
          String(request.x),
          String(request.y),
          'click',
          '3',
        ]);
        return;
      case 'drag':
        this.check(inside(request.fromX, request.fromY), request.fromX, request.fromY, state);
        this.check(inside(request.toX, request.toY), request.toX, request.toY, state);
        await this.run([
          'xdotool',
          'mousemove',
          String(request.fromX),
          String(request.fromY),
          'mousedown',
          button(request.button),
          'mousemove',
          String(request.toX),
          String(request.toY),
          'mouseup',
          button(request.button),
        ]);
        return;
      case 'scroll': {
        this.check(inside(request.x, request.y), request.x, request.y, state);
        const buttonNumber =
          request.direction === 'up'
            ? '4'
            : request.direction === 'down'
              ? '5'
              : request.direction === 'left'
                ? '6'
                : '7';
        await this.run([
          'xdotool',
          'mousemove',
          String(request.x),
          String(request.y),
          'click',
          '--repeat',
          String(request.amount),
          buttonNumber,
        ]);
        return;
      }
    }
  }

  async keyboard(
    action: { action: 'type'; text: string } | { action: 'key'; key: DesktopKey },
  ): Promise<void> {
    if (action.action === 'type') {
      // xdotool cannot type non-ASCII ("Invalid multi-byte sequence"); those go through the
      // clipboard, which is restored afterwards (#151).
      if (NON_ASCII.test(action.text)) {
        await this.pasteText(action.text);
        return;
      }
      await this.run(
        ['xdotool', 'type', '--clearmodifiers', '--delay', '20', '--', action.text],
        10_000,
      );
      return;
    }
    await this.run(['xdotool', 'key', '--clearmodifiers', action.key]);
  }

  /** Pastes accented or other non-ASCII text, then puts the previous clipboard text back. */
  private async pasteText(text: string): Promise<void> {
    const previous = (await this.run(['xclip', '-selection', 'clipboard', '-o'], 3_000)).stdout;
    try {
      const written = await this.run(['xclip', '-selection', 'clipboard', '-i'], 3_000, text);
      if (written.code !== 0) {
        throw invalidRequest('The text could not be put on the clipboard for pasting.');
      }
      await this.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'], 5_000);
      // The app reads the selection asynchronously; give it a moment before taking it back.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await this.run(['xclip', '-selection', 'clipboard', '-i'], 3_000, previous);
    }
  }

  async windows(): Promise<DesktopWindowsReply> {
    const result = await this.run(['wmctrl', '-l', '-x', '-G'], 5_000);
    const windows: DesktopWindow[] = [];
    for (const line of result.stdout.split('\n')) {
      const match =
        /^(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(
          line.trim(),
        );
      if (!match) continue;
      const identifier = match[8]!;
      windows.push({
        id: match[1]!,
        desktop: Number(match[2]),
        x: Number(match[3]),
        y: Number(match[4]),
        width: Number(match[5]),
        height: Number(match[6]),
        title: match[9] ?? '',
        ...(identifier !== 'N/A' && {
          app: identifier.split('.')[0]?.toLowerCase() || undefined,
        }),
      });
    }
    return { windows };
  }

  /** Moves, resizes or focuses one window; the reply is the list after the change (#151). */
  async windowAction(request: DesktopWindowActionRequest): Promise<DesktopWindowsReply> {
    const windows = (await this.windows()).windows;
    const target = resolveWindow(windows, request.window);
    if (!target) throw invalidRequest(`No window matches "${request.window}".`);
    if (request.action === 'focus') {
      await this.run(['wmctrl', '-i', '-a', target.id], 5_000);
    } else {
      const x = request.action === 'move' ? String(request.x) : '-1';
      const y = request.action === 'move' ? String(request.y) : '-1';
      const width = request.action === 'resize' ? String(request.width) : '-1';
      const height = request.action === 'resize' ? String(request.height) : '-1';
      await this.run(
        ['wmctrl', '-i', '-r', target.id, '-e', `0,${x},${y},${width},${height}`],
        5_000,
      );
    }
    return this.windows();
  }

  async launch(app: DesktopApp): Promise<void> {
    if (!DESKTOP_APPS.includes(app)) throw invalidRequest('That app is not allowed.');
    const command =
      app === 'chromium'
        ? ['/usr/bin/chromium', '--no-sandbox', '--no-first-run', '--force-renderer-accessibility']
        : app === 'libreoffice'
          ? ['/usr/bin/libreoffice', '--norestore']
          : [app === 'thunar' ? '/usr/bin/thunar' : '/usr/bin/xfce4-terminal'];
    await this.options.runner.startDetached(command);
  }

  async readClipboard(): Promise<DesktopClipboardReply> {
    const result = await this.run(['xclip', '-selection', 'clipboard', '-o'], 3_000);
    return { text: result.stdout };
  }

  async writeClipboard(text: string): Promise<void> {
    await this.run(['xclip', '-selection', 'clipboard', '-i'], 3_000, text);
  }

  async ocr(request: DesktopOcrRequest): Promise<DesktopOcrReply> {
    const state = await this.state();
    if (request.region) {
      const { x, y, width, height } = request.region;
      if (x + width > state.width || y + height > state.height) {
        throw invalidRequest('The OCR region is outside the screen.');
      }
    }
    const args = [
      'ffmpeg',
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-video_size',
      `${state.width}x${state.height}`,
      '-i',
      `${this.display}.0`,
      '-frames:v',
      '1',
      ...(request.region
        ? [
            '-vf',
            `crop=${request.region.width}:${request.region.height}:${request.region.x}:${request.region.y}`,
          ]
        : []),
      '-an',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ];
    const png = await this.options.runner.runBinary(args, { timeoutMs: 20_000 });
    if (png.code !== 0 || png.stdout.length === 0) {
      throw new SandboxHttpError(500, 'internal', 'The screen could not be captured for OCR.');
    }
    const result = await this.options.runner.run(
      ['tesseract', 'stdin', 'stdout', '-l', 'eng', '--psm', '6'],
      { timeoutMs: 20_000, input: png.stdout },
    );
    if (result.code !== 0) {
      throw new SandboxHttpError(500, 'internal', 'OCR could not read the screen.');
    }
    return { text: result.stdout.trim() };
  }

  private check(inside: boolean, x: number, y: number, state: DesktopStateReply): void {
    if (!inside) {
      throw invalidRequest(
        `The point ${x},${y} is outside the ${state.width}x${state.height} screen.`,
      );
    }
  }

  private run(
    argv: readonly string[],
    timeoutMs = 5_000,
    input?: string,
  ): Promise<DesktopCommandResult> {
    return this.options.runner.run(argv, { timeoutMs, ...(input !== undefined && { input }) });
  }
}

const button = (name: 'left' | 'right' | 'middle'): string =>
  name === 'right' ? '3' : name === 'middle' ? '2' : '1';

/** Anything xdotool cannot type as a key sequence: accented letters, CJK, emoji (#151). */
const NON_ASCII = /[^\t\n\r\x20-\x7e]/;

/** The window a selector names: an id, an exact title, or a title substring (#151). */
function resolveWindow(
  windows: readonly DesktopWindow[],
  selector: string,
): DesktopWindow | undefined {
  const byId = windows.find((item) => item.id === selector);
  if (byId) return byId;
  const needle = selector.toLowerCase();
  const exact = windows.find((item) => item.title.toLowerCase() === needle);
  if (exact) return exact;
  return windows.find((item) => item.title.toLowerCase().includes(needle));
}
