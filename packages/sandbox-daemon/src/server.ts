import fs from 'node:fs/promises';
import http from 'node:http';
import {
  EXEC_SIGNAL_ROUTE,
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_ROUTES,
  SANDBOX_TOKEN_HEADER,
  capabilitiesReplySchema,
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
  desktopScreenshotQuerySchema,
  desktopScreenshotReplySchema,
  desktopStateReplySchema,
  desktopWindowsReplySchema,
  errorReplySchema,
  execEventSchema,
  execRequestSchema,
  healthReplySchema,
  listFilesReplySchema,
  listFilesRequestSchema,
  mkdirReplySchema,
  mkdirRequestSchema,
  moveFileReplySchema,
  moveFileRequestSchema,
  probeReplySchema,
  probeRequestSchema,
  readFileReplySchema,
  readFileRequestSchema,
  signalExecReplySchema,
  signalExecRequestSchema,
  statFileReplySchema,
  statFileRequestSchema,
  viewerCredentialsReplySchema,
  viewerFullCredentialsReplySchema,
  writeFileReplySchema,
  writeFileRequestSchema,
  type ErrorReply,
  type ExecEvent,
  type ExecRequest,
  type SandboxRoot,
  type ViewerCredentialsReply,
  type ViewerFullCredentialsReply,
} from '@shitsuji/sandbox-protocol';
import { z, type ZodIssue, type ZodTypeAny } from 'zod';
import type { A11yService } from './a11y.js';
import { tokenMatches } from './auth.js';
import type { DesktopService } from './desktop.js';
import type { ExecSupervisor } from './exec.js';
import { invalidRequest, notFound, SandboxHttpError, tooLarge } from './errors.js';
import type { SandboxFilesService } from './files.js';
import { probePort } from './probe.js';

export interface SandboxServerDeps {
  token: string;
  files: SandboxFilesService;
  exec: ExecSupervisor;
  maxBodyBytes?: number;
  /** The protocol version reported on /health and /capabilities. */
  version?: number;
  /** The JSON file the desktop launcher writes (S50); the viewer route reads it (S51). */
  vncPasswordsFile?: string;
  /** The desktop tools (S53); absent on the base image, so capabilities omit desktop. */
  desktop?: DesktopService;
  /** The AT-SPI helper and its startup check (S54); absent when the desktop is off. */
  a11y?: A11yService;
}

/**
 * The HTTP surface from F08: health, capabilities, the files endpoints and exec. It listens only on
 * the sandbox network and every route but /health needs the token.
 */
export function createSandboxServer(deps: SandboxServerDeps): http.Server {
  const version = deps.version ?? SANDBOX_PROTOCOL_VERSION;
  const maxBodyBytes = deps.maxBodyBytes ?? 64 * 1024 * 1024;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://sandboxd');
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.health) {
        return send(res, 200, healthReplySchema.parse({ ok: true, version }));
      }
      if (!tokenMatches(deps.token, header(req, SANDBOX_TOKEN_HEADER))) {
        throw new SandboxHttpError(401, 'unauthorized', 'The sandbox token is missing or wrong.');
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.capabilities) {
        return send(
          res,
          200,
          capabilitiesReplySchema.parse({
            version,
            files: { roots: ['workspace', 'handoff'] },
            exec: { maxTimeoutMs: deps.exec.maxTimeoutMs },
            ...(deps.desktop && {
              desktop: {
                accessibility: deps.a11y?.available ?? false,
                screenshots: true,
                takeControl: false,
              },
            }),
          }),
        );
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.viewerCredentials) {
        return send(res, 200, await readViewerCredentials(deps.vncPasswordsFile));
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.viewerFullCredentials) {
        return send(res, 200, await readViewerFullCredentials(deps.vncPasswordsFile));
      }
      const desktop = (): DesktopService => {
        if (!deps.desktop) throw notFound('The desktop is not available in this sandbox.');
        return deps.desktop;
      };
      const a11y = (): A11yService => {
        if (!deps.a11y) throw notFound('The accessibility tree is not available in this sandbox.');
        return deps.a11y;
      };
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopState) {
        return send(res, 200, desktopStateReplySchema.parse(await desktop().state()));
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopScreenshot) {
        const query = desktopScreenshotQuerySchema.safeParse(
          Object.fromEntries(url.searchParams.entries()),
        );
        if (!query.success)
          throw invalidRequest('The screenshot scale must be between 0.05 and 1.');
        return send(
          res,
          200,
          desktopScreenshotReplySchema.parse(await desktop().screenshot(query.data.scale)),
        );
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopWindows) {
        return send(res, 200, desktopWindowsReplySchema.parse(await desktop().windows()));
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopClipboard) {
        return send(res, 200, desktopClipboardReplySchema.parse(await desktop().readClipboard()));
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopA11yStatus) {
        return send(res, 200, desktopA11yStatusReplySchema.parse(await a11y().status()));
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopA11yTree) {
        const query = desktopA11yTreeQuerySchema.safeParse(
          Object.fromEntries(url.searchParams.entries()),
        );
        if (!query.success) throw invalidRequest(queryMessage(query.error.issues[0]));
        return send(res, 200, desktopA11yTreeReplySchema.parse(await a11y().tree(query.data)));
      }
      if (req.method === 'GET' && url.pathname === SANDBOX_ROUTES.desktopA11yFind) {
        const query = desktopA11yFindQuerySchema.safeParse(
          Object.fromEntries(url.searchParams.entries()),
        );
        if (!query.success) throw invalidRequest(queryMessage(query.error.issues[0]));
        return send(res, 200, desktopA11yTreeReplySchema.parse(await a11y().find(query.data)));
      }
      if (req.method !== 'POST') throw notFound(`No route for ${req.method} ${url.pathname}.`);
      const body = await readJson(req, maxBodyBytes);
      const signalRoute = EXEC_SIGNAL_ROUTE.exec(url.pathname);
      if (signalRoute) {
        const request = parse(signalExecRequestSchema, body);
        const id = decodeURIComponent(signalRoute[1]!);
        if (!deps.exec.signal(id, request.signal, request.graceMs)) {
          throw notFound(`No running command ${id}.`);
        }
        return send(res, 200, signalExecReplySchema.parse({ stopped: true }));
      }
      switch (url.pathname) {
        case SANDBOX_ROUTES.exec: {
          const request = parse(execRequestSchema, body);
          return streamExec(res, deps.exec, request);
        }
        case SANDBOX_ROUTES.read: {
          const request = parse(readFileRequestSchema, body);
          const reply = await deps.files.read(request.root, request.path, request.encoding);
          return send(res, 200, readFileReplySchema.parse(reply));
        }
        case SANDBOX_ROUTES.write: {
          const request = parse(writeFileRequestSchema, body);
          const reply = await deps.files.write(request.root, request);
          return send(res, 200, writeFileReplySchema.parse(reply));
        }
        case SANDBOX_ROUTES.list: {
          const request = parse(listFilesRequestSchema, body);
          const reply = await deps.files.list(request.root, request.path);
          return send(res, 200, listFilesReplySchema.parse(reply));
        }
        case SANDBOX_ROUTES.stat: {
          const request = parse(statFileRequestSchema, body);
          const reply = await deps.files.stat(request.root as SandboxRoot, request.path);
          return send(res, 200, statFileReplySchema.parse(reply));
        }
        case SANDBOX_ROUTES.mkdir: {
          const request = parse(mkdirRequestSchema, body);
          const reply = await deps.files.mkdir(request.root, request.path);
          return send(res, 200, mkdirReplySchema.parse(reply));
        }
        case SANDBOX_ROUTES.probe: {
          const request = parse(probeRequestSchema, body);
          const reachable = await probePort(request.host, request.port, request.timeoutMs);
          return send(res, 200, probeReplySchema.parse({ reachable }));
        }
        case SANDBOX_ROUTES.move: {
          const request = parse(moveFileRequestSchema, body);
          const reply = await deps.files.move(request.root, request);
          return send(res, 200, moveFileReplySchema.parse(reply));
        }
        case SANDBOX_ROUTES.desktopInputMouse: {
          const request = parse(desktopMouseRequestSchema, body);
          await desktop().mouse(request);
          return send(res, 200, desktopOkReplySchema.parse({ ok: true }));
        }
        case SANDBOX_ROUTES.desktopInputKeyboard: {
          const request = parse(desktopKeyboardRequestSchema, body);
          await desktop().keyboard(request);
          return send(res, 200, desktopOkReplySchema.parse({ ok: true }));
        }
        case SANDBOX_ROUTES.desktopLaunch: {
          const request = parse(desktopLaunchRequestSchema, body);
          await desktop().launch(request.app);
          return send(res, 200, desktopLaunchReplySchema.parse({ launched: true }));
        }
        case SANDBOX_ROUTES.desktopClipboard: {
          const request = parse(desktopClipboardRequestSchema, body);
          await desktop().writeClipboard(request.text);
          return send(res, 200, desktopOkReplySchema.parse({ ok: true }));
        }
        case SANDBOX_ROUTES.desktopOcr: {
          const request = parse(desktopOcrRequestSchema, body);
          return send(res, 200, desktopOcrReplySchema.parse(await desktop().ocr(request)));
        }
        case SANDBOX_ROUTES.desktopA11yAct: {
          const request = parse(desktopA11yActRequestSchema, body);
          return send(res, 200, desktopA11yActReplySchema.parse(await a11y().act(request)));
        }
        default:
          throw notFound(`No route for POST ${url.pathname}.`);
      }
    } catch (error) {
      sendError(res, error);
    }
  };

  return http.createServer((req, res) => {
    void handler(req, res);
  });
}

function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request.');
  }
  return parsed.data;
}

function queryMessage(issue: ZodIssue | undefined): string {
  if (!issue) return 'The query is invalid.';
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

const vncPasswordsFileSchema = z
  .object({ viewOnly: z.string().min(1), full: z.string().min(1) })
  .strict();

/**
 * The view-only password for the owner's viewer (S51). The file also holds the full-control
 * password, which must never leave the sandbox through this route; only the view-only field is
 * returned. A missing or malformed file is an internal error with no path in the message.
 */
async function readViewerCredentials(file: string | undefined): Promise<ViewerCredentialsReply> {
  const passwords = await readPasswords(file);
  return viewerCredentialsReplySchema.parse({ viewOnly: passwords.viewOnly });
}

/**
 * The full-control password (S55). Core asks for it only after the owner takes control; the route is
 * token-protected like every other, and its reply never includes the view-only password.
 */
async function readViewerFullCredentials(
  file: string | undefined,
): Promise<ViewerFullCredentialsReply> {
  const passwords = await readPasswords(file);
  return viewerFullCredentialsReplySchema.parse({ fullControlPassword: passwords.full });
}

async function readPasswords(
  file: string | undefined,
): Promise<z.infer<typeof vncPasswordsFileSchema>> {
  if (!file) throw new SandboxHttpError(404, 'not_found', 'The desktop viewer is not available.');
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = vncPasswordsFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('malformed');
    return parsed.data;
  } catch {
    throw new SandboxHttpError(500, 'internal', 'The desktop credentials are not available.');
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(tooLarge(limit));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return reject(invalidRequest('The request body is empty.'));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(invalidRequest('The request body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof SandboxHttpError) {
    const reply: ErrorReply = { error: { code: error.code, message: error.message } };
    return send(res, error.status, errorReplySchema.parse(reply));
  }
  // Never echo an unexpected error: it could name a host path the model must not see.
  console.error('sandboxd: unexpected error', error instanceof Error ? error.name : 'unknown');
  send(
    res,
    500,
    errorReplySchema.parse({ error: { code: 'internal', message: 'Internal error.' } }),
  );
}

/** Streams one command as NDJSON: start, output chunks, then the exit (or one error). */
async function streamExec(
  res: http.ServerResponse,
  supervisor: ExecSupervisor,
  request: ExecRequest,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  // If the caller goes away (a Stop, a lost connection), the command is stopped too.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const emit = (event: ExecEvent) => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(execEventSchema.parse(event))}\n`);
  };
  try {
    await supervisor.run(request, emit, controller.signal);
  } catch {
    emit({ type: 'error', code: 'internal', message: 'The command could not be started.' });
  } finally {
    res.end();
  }
}
