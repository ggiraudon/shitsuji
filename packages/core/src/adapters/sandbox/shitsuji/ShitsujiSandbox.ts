import {
  desktopA11yActReplySchema,
  desktopA11yActRequestSchema,
  desktopA11yFindQuerySchema,
  desktopA11yStatusReplySchema,
  desktopA11yTreeQuerySchema,
  desktopA11yTreeReplySchema,
  desktopClipboardReplySchema,
  desktopClipboardRequestSchema,
  desktopKeyboardRequestSchema,
  desktopLaunchReplySchema,
  desktopLaunchRequestSchema,
  desktopMouseRequestSchema,
  desktopOcrReplySchema,
  desktopOcrRequestSchema,
  desktopOkReplySchema,
  desktopScreenshotReplySchema,
  desktopStateReplySchema,
  desktopWindowsReplySchema,
  errorReplySchema,
  execEventSchema,
  healthReplySchema,
  listFilesReplySchema,
  mkdirReplySchema,
  probeReplySchema,
  readFileReplySchema,
  statFileReplySchema,
  writeFileReplySchema,
  SANDBOX_ROUTES,
  SANDBOX_TOKEN_HEADER,
  type DesktopApp,
  type DesktopKey,
  type SandboxRoot,
} from '@shitsuji/sandbox-protocol';
import type { z } from 'zod';
import { SandboxUnavailable } from '../../../domain/errors.js';
import type {
  DesktopA11yActRequest,
  DesktopA11yActResult,
  DesktopA11yFindQuery,
  DesktopA11yStatus,
  DesktopA11yTree,
  DesktopA11yTreeQuery,
  DesktopAction,
  DesktopCapability,
  DesktopImage,
  DesktopOcrResult,
  DesktopRect,
  DesktopState,
  DesktopWindow,
  ExecEvent,
  ExecRequest,
  SandboxEgress,
  SandboxExec,
  SandboxFiles,
  FileEntry,
  FileStat,
} from '../../../ports/SandboxDriver.js';

/** A reply the daemon refused; the message is its own, so it never names a host path. */
export class SandboxRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SandboxRequestError';
  }
}

export interface SandboxClientOptions {
  /** e.g. http://sandbox:4555 */
  baseUrl: string;
  token: string;
  /** Unary requests give up after this; exec has its own timeout. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The HTTP side of the shitsuji driver (F08, S48): every request carries the token and every reply
 * is parsed with the protocol schema, so a daemon that drifts breaks loudly here.
 */
export class SandboxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SandboxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call<S extends z.ZodTypeAny>(
    route: string,
    schema: S,
    body?: unknown,
    timeoutMs = this.options.timeoutMs ?? 10_000,
  ): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          [SANDBOX_TOKEN_HEADER]: this.options.token,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SandboxUnavailable(
        `Cannot reach the sandbox at ${this.baseUrl}: ${(error as Error).message}`,
        { url: this.baseUrl },
        { cause: error },
      );
    }
    if (!response.ok) throw await this.errorOf(response);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new SandboxUnavailable(`The sandbox answered ${route} in an unexpected shape.`, {
        url: this.baseUrl,
      });
    }
    return parsed.data;
  }

  /** Opens the NDJSON stream of one command; the caller reads frames until the exit. */
  async stream(
    route: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<ReadableStream<Uint8Array>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method: 'POST',
        headers: {
          [SANDBOX_TOKEN_HEADER]: this.options.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SandboxUnavailable(
        `Cannot reach the sandbox at ${this.baseUrl}: ${(error as Error).message}`,
        { url: this.baseUrl },
        { cause: error },
      );
    }
    if (!response.ok) throw await this.errorOf(response);
    if (!response.body) throw new SandboxUnavailable('The sandbox sent no exec stream.');
    return response.body;
  }

  /** Signals a running command (Stop); a missing command is not an error worth failing the call. */
  async signal(id: string, signal = 'SIGTERM'): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/exec/${encodeURIComponent(id)}/signal`, {
      method: 'POST',
      headers: {
        [SANDBOX_TOKEN_HEADER]: this.options.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ signal }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    }).catch(() => undefined);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const reply = await this.call(SANDBOX_ROUTES.health, healthReplySchema);
      return { ok: reply.ok };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  private async errorOf(response: Response): Promise<Error> {
    const parsed = errorReplySchema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) {
      return new SandboxRequestError(parsed.data.error.message, parsed.data.error.code);
    }
    return new SandboxRequestError(
      `The sandbox refused the request (HTTP ${response.status}).`,
      'internal',
    );
  }
}

const WORKSPACE = '/workspace';
const HANDOFF = '/handoff';

/** A route with only the query fields that are set, so an omitted option sends no placeholder. */
function withQuery(route: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${route}?${text}` : route;
}

/** The model's path inside one root, exactly as the daemon wants it. */
function normalise(relative: string): string {
  if (relative.includes('\0')) throw new Error('The path contains a NUL byte.');
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) {
    throw new Error(`"${relative}" is absolute.`);
  }
  const clean = relative
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
  if (clean.split('/').some((part) => part === '..')) {
    throw new Error(`"${relative}" is outside the sandbox's folders.`);
  }
  return clean === '' ? '.' : clean;
}

/**
 * Paths the tools hand around between calls. They look like the daemon's folders, so the tools can
 * compare and display them; the client turns them back into a root and a relative path.
 */
export class ShitsujiFiles implements SandboxFiles {
  constructor(private readonly client: SandboxClient) {}

  async resolve(relative: string): Promise<string> {
    const clean = normalise(relative);
    return clean === '.' ? WORKSPACE : `${WORKSPACE}/${clean}`;
  }

  async resolveRead(input: string): Promise<string> {
    if (input.startsWith(`${HANDOFF}/`) || input === HANDOFF) return this.absolute(HANDOFF, input);
    if (input.startsWith(`${WORKSPACE}/`) || input === WORKSPACE) {
      return this.absolute(WORKSPACE, input);
    }
    if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
      throw new Error(`"${input}" is outside the sandbox's folders.`);
    }
    const relative = normalise(input);
    // Read tools may name a handoff attachment by its bare name (F06, S33).
    const inWorkspace = await this.stat(`${WORKSPACE}/${relative}`).catch(() => undefined);
    if (inWorkspace) return `${WORKSPACE}/${relative}`;
    const inHandoff = await this.stat(`${HANDOFF}/${relative}`).catch(() => undefined);
    if (inHandoff) return `${HANDOFF}/${relative}`;
    return `${WORKSPACE}/${relative}`;
  }

  display(absolute: string): string {
    if (absolute === WORKSPACE || absolute === HANDOFF) return '.';
    if (absolute.startsWith(`${WORKSPACE}/`)) return absolute.slice(WORKSPACE.length + 1);
    if (absolute.startsWith(`${HANDOFF}/`)) return absolute.slice(HANDOFF.length + 1);
    return absolute;
  }

  async read(absolute: string): Promise<string> {
    const { root, path } = this.split(absolute);
    const reply = await this.client.call(SANDBOX_ROUTES.read, readFileReplySchema, {
      root,
      path,
      encoding: 'text',
    });
    return reply.content;
  }

  async readBytes(absolute: string): Promise<Uint8Array> {
    const { root, path } = this.split(absolute);
    const reply = await this.client.call(SANDBOX_ROUTES.read, readFileReplySchema, {
      root,
      path,
      encoding: 'base64',
    });
    return new Uint8Array(Buffer.from(reply.content, 'base64'));
  }

  async stat(absolute: string): Promise<FileStat | undefined> {
    const { root, path } = this.split(absolute);
    const reply = await this.client.call(SANDBOX_ROUTES.stat, statFileReplySchema, { root, path });
    return reply.exists ? { size: reply.size, isFile: reply.isFile } : undefined;
  }

  async write(absolute: string, content: string, options: { append: boolean }): Promise<void> {
    const { root, path } = this.split(absolute);
    await this.client.call(SANDBOX_ROUTES.write, writeFileReplySchema, {
      root,
      path,
      encoding: 'text',
      content,
      append: options.append,
      createParents: true,
    });
  }

  async writeBytes(absolute: string, content: Uint8Array): Promise<void> {
    const { root, path } = this.split(absolute);
    await this.client.call(SANDBOX_ROUTES.write, writeFileReplySchema, {
      root,
      path,
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
      append: false,
      createParents: true,
    });
  }

  async mkdir(absolute: string): Promise<void> {
    const { root, path } = this.split(absolute);
    await this.client.call(SANDBOX_ROUTES.mkdir, mkdirReplySchema, { root, path });
  }

  async list(absolute: string): Promise<FileEntry[] | undefined> {
    const { root, path } = this.split(absolute);
    try {
      const reply = await this.client.call(SANDBOX_ROUTES.list, listFilesReplySchema, {
        root,
        path,
      });
      return reply.entries;
    } catch (error) {
      if (error instanceof SandboxRequestError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  private absolute(root: string, value: string): string {
    const rest = value === root ? '' : value.slice(root.length + 1);
    return `${root}/${normalise(rest)}`;
  }

  private split(absolute: string): { root: SandboxRoot; path: string } {
    if (absolute.startsWith(`${WORKSPACE}/`) || absolute === WORKSPACE) {
      return { root: 'workspace', path: normalise(absolute.slice(WORKSPACE.length + 1)) };
    }
    if (absolute.startsWith(`${HANDOFF}/`) || absolute === HANDOFF) {
      return { root: 'handoff', path: normalise(absolute.slice(HANDOFF.length + 1)) };
    }
    throw new Error(`"${absolute}" is outside the sandbox's folders.`);
  }
}

/** Exec over the daemon's NDJSON stream; a Stop signals the command and lets the exit arrive. */
export class ShitsujiExec implements SandboxExec {
  readonly maxTimeoutMs: number;

  constructor(
    private readonly client: SandboxClient,
    maxTimeoutMs: number,
  ) {
    this.maxTimeoutMs = maxTimeoutMs;
  }

  async *run(request: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecEvent> {
    const cwd = request.cwd.startsWith('/workspace/')
      ? request.cwd.slice('/workspace/'.length)
      : request.cwd === '/workspace'
        ? '.'
        : request.cwd;
    const stream = await this.client.stream(
      SANDBOX_ROUTES.exec,
      {
        argv: [request.program, ...request.args],
        cwd,
        env: request.env ?? {},
        timeoutMs: Math.min(request.timeoutMs, this.maxTimeoutMs),
      },
      request.timeoutMs + 30_000,
    );
    let id: string | undefined;
    let aborted = signal?.aborted ?? false;
    const abort = () => {
      aborted = true;
      if (id) void this.client.signal(id, 'SIGTERM');
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') continue;
          const event = execEventSchema.parse(JSON.parse(line));
          if (event.type === 'start') {
            id = event.id;
            if (signal?.aborted) abort();
            continue;
          }
          if (event.type === 'error') throw new Error(event.message);
          yield event;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
    // The daemon stops the whole group on the signal, then sends the exit frame. The caller asked
    // for a stop, so it gets the same "Stopped" the host driver gives, not an exit it ignored.
    if (aborted) throw new Error('Stopped');
  }
}

export class ShitsujiEgress implements SandboxEgress {
  constructor(private readonly client: SandboxClient) {}

  async reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const reply = await this.client.call(SANDBOX_ROUTES.probe, probeReplySchema, {
      host,
      port,
      timeoutMs,
    });
    return reply.reachable;
  }
}

/** Desktop endpoints from S53; the client validates every reply with the protocol schemas. */
export class ShitsujiDesktop implements DesktopCapability {
  readonly screenshots = true;

  constructor(
    private readonly client: SandboxClient,
    readonly accessibility: boolean,
  ) {}

  async state(): Promise<DesktopState> {
    const reply = await this.client.call(SANDBOX_ROUTES.desktopState, desktopStateReplySchema);
    return { display: reply.display, width: reply.width, height: reply.height };
  }

  async screenshot(opts: { scale?: number } = {}): Promise<DesktopImage> {
    const query =
      opts.scale === undefined
        ? SANDBOX_ROUTES.desktopScreenshot
        : `${SANDBOX_ROUTES.desktopScreenshot}?scale=${opts.scale}`;
    const reply = await this.client.call(query, desktopScreenshotReplySchema);
    return {
      mediaType: 'image/png',
      data: new Uint8Array(Buffer.from(reply.content, 'base64')),
      width: reply.width,
      height: reply.height,
      originalWidth: reply.originalWidth,
      originalHeight: reply.originalHeight,
      scale: reply.scale,
    };
  }

  async windows(): Promise<DesktopWindow[]> {
    const reply = await this.client.call(SANDBOX_ROUTES.desktopWindows, desktopWindowsReplySchema);
    return reply.windows;
  }

  async act(action: DesktopAction): Promise<void> {
    switch (action.kind) {
      case 'move':
        await this.mouse({ action: 'move', x: action.x, y: action.y });
        return;
      case 'click':
        await this.mouse({
          action: 'click',
          x: action.x,
          y: action.y,
          button: action.button ?? 'left',
        });
        return;
      case 'double_click':
        await this.mouse({ action: 'double_click', x: action.x, y: action.y });
        return;
      case 'right_click':
        await this.mouse({ action: 'right_click', x: action.x, y: action.y });
        return;
      case 'drag':
        await this.mouse({
          action: 'drag',
          fromX: action.fromX,
          fromY: action.fromY,
          toX: action.toX,
          toY: action.toY,
          button: action.button ?? 'left',
        });
        return;
      case 'scroll':
        await this.mouse({
          action: 'scroll',
          x: action.x,
          y: action.y,
          direction: action.direction,
          amount: action.amount ?? 1,
        });
        return;
      case 'type':
        await this.client.call(
          SANDBOX_ROUTES.desktopInputKeyboard,
          desktopOkReplySchema,
          desktopKeyboardRequestSchema.parse({ action: 'type', text: action.text }),
        );
        return;
      case 'key':
        await this.client.call(
          SANDBOX_ROUTES.desktopInputKeyboard,
          desktopOkReplySchema,
          desktopKeyboardRequestSchema.parse({ action: 'key', key: action.key as DesktopKey }),
        );
        return;
      case 'launch_app':
        await this.client.call(
          SANDBOX_ROUTES.desktopLaunch,
          desktopLaunchReplySchema,
          desktopLaunchRequestSchema.parse({ app: action.app as DesktopApp }),
        );
        return;
    }
  }

  async ocr(opts: { region?: DesktopRect } = {}): Promise<DesktopOcrResult> {
    const reply = await this.client.call(
      SANDBOX_ROUTES.desktopOcr,
      desktopOcrReplySchema,
      desktopOcrRequestSchema.parse({ ...(opts.region && { region: opts.region }) }),
    );
    return { text: reply.text };
  }

  async readClipboard(): Promise<string> {
    const reply = await this.client.call(
      SANDBOX_ROUTES.desktopClipboard,
      desktopClipboardReplySchema,
    );
    return reply.text;
  }

  async writeClipboard(text: string): Promise<void> {
    await this.client.call(
      SANDBOX_ROUTES.desktopClipboard,
      desktopOkReplySchema,
      desktopClipboardRequestSchema.parse({ text }),
    );
  }

  async inspect(request: DesktopA11yTreeQuery): Promise<DesktopA11yTree> {
    const query = desktopA11yTreeQuerySchema.parse(request);
    const reply = await this.client.call(
      withQuery(SANDBOX_ROUTES.desktopA11yTree, query),
      desktopA11yTreeReplySchema,
    );
    return reply;
  }

  async find(request: DesktopA11yFindQuery): Promise<DesktopA11yTree> {
    const query = desktopA11yFindQuerySchema.parse(request);
    const reply = await this.client.call(
      withQuery(SANDBOX_ROUTES.desktopA11yFind, query),
      desktopA11yTreeReplySchema,
    );
    return reply;
  }

  async actOnElement(request: DesktopA11yActRequest): Promise<DesktopA11yActResult> {
    return this.client.call(
      SANDBOX_ROUTES.desktopA11yAct,
      desktopA11yActReplySchema,
      desktopA11yActRequestSchema.parse(request),
    );
  }

  async accessibilityStatus(): Promise<DesktopA11yStatus> {
    return this.client.call(SANDBOX_ROUTES.desktopA11yStatus, desktopA11yStatusReplySchema);
  }

  private async mouse(request: z.infer<typeof desktopMouseRequestSchema>): Promise<void> {
    await this.client.call(
      SANDBOX_ROUTES.desktopInputMouse,
      desktopOkReplySchema,
      desktopMouseRequestSchema.parse(request),
    );
  }
}

/** One open shitsuji sandbox: the capabilities the daemon reported, and the three ports. */
export class ShitsujiSandbox {
  constructor(
    readonly files: ShitsujiFiles,
    readonly exec: SandboxExec,
    readonly egress: SandboxEgress,
    readonly desktop?: DesktopCapability,
  ) {}

  async close(): Promise<void> {
    // One long-lived daemon serves the owner; nothing to close per sandbox (X5).
  }
}
