import { spawn, type ChildProcess } from 'node:child_process';
import {
  DESKTOP_APPS,
  desktopA11yActReplySchema,
  desktopA11yStatusReplySchema,
  desktopA11yTreeReplySchema,
  type DesktopA11yActReply,
  type DesktopA11yActRequest,
  type DesktopA11yFindQuery,
  type DesktopA11yStatusReply,
  type DesktopA11yTreeQuery,
  type DesktopA11yTreeReply,
  type DesktopApp,
} from '@shitsuji/sandbox-protocol';
import { z } from 'zod';
import { SandboxHttpError } from './errors.js';

/** Level of a log line; sandboxd has no logger port, so each service gets one callback. */
export type A11yLog = (level: 'info' | 'warn', message: string) => void;

/** A failure from the helper, or from the pipe to it. Never contains tree text. */
export class A11yHelperError extends Error {
  constructor(
    readonly code:
      'timeout' | 'crashed' | 'protocol' | 'stale' | 'invalid' | 'not_found' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'A11yHelperError';
  }
}

const helperErrorSchema = z
  .object({
    id: z.number().int(),
    error: z
      .object({
        code: z.enum(['stale', 'invalid', 'not_found', 'failed']),
        message: z.string().min(1).max(4_000),
      })
      .strict(),
  })
  .strict();

const pingReplySchema = z
  .object({ id: z.number().int(), ok: z.literal(true), version: z.number().int() })
  .strict();

const appsReplySchema = z
  .object({
    id: z.number().int(),
    ok: z.literal(true),
    apps: z
      .array(
        z
          .object({
            name: z.string().max(200),
            frames: z.number().int().nonnegative(),
            nodes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

const treeReplySchema = z
  .object({ id: z.number().int(), ok: z.literal(true), tree: desktopA11yTreeReplySchema })
  .strict();

const actReplySchema = z
  .object({ id: z.number().int(), ok: z.literal(true), result: desktopA11yActReplySchema })
  .strict();

/** The helper's `apps` reply, validated like every other line from it. */
type AppsReply = z.infer<typeof appsReplySchema>['apps'];

export interface A11yHelperOptions {
  /** The helper command; the image puts `setpriv` in front so it runs as uid 1000. */
  command: readonly string[];
  /** A fixed, minimal environment: no token, no VNC passwords, no daemon variables. */
  env: Record<string, string>;
  /** One request's deadline; the helper is killed, never retried. */
  timeoutMs: number;
  /** The longest line the helper may write; a larger line kills it. */
  maxLineBytes: number;
  /** Injected in tests. */
  spawn?: typeof spawn;
  log?: A11yLog;
}

interface Pending {
  id: number;
  schema: z.ZodTypeAny;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The long-lived AT-SPI helper (S54). One request is in flight at a time; a hung or dead helper is
 * killed and the next request starts a fresh one, while the request that was in flight fails and is
 * never replayed. Every line is bounded and validated, so a compromised process cannot make the
 * daemon return an unbounded or malformed reply.
 */
export class A11yHelper {
  private child?: ChildProcess;
  private pending?: Pending;
  private buffer = Buffer.alloc(0);
  private stderr = '';
  private nextId = 1;
  private ready = false;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: A11yHelperOptions) {}

  /** True once the helper answered, and false again after it died or was killed. */
  get available(): boolean {
    return this.ready && this.child !== undefined && !this.closed;
  }

  /** Starts and pings the helper; false means it is not up and callers must not claim it. */
  async start(timeoutMs = Math.min(3_000, this.options.timeoutMs)): Promise<boolean> {
    try {
      await this.request({ op: 'ping' }, pingReplySchema, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Sends one request and validates its reply. Requests are serialized, never concurrent. */
  request<T>(
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    timeoutMs = this.options.timeoutMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new A11yHelperError('crashed', 'The accessibility helper is stopped.'));
    }
    const task = () => this.doRequest(body, schema, timeoutMs);
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Kills the helper and rejects anything in flight; the next request starts a fresh process. */
  stop(): void {
    this.closed = true;
    this.fail(new A11yHelperError('crashed', 'The accessibility helper is stopped.'), true);
  }

  private doRequest<T>(
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new A11yHelperError('crashed', 'The accessibility helper is stopped.'));
        return;
      }
      let child: ChildProcess;
      try {
        child = this.ensureChild();
      } catch (error) {
        reject(error);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.fail(
          new A11yHelperError('timeout', 'The accessibility helper did not answer in time.'),
          true,
        );
      }, timeoutMs);
      timer.unref();
      this.pending = { id, schema, resolve: (value) => resolve(value as T), reject, timer };
      const line = `${JSON.stringify({ ...body, id })}\n`;
      child.stdin?.write(line, (error) => {
        if (error) {
          this.fail(new A11yHelperError('crashed', 'The accessibility helper stopped.'), true);
        }
      });
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    const [program, ...args] = this.options.command;
    if (!program) {
      throw new A11yHelperError('crashed', 'The accessibility helper is not configured.');
    }
    const child = (this.options.spawn ?? spawn)(program, args, {
      env: this.options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = '';
    this.buffer = Buffer.alloc(0);
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(child, chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderr.length < 4_000) {
        this.stderr += chunk.subarray(0, 4_000 - this.stderr.length).toString('utf8');
      }
    });
    child.once('error', (error) => {
      this.onExit(child, `could not start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      this.onExit(child, `exited (${code ?? signal ?? 'unknown'})`);
    });
    return child;
  }

  private onStdout(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) return;
    if (!this.pending) {
      // A helper that talks when nobody asked is not trusted; kill it.
      this.options.log?.('warn', 'The accessibility helper wrote an unexpected line');
      this.fail(
        new A11yHelperError('protocol', 'The accessibility helper wrote unexpectedly.'),
        true,
      );
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const newline = this.buffer.indexOf(0x0a);
    if (newline === -1) {
      if (this.buffer.length > this.options.maxLineBytes) {
        this.fail(
          new A11yHelperError(
            'protocol',
            'The accessibility helper wrote a line that is too large.',
          ),
          true,
        );
      }
      return;
    }
    const line = this.buffer.subarray(0, newline).toString('utf8');
    const rest = this.buffer.subarray(newline + 1);
    this.buffer = Buffer.alloc(0);
    if (rest.length > 0) {
      this.options.log?.('warn', 'The accessibility helper wrote more than one line per request');
      this.fail(
        new A11yHelperError('protocol', 'The accessibility helper wrote unexpectedly.'),
        true,
      );
      return;
    }
    if (Buffer.byteLength(line, 'utf8') > this.options.maxLineBytes) {
      this.fail(
        new A11yHelperError('protocol', 'The accessibility helper wrote a line that is too large.'),
        true,
      );
      return;
    }
    this.handleLine(line);
  }

  private handleLine(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(
        new A11yHelperError('protocol', 'The accessibility helper wrote invalid JSON.'),
        true,
      );
      return;
    }
    const replyId = z.object({ id: z.number().int() }).passthrough().safeParse(parsed);
    if (!replyId.success || replyId.data.id !== pending.id) {
      this.fail(
        new A11yHelperError('protocol', 'The accessibility helper answered the wrong request.'),
        true,
      );
      return;
    }
    const error = helperErrorSchema.safeParse(parsed);
    if (error.success) {
      this.settle();
      pending.reject(new A11yHelperError(error.data.error.code, error.data.error.message));
      return;
    }
    const value = pending.schema.safeParse(parsed);
    if (!value.success) {
      this.fail(
        new A11yHelperError('protocol', 'The accessibility helper answered in an unknown shape.'),
        true,
      );
      return;
    }
    this.settle();
    this.ready = true;
    pending.resolve(value.data);
  }

  private settle(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) clearTimeout(pending.timer);
  }

  /** Rejects the request in flight (if any), and optionally kills the helper. */
  private fail(error: A11yHelperError, kill: boolean): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (kill) this.kill();
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    if (!child) return;
    const pid = child.pid;
    const signal = (name: NodeJS.Signals) => {
      // A detached child is its own process group on Linux; Windows has no negative pid, so fall
      // back to the child handle (the tests use it; the image always takes the group path).
      if (pid !== undefined) {
        try {
          process.kill(-pid, name);
          return;
        } catch {
          // Fall through to the child handle.
        }
      }
      try {
        child.kill(name);
      } catch {
        // It may already be gone.
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 1_000);
    timer.unref();
  }

  private onExit(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    if (this.stderr.trim()) {
      this.options.log?.('warn', `The accessibility helper ${reason}: ${this.stderr.trim()}`);
    } else {
      this.options.log?.('warn', `The accessibility helper ${reason}`);
    }
    this.stderr = '';
    this.fail(new A11yHelperError('crashed', 'The accessibility helper stopped.'), false);
  }
}

export interface A11yServiceOptions extends A11yHelperOptions {
  /** How many pings at startup before claiming accessibility is unavailable. */
  startAttempts?: number;
  startDelayMs?: number;
}

/** Which accessible application name belongs to each allowed app. */
const APP_PATTERNS: Record<DesktopApp, RegExp> = {
  chromium: /chrom/i,
  libreoffice: /libre|soffice/i,
  thunar: /thunar/i,
  'xfce4-terminal': /terminal|xfce4-term/i,
};

/**
 * The daemon-side accessibility service (S54): a thin, validated layer over the helper, mapping an
 * untrusted helper failure to the protocol's error codes and keeping the startup check that says
 * which allowed apps publish a tree.
 */
export class A11yService {
  private readonly helper: A11yHelper;

  constructor(private readonly options: A11yServiceOptions) {
    this.helper = new A11yHelper(options);
  }

  /** True only while the helper has actually answered; the driver claims accessibility from this. */
  get available(): boolean {
    return this.helper.available;
  }

  /** Starts the helper with a bounded retry, for the daemon's startup and the capability claim. */
  async start(): Promise<boolean> {
    const attempts = this.options.startAttempts ?? 5;
    const delayMs = this.options.startDelayMs ?? 500;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (await this.helper.start()) return true;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  async tree(query: DesktopA11yTreeQuery): Promise<DesktopA11yTreeReply> {
    return this.call({ op: 'tree', ...query }, treeReplySchema).then((reply) => reply.tree);
  }

  async find(query: DesktopA11yFindQuery): Promise<DesktopA11yTreeReply> {
    return this.call({ op: 'find', ...query }, treeReplySchema).then((reply) => reply.tree);
  }

  async act(request: DesktopA11yActRequest): Promise<DesktopA11yActReply> {
    return this.call({ op: 'act', ...request }, actReplySchema).then((reply) => reply.result);
  }

  /** Lists allowed apps and whether each publishes a tree; helper down means all are missing. */
  async status(): Promise<DesktopA11yStatusReply> {
    let apps: AppsReply;
    try {
      apps = await this.call({ op: 'apps' }, appsReplySchema).then((reply) => reply.apps);
    } catch (error) {
      this.logFailure(error);
      return {
        helper: false,
        apps: DESKTOP_APPS.map((app) => ({ app, tree: false, nodes: 0 })),
        missing: [...DESKTOP_APPS],
      };
    }
    const statuses = DESKTOP_APPS.map((app) => {
      const matching = apps.filter((entry) => APP_PATTERNS[app].test(entry.name));
      const nodes = matching.reduce((sum, entry) => sum + entry.nodes, 0);
      return { app, tree: matching.some((entry) => entry.frames > 0 && entry.nodes > 0), nodes };
    });
    return desktopA11yStatusReplySchema.parse({
      helper: true,
      apps: statuses,
      missing: statuses.filter((entry) => !entry.tree).map((entry) => entry.app),
    });
  }

  /** The startup check: one log line per allowed app, and a warning for a missing tree. */
  async startupCheck(): Promise<DesktopA11yStatusReply> {
    const status = await this.status();
    if (!status.helper) {
      this.options.log?.('warn', 'No accessibility helper; desktop.inspect is unavailable.');
      return status;
    }
    for (const entry of status.apps) {
      if (entry.tree) {
        this.options.log?.(
          'info',
          `Accessibility: ${entry.app} publishes a tree (${entry.nodes}).`,
        );
      } else {
        this.options.log?.('warn', `Accessibility: no tree from ${entry.app}.`);
      }
    }
    return status;
  }

  stop(): void {
    this.helper.stop();
  }

  private async call<T>(body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    try {
      return await this.helper.request(body, schema);
    } catch (error) {
      this.logFailure(error);
      throw translate(error);
    }
  }

  private logFailure(error: unknown): void {
    if (error instanceof A11yHelperError && error.code === 'stale') return;
    this.options.log?.(
      'warn',
      `The accessibility helper failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

/** Maps a helper failure to the protocol's error, keeping the stale message the model must see. */
function translate(error: unknown): Error {
  if (error instanceof A11yHelperError) {
    if (error.code === 'stale') {
      return new SandboxHttpError(409, 'stale', 'stale, take a new snapshot');
    }
    if (error.code === 'not_found') {
      return new SandboxHttpError(404, 'not_found', error.message);
    }
    if (error.code === 'invalid') {
      return new SandboxHttpError(400, 'invalid_request', error.message);
    }
  }
  return new SandboxHttpError(503, 'internal', 'The accessibility tree is not available.');
}
