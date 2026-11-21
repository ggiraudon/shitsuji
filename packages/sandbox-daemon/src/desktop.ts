import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
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

export interface DesktopCommandRunner {
  run(
    argv: readonly string[],
    options?: { timeoutMs?: number; input?: string; maxOutputBytes?: number },
  ): Promise<DesktopCommandResult>;
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
}

/**
 * Runs desktop tools as the command uid. Every call has a deadline and a bounded output, and nothing
 * is retried: a hung xdotool/scrot/OCR is killed, not repeated (S53).
 */
export class SetprivDesktopRunner implements DesktopCommandRunner {
  constructor(private readonly options: DesktopRunnerOptions) {}

  run(
    argv: readonly string[],
    options: { timeoutMs?: number; input?: string; maxOutputBytes?: number } = {},
  ): Promise<DesktopCommandResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? this.options.timeoutMs, 60_000);
    const maxOutputBytes = options.maxOutputBytes ?? this.options.maxOutputBytes;
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
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const collect = (chunk: Buffer, current: string, limit: number): string => {
        if (current.length >= limit) return current;
        return current + chunk.subarray(0, Math.max(0, limit - current.length)).toString();
      };
      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process may already be gone.
        }
      };
      const finish = (result: DesktopCommandResult) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= maxOutputBytes) return;
        stdout = collect(chunk, stdout, maxOutputBytes);
        stdoutBytes += chunk.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= maxOutputBytes) return;
        stderr = collect(chunk, stderr, maxOutputBytes);
        stderrBytes += chunk.length;
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        reject(error);
      });
      child.once('close', (code, signal) => finish({ stdout, stderr, code, signal, timedOut }));

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
  /** Where temporary screenshots/OCR files go; the container uses /tmp. */
  tempDir?: string;
  /** The X display name reported to core. */
  display?: string;
}

const MEDIA_TYPE = 'image/png' as const;

/**
 * The daemon-side desktop API (S53): screen state, scaled PNG screenshots, xdotool input, wmctrl
 * windows, xclip and tesseract OCR. Every command goes through the injected runner, so it runs as
 * uid 1000 with a deadline; the daemon itself stays 1001.
 */
export class DesktopService {
  private readonly tempDir: string;
  private readonly display: string;

  constructor(private readonly options: DesktopServiceOptions) {
    this.tempDir = options.tempDir ?? '/tmp';
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
    const raw = `${this.tempDir}/desktop-${randomUUID()}.png`;
    const scaled = `${this.tempDir}/desktop-${randomUUID()}.png`;
    try {
      await this.run(['scrot', '-o', raw], 10_000);
      if (width === state.width && height === state.height) {
        await fs.rename(raw, scaled);
      } else {
        await this.run(
          [
            'ffmpeg',
            '-loglevel',
            'error',
            '-y',
            '-i',
            raw,
            '-vf',
            `scale=${width}:${height}`,
            scaled,
          ],
          20_000,
        );
      }
      const bytes = await fs.readFile(scaled);
      return {
        encoding: 'base64',
        content: bytes.toString('base64'),
        mediaType: MEDIA_TYPE,
        width,
        height,
        originalWidth: state.width,
        originalHeight: state.height,
        scale: applied,
      };
    } finally {
      await remove(raw);
      await remove(scaled);
    }
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
      await this.run(
        ['xdotool', 'type', '--clearmodifiers', '--delay', '20', '--', action.text],
        10_000,
      );
      return;
    }
    await this.run(['xdotool', 'key', '--clearmodifiers', action.key]);
  }

  async windows(): Promise<DesktopWindowsReply> {
    const result = await this.run(['wmctrl', '-l', '-G'], 5_000);
    const windows: DesktopWindow[] = [];
    for (const line of result.stdout.split('\n')) {
      const match = /^(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(
        line.trim(),
      );
      if (!match) continue;
      windows.push({
        id: match[1]!,
        desktop: Number(match[2]),
        x: Number(match[3]),
        y: Number(match[4]),
        width: Number(match[5]),
        height: Number(match[6]),
        title: match[8] ?? '',
      });
    }
    return { windows };
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
    const file = `${this.tempDir}/desktop-ocr-${randomUUID()}.png`;
    try {
      const args = request.region
        ? [
            '-a',
            `${request.region.x},${request.region.y},${request.region.width},${request.region.height}`,
          ]
        : [];
      await this.run(['scrot', '-o', ...args, file], 10_000);
      const result = await this.run(
        ['tesseract', file, 'stdout', '-l', 'eng', '--psm', '6'],
        20_000,
      );
      return { text: result.stdout.trim() };
    } finally {
      await remove(file);
    }
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

async function remove(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => undefined);
}
