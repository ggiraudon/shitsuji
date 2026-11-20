import { z } from 'zod';

/**
 * The contract between `core` and `sandboxd` (decision X1): every request, reply and error crosses
 * the wire as JSON validated here, in both directions. It is not the client contract; that stays in
 * `@shitsuji/shared`.
 */

/** Bumped when a change is not backwards compatible. */
export const SANDBOX_PROTOCOL_VERSION = 3;

/** The header `core` sends; the value is the sandbox's `SANDBOX_TOKEN`. */
export const SANDBOX_TOKEN_HEADER = 'x-sandbox-token';

/** The two folders a sandbox exposes, as names the model may use. */
export const SANDBOX_ROOTS = ['workspace', 'handoff'] as const;
export type SandboxRoot = (typeof SANDBOX_ROOTS)[number];

export const sandboxRootSchema = z.enum(SANDBOX_ROOTS);

/** True when a path is relative, has no `..` segment and no NUL byte. */
export function isRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * A path the model gave, relative to one of the roots. The daemon resolves and confines it again:
 * this only rejects the obvious mistakes early, so a bad path is a 400 rather than a file operation.
 */
export const sandboxPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isRelativePath, 'must be a relative path inside the root, with no ".."');

const encodingSchema = z.enum(['text', 'base64']);
const bytesSchema = z.number().int().nonnegative();

// ---- reads -------------------------------------------------------------------------------------

export const readFileRequestSchema = z
  .object({
    root: sandboxRootSchema,
    path: sandboxPathSchema,
    /** `text` for UTF-8, `base64` for a binary file (an image or a PDF). */
    encoding: encodingSchema.default('text'),
  })
  .strict();
export type ReadFileRequest = z.infer<typeof readFileRequestSchema>;

/** The file's content in the requested encoding, and its size in bytes. */
export const readFileReplySchema = z
  .object({
    encoding: encodingSchema,
    content: z.string(),
    bytes: bytesSchema,
  })
  .strict();
export type ReadFileReply = z.infer<typeof readFileReplySchema>;

// ---- writes ------------------------------------------------------------------------------------

export const writeFileRequestSchema = z
  .object({
    root: sandboxRootSchema,
    path: sandboxPathSchema,
    encoding: encodingSchema.default('text'),
    content: z.string(),
    append: z.boolean().default(false),
    /** Create the parent folders; when false a missing folder is an error. */
    createParents: z.boolean().default(true),
  })
  .strict();
export type WriteFileRequest = z.infer<typeof writeFileRequestSchema>;

export const writeFileReplySchema = z.object({ bytes: bytesSchema }).strict();
export type WriteFileReply = z.infer<typeof writeFileReplySchema>;

// ---- listing, stat and move --------------------------------------------------------------------

export const listFilesRequestSchema = z
  .object({ root: sandboxRootSchema, path: sandboxPathSchema })
  .strict();
export type ListFilesRequest = z.infer<typeof listFilesRequestSchema>;

export const fileEntrySchema = z
  .object({
    name: z.string(),
    directory: z.boolean(),
    size: bytesSchema,
  })
  .strict();
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const listFilesReplySchema = z.object({ entries: z.array(fileEntrySchema) }).strict();
export type ListFilesReply = z.infer<typeof listFilesReplySchema>;

export const statFileRequestSchema = listFilesRequestSchema;
export type StatFileRequest = ListFilesRequest;

/** A missing file is a normal answer (`exists: false`), not an error. */
export const statFileReplySchema = z.union([
  z.object({ exists: z.literal(false) }).strict(),
  z
    .object({
      exists: z.literal(true),
      size: bytesSchema,
      isFile: z.boolean(),
      isDirectory: z.boolean(),
      /** ISO 8601, when the platform gives one. */
      modifiedAt: z.string().optional(),
    })
    .strict(),
]);
export type StatFileReply = z.infer<typeof statFileReplySchema>;

export const moveFileRequestSchema = z
  .object({
    root: sandboxRootSchema,
    from: sandboxPathSchema,
    to: sandboxPathSchema,
    /** When false an existing target is an error. */
    overwrite: z.boolean().default(false),
  })
  .strict();
export type MoveFileRequest = z.infer<typeof moveFileRequestSchema>;

export const moveFileReplySchema = z.object({ moved: z.literal(true) }).strict();
export type MoveFileReply = z.infer<typeof moveFileReplySchema>;

/** Creates a folder inside a root (the service makes `shared/` and `tools/` at open, S45). */
export const mkdirRequestSchema = z
  .object({
    root: sandboxRootSchema,
    path: sandboxPathSchema,
    createParents: z.boolean().default(true),
  })
  .strict();
export type MkdirRequest = z.infer<typeof mkdirRequestSchema>;

export const mkdirReplySchema = z.object({ created: z.literal(true) }).strict();
export type MkdirReply = z.infer<typeof mkdirReplySchema>;

/** Asks the daemon whether an address answers a TCP connection from inside the sandbox (S42 probes). */
export const probeRequestSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    timeoutMs: z.number().int().min(1).max(30_000).default(2_000),
  })
  .strict();
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export const probeReplySchema = z.object({ reachable: z.boolean() }).strict();
export type ProbeReply = z.infer<typeof probeReplySchema>;

export const SANDBOX_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'not_found',
  'outside_root',
  'read_only',
  'already_exists',
  'too_large',
  'internal',
] as const;
export const sandboxErrorCodeSchema = z.enum(SANDBOX_ERROR_CODES);
export type SandboxErrorCode = z.infer<typeof sandboxErrorCodeSchema>;
// ---- exec (S46) --------------------------------------------------------------------------------

/** The longest a command may run; the daemon reports it on /capabilities. */
export const SANDBOX_MAX_TIMEOUT_MS = 3_600_000;

export const execRequestSchema = z
  .object({
    /** Program and arguments; no shell is involved. */
    argv: z.array(z.string().min(1)).min(1).max(256),
    /** Folder inside the workspace, relative to it. */
    cwd: sandboxPathSchema.default('.'),
    /**
     * The command's whole environment. It never inherits the daemon's: the daemon starts from a
     * minimal fixed environment and adds these, so its secrets (the sandbox token) stay out.
     */
    env: z.record(z.string().max(4096)).default({}),
    /** Killed (TERM, then KILL) when this passes. */
    timeoutMs: z.number().int().min(1).max(SANDBOX_MAX_TIMEOUT_MS).default(600_000),
    /** Written to the command's stdin, which is then closed. */
    stdin: z.string().optional(),
  })
  .strict();
export type ExecRequest = z.infer<typeof execRequestSchema>;

/** One NDJSON line of the exec stream: start, output chunks, then one exit (or one error). */
export const execEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), id: z.string() }).strict(),
  z.object({ type: z.literal('stdout'), text: z.string() }).strict(),
  z.object({ type: z.literal('stderr'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('exit'),
      code: z.number().int().nullable(),
      signal: z.string().optional(),
      timedOut: z.boolean(),
      /** The output cap was reached; the rest is dropped. */
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      code: sandboxErrorCodeSchema,
      message: z.string(),
    })
    .strict(),
]);
export type ExecEvent = z.infer<typeof execEventSchema>;

/** `POST /exec/:id/signal`: TERM by default, then KILL after `graceMs`. */
export const signalExecRequestSchema = z
  .object({
    signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).default('SIGTERM'),
    graceMs: z.number().int().min(0).max(60_000).default(2_000),
  })
  .strict();
export type SignalExecRequest = z.infer<typeof signalExecRequestSchema>;

export const signalExecReplySchema = z.object({ stopped: z.literal(true) }).strict();
export type SignalExecReply = z.infer<typeof signalExecReplySchema>;

/** How `core` names the command it wants to stop. */
export const EXEC_SIGNAL_ROUTE = /^\/exec\/([^/]+)\/signal$/;

// ---- desktop viewer (S51) ---------------------------------------------------------------------

/**
 * The view-only VNC password for the owner's viewer. The daemon reads it from the file the desktop
 * launcher writes at start; the full-control password never leaves the sandbox.
 */
export const viewerCredentialsReplySchema = z.object({ viewOnly: z.string().min(1) }).strict();
export type ViewerCredentialsReply = z.infer<typeof viewerCredentialsReplySchema>;

// ---- health, capabilities and errors ----------------------------------------------------------

export const healthReplySchema = z
  .object({ ok: z.literal(true), version: z.number().int() })
  .strict();
export type HealthReply = z.infer<typeof healthReplySchema>;

export const capabilitiesReplySchema = z
  .object({
    version: z.number().int(),
    files: z.object({ roots: z.array(sandboxRootSchema) }).strict(),
    /** The longest timeout the daemon allows for one command (S46). */
    exec: z.object({ maxTimeoutMs: z.number().int().positive() }).strict(),
  })
  .strict();
export type CapabilitiesReply = z.infer<typeof capabilitiesReplySchema>;

export const errorReplySchema = z
  .object({
    error: z.object({ code: sandboxErrorCodeSchema, message: z.string() }).strict(),
  })
  .strict();
export type ErrorReply = z.infer<typeof errorReplySchema>;

/** The HTTP paths sandboxd serves; the signal route is a pattern because it carries the id. */
export const SANDBOX_ROUTES = {
  health: '/health',
  capabilities: '/capabilities',
  read: '/files/read',
  write: '/files/write',
  list: '/files/list',
  stat: '/files/stat',
  move: '/files/move',
  mkdir: '/files/mkdir',
  probe: '/probe',
  exec: '/exec',
  viewerCredentials: '/desktop/viewer-credentials',
} as const;
