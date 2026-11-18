import http from 'node:http';
import {
  EXEC_SIGNAL_ROUTE,
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_ROUTES,
  SANDBOX_TOKEN_HEADER,
  capabilitiesReplySchema,
  errorReplySchema,
  execEventSchema,
  execRequestSchema,
  healthReplySchema,
  listFilesReplySchema,
  listFilesRequestSchema,
  moveFileReplySchema,
  moveFileRequestSchema,
  readFileReplySchema,
  readFileRequestSchema,
  signalExecReplySchema,
  signalExecRequestSchema,
  statFileReplySchema,
  statFileRequestSchema,
  writeFileReplySchema,
  writeFileRequestSchema,
  type ErrorReply,
  type ExecEvent,
  type ExecRequest,
  type SandboxRoot,
} from '@shitsuji/sandbox-protocol';
import type { ZodTypeAny, z } from 'zod';
import { tokenMatches } from './auth.js';
import type { ExecSupervisor } from './exec.js';
import { invalidRequest, notFound, SandboxHttpError, tooLarge } from './errors.js';
import type { SandboxFilesService } from './files.js';

export interface SandboxServerDeps {
  token: string;
  files: SandboxFilesService;
  exec: ExecSupervisor;
  maxBodyBytes?: number;
  /** The protocol version reported on /health and /capabilities. */
  version?: number;
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
          }),
        );
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
        case SANDBOX_ROUTES.move: {
          const request = parse(moveFileRequestSchema, body);
          const reply = await deps.files.move(request.root, request);
          return send(res, 200, moveFileReplySchema.parse(reply));
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
