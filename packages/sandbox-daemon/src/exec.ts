import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecEvent, ExecRequest } from '@shitsuji/sandbox-protocol';
import { SandboxHttpError } from './errors.js';
import type { SandboxPaths } from './paths.js';

export interface ExecEnv {
  PATH: string;
  HOME: string;
  LANG: string;
  USER: string;
  /** The egress proxy, as `http://host:port`; commands get it as HTTP(S)_PROXY (S48). */
  proxy?: string;
}

export interface ExecSupervisorOptions {
  /** A command may never run longer than this, whatever the request asks. */
  maxTimeoutMs: number;
  /** Output kept per command; the rest is dropped and the exit frame says `truncated`. */
  maxOutputBytes: number;
  /** How long a command gets between TERM and KILL. */
  killGraceMs?: number;
  /** The fixed base of every command's environment; nothing comes from the daemon's own. */
  env: ExecEnv;
  /**
   * Wraps the argv before spawning (the image puts `setpriv` in front, so the command runs as uid
   * 1000 with no capabilities). Never use spawn's `uid`: a same-kernel uid change does not clear
   * the daemon's ambient capabilities, and they would survive execve into the command.
   */
  wrap?: (argv: readonly string[]) => string[];
}

/**
 * The argv that drops to the command identity before running it: uid/gid 1000, no inheritable or
 * ambient capabilities, an empty bounding set and no-new-privs, so the command cannot regain the
 * daemon's SETUID/SETGID/KILL. `--` keeps an argument that looks like a flag as the program.
 */
export function setprivCommand(
  argv: readonly string[],
  identity: { uid: number; gid?: number; setprivPath?: string },
): string[] {
  return [
    identity.setprivPath ?? '/usr/bin/setpriv',
    `--reuid=${identity.uid}`,
    `--regid=${identity.gid ?? identity.uid}`,
    '--init-groups',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '--no-new-privs',
    '--',
    ...argv,
  ];
}

interface Running {
  child: ChildProcess;
  stopped: boolean;
  signalSent?: NodeJS.Signals;
  killTimer?: NodeJS.Timeout;
}

/**
 * The exec supervisor (F08, S46): one child per command, in its own process session on Linux, with a
 * timeout, a whole-group stop and an output cap. Commands start from an explicit minimal environment
 * — never the daemon's — so the sandbox token and anything else the daemon holds stay unreadable.
 */
export class ExecSupervisor {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly paths: SandboxPaths,
    private readonly options: ExecSupervisorOptions,
  ) {}

  get maxTimeoutMs(): number {
    return this.options.maxTimeoutMs;
  }

  /**
   * Starts a command and streams its frames to `emit`, ending with one exit or error frame. The
   * optional signal stops it (TERM, then KILL after the grace) — the route ties it to the client
   * disconnecting.
   */
  async run(
    request: ExecRequest,
    emit: (event: ExecEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const id = randomUUID();

    let cwd: string;
    try {
      cwd = await this.paths.resolveExisting('workspace', request.cwd);
    } catch (error) {
      emit(errorEvent(error));
      return;
    }

    const timeoutMs = Math.min(request.timeoutMs, this.options.maxTimeoutMs);
    const argv = this.options.wrap?.(request.argv) ?? request.argv;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: this.environmentOf(request.env),
      // A new process group (setsid on Linux) so a stop can reach grandchildren as well.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state: Running = { child, stopped: false };
    this.running.set(id, state);
    emit({ type: 'start', id });

    let bytes = 0;
    let truncated = false;
    const forward = (type: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (truncated) return;
      const room = this.options.maxOutputBytes - bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.subarray(0, room).toString('utf8');
      bytes += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
      if (text.length > 0) emit({ type, text });
    };
    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));

    let settled = false;
    let timedOut = false;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const finish = (event: ExecEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (state.killTimer) clearTimeout(state.killTimer);
      this.running.delete(id);
      emit(event);
      done();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      this.halt(state, 'SIGTERM');
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) this.halt(state, 'SIGTERM');
      else signal.addEventListener('abort', () => this.halt(state, 'SIGTERM'), { once: true });
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === 'ENOENT'
          ? { type: 'error', code: 'not_found', message: `Program not found: ${request.argv[0]}` }
          : { type: 'error', code: 'internal', message: 'The command could not be started.' },
      );
    });
    child.on('close', (code, signalName) => {
      finish({
        type: 'exit',
        code,
        ...(signalName && { signal: signalName }),
        timedOut,
        truncated,
      });
    });

    // A command that never reads stdin makes the write fail with EPIPE; that is not an error here.
    child.stdin?.on('error', () => undefined);
    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
    else child.stdin?.end();
    await finished;
  }

  /** Stops everything (shutdown): each command gets TERM and its grace period. */
  stopAll(): void {
    for (const [id] of this.running) this.signal(id);
  }

  /** Stops a running command: the signal now, SIGKILL after the grace period. */
  signal(
    id: string,
    signal: NodeJS.Signals = 'SIGTERM',
    graceMs = this.options.killGraceMs ?? 2_000,
  ) {
    const state = this.running.get(id);
    if (!state) return false;
    this.halt(state, signal, graceMs);
    return true;
  }

  private halt(
    state: Running,
    signal: NodeJS.Signals,
    graceMs = this.options.killGraceMs ?? 2_000,
  ): void {
    if (state.stopped || !state.child.pid) return;
    state.stopped = true;
    state.signalSent = signal;
    this.kill(state.child, signal);
    if (signal !== 'SIGKILL') {
      state.killTimer = setTimeout(() => this.kill(state.child, 'SIGKILL'), graceMs);
      state.killTimer.unref?.();
    }
  }

  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone: 'close' reports it.
    }
  }

  /** The command's environment: a fixed base plus what the request asked for, never ours. */
  private environmentOf(requested: Record<string, string>): Record<string, string> {
    return {
      PATH: this.options.env.PATH,
      HOME: this.options.env.HOME,
      LANG: this.options.env.LANG,
      LC_ALL: this.options.env.LANG,
      USER: this.options.env.USER,
      LOGNAME: this.options.env.USER,
      SHELL: '/bin/sh',
      TERM: 'dumb',
      TMPDIR: '/tmp',
      ...proxyEnv(this.options.env.proxy),
      ...requested,
    };
  }
}

/**
 * The proxy variables pip, npm, git and curl read (S48). The lowercase forms matter: curl only
 * reads `http_proxy` in some builds, and Node's fetch reads `HTTP_PROXY`. NO_PROXY covers loopback
 * only — nothing internal, so a name like `core` or `postgres` still goes to the proxy, which
 * refuses it.
 */
function proxyEnv(proxy: string | undefined): Record<string, string> {
  if (!proxy) return {};
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}

function errorEvent(error: unknown): ExecEvent {
  if (error instanceof SandboxHttpError) {
    return { type: 'error', code: error.code, message: error.message };
  }
  return { type: 'error', code: 'internal', message: 'The command could not be started.' };
}
