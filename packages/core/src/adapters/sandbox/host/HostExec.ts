import { spawn } from 'node:child_process';
import type { ExecEvent, ExecRequest, SandboxExec } from '../../../ports/SandboxDriver.js';

/**
 * The host driver's exec: a child process of `core`, with a timeout, a kill on Stop, and no shell.
 * Until the `shitsuji` driver lands this is the core process's own machine (decision Q1); the
 * supervisor that owns a whole process session comes with `sandboxd` (S46).
 */
export class HostExec implements SandboxExec {
  readonly maxTimeoutMs: number;

  constructor(options: { maxTimeoutMs: number }) {
    this.maxTimeoutMs = options.maxTimeoutMs;
  }

  async *run(request: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecEvent> {
    const child = spawn(request.program, request.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      signal,
      timeout: request.timeoutMs,
      killSignal: 'SIGKILL',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: request.cwd,
        LANG: 'C.UTF-8',
        ...request.env,
      },
    });

    const events: ExecEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let startError: Error | undefined;
    const push = (event: ExecEvent) => {
      events.push(event);
      wake?.();
      wake = undefined;
    };
    child.stdout.on('data', (chunk: Buffer) => push({ type: 'stdout', text: chunk.toString() }));
    child.stderr.on('data', (chunk: Buffer) => push({ type: 'stderr', text: chunk.toString() }));
    child.on('error', (error: NodeJS.ErrnoException) => {
      // No process was started. The process has released its working folder once 'close' fires,
      // so the exit event is emitted there as well; the error is shown instead of the output.
      startError =
        error.code === 'ENOENT'
          ? new Error(`Program not found: ${request.program}`)
          : error.name === 'AbortError'
            ? new Error('Stopped')
            : error;
    });
    child.on('close', (code, signalName) => {
      closed = true;
      // SIGKILL without a Stop means the timeout fired.
      const timedOut = signalName === 'SIGKILL' && !signal?.aborted;
      push({
        type: 'exit',
        code,
        ...(signalName && { signal: signalName }),
        timedOut,
      });
    });

    while (!closed || events.length > 0) {
      if (events.length === 0) {
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      yield events.shift()!;
    }
    if (startError) throw startError;
  }
}
