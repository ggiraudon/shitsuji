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
  'stale',
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

// ---- desktop (S53) ----------------------------------------------------------------------------

/** Apps the model may launch; the daemon never takes an arbitrary command. */
export const DESKTOP_APPS = ['chromium', 'libreoffice', 'thunar', 'xfce4-terminal'] as const;
export const desktopAppSchema = z.enum(DESKTOP_APPS);
export type DesktopApp = z.infer<typeof desktopAppSchema>;

/** Key names and chords xdotool may press; never an arbitrary argument. */
export const DESKTOP_KEYS = [
  'Return',
  'Tab',
  'Escape',
  'BackSpace',
  'Delete',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'Page_Up',
  'Page_Down',
  'space',
  'ctrl+a',
  'ctrl+c',
  'ctrl+l',
  'ctrl+v',
  'ctrl+x',
  'ctrl+z',
  'alt+F4',
] as const;
export const desktopKeySchema = z.enum(DESKTOP_KEYS);
export type DesktopKey = z.infer<typeof desktopKeySchema>;

export const desktopStateReplySchema = z
  .object({
    display: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type DesktopStateReply = z.infer<typeof desktopStateReplySchema>;

/** The screen and its default long-side fit (the daemon clamps `scale` to this). */
export const DESKTOP_MAX_LONG_SIDE = 1280;

export const desktopScreenshotQuerySchema = z
  .object({
    /** 0.05..1; omitted means fit within DESKTOP_MAX_LONG_SIDE. */
    scale: z.coerce.number().min(0.05).max(1).optional(),
  })
  .strict();

export const desktopScreenshotReplySchema = z
  .object({
    encoding: z.literal('base64'),
    content: z.string(),
    mediaType: z.literal('image/png'),
    /** The returned PNG's size. */
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** The display's size before scaling. */
    originalWidth: z.number().int().positive(),
    originalHeight: z.number().int().positive(),
    scale: z.number().positive().max(1),
  })
  .strict();
export type DesktopScreenshotReply = z.infer<typeof desktopScreenshotReplySchema>;

const coordinateSchema = z.number().int().min(0).max(100_000);

export const desktopMouseRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), x: coordinateSchema, y: coordinateSchema }).strict(),
  z
    .object({
      action: z.literal('click'),
      x: coordinateSchema,
      y: coordinateSchema,
      button: z.enum(['left', 'right', 'middle']).default('left'),
    })
    .strict(),
  z
    .object({ action: z.literal('double_click'), x: coordinateSchema, y: coordinateSchema })
    .strict(),
  z.object({ action: z.literal('right_click'), x: coordinateSchema, y: coordinateSchema }).strict(),
  z
    .object({
      action: z.literal('drag'),
      fromX: coordinateSchema,
      fromY: coordinateSchema,
      toX: coordinateSchema,
      toY: coordinateSchema,
      button: z.enum(['left', 'right', 'middle']).default('left'),
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      x: coordinateSchema,
      y: coordinateSchema,
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(20).default(1),
    })
    .strict(),
]);
export type DesktopMouseRequest = z.infer<typeof desktopMouseRequestSchema>;

export const desktopKeyboardRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('type'),
      text: z.string().min(1).max(10_000),
    })
    .strict(),
  z.object({ action: z.literal('key'), key: desktopKeySchema }).strict(),
]);
export type DesktopKeyboardRequest = z.infer<typeof desktopKeyboardRequestSchema>;

export const desktopWindowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    desktop: z.number().int(),
  })
  .strict();
export type DesktopWindow = z.infer<typeof desktopWindowSchema>;

export const desktopWindowsReplySchema = z
  .object({ windows: z.array(desktopWindowSchema) })
  .strict();
export type DesktopWindowsReply = z.infer<typeof desktopWindowsReplySchema>;

export const desktopLaunchRequestSchema = z.object({ app: desktopAppSchema }).strict();
export type DesktopLaunchRequest = z.infer<typeof desktopLaunchRequestSchema>;
export const desktopLaunchReplySchema = z.object({ launched: z.literal(true) }).strict();
export const desktopOkReplySchema = z.object({ ok: z.literal(true) }).strict();
export type DesktopOkReply = z.infer<typeof desktopOkReplySchema>;

export const desktopClipboardRequestSchema = z.object({ text: z.string().max(100_000) }).strict();
export type DesktopClipboardRequest = z.infer<typeof desktopClipboardRequestSchema>;
export const desktopClipboardReplySchema = z.object({ text: z.string() }).strict();
export type DesktopClipboardReply = z.infer<typeof desktopClipboardReplySchema>;

export const desktopOcrRequestSchema = z
  .object({
    region: z
      .object({
        x: coordinateSchema,
        y: coordinateSchema,
        width: z.number().int().positive().max(100_000),
        height: z.number().int().positive().max(100_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DesktopOcrRequest = z.infer<typeof desktopOcrRequestSchema>;
export const desktopOcrReplySchema = z.object({ text: z.string() }).strict();
export type DesktopOcrReply = z.infer<typeof desktopOcrReplySchema>;

// ---- accessibility tree (S54) ------------------------------------------------------------------

/** Actions `desktop.act` may run on an element ref; both are local desktop writes. */
export const DESKTOP_A11Y_ACTIONS = ['click', 'set_text'] as const;
export const desktopA11yActionSchema = z.enum(DESKTOP_A11Y_ACTIONS);
export type DesktopA11yAction = z.infer<typeof desktopA11yActionSchema>;

/** A ref is snapshot-scoped and never an AT-SPI object path. */
export const refSchema = z.string().regex(/^e\d{1,6}$/);
export const snapshotSchema = z.string().regex(/^s\d{1,6}$/);

/** One node of a window's tree, flattened in depth-first order. */
export const desktopA11yNodeSchema = z
  .object({
    /** `e12`: usable with `desktop.act` until this snapshot goes stale. */
    ref: refSchema,
    /** 0 is the window or the requested sub-tree root. */
    depth: z.number().int().min(0).max(200),
    /** The AT-SPI role name, e.g. `push button`. */
    role: z.string().min(1).max(200),
    name: z.string().max(500).optional(),
    /** Editable or displayed text, truncated by the helper. */
    value: z.string().max(2_000).optional(),
    states: z.array(z.string().max(40)).max(20),
    actions: z.array(z.string().max(80)).max(20),
    /** True when a `filter` matched this node itself; ancestors are kept to show the path. */
    matched: z.boolean().optional(),
  })
  .strict();
export type DesktopA11yNode = z.infer<typeof desktopA11yNodeSchema>;

/** A window's tree, its snapshot id and whether the node or token cap cut it. */
export const desktopA11yTreeReplySchema = z
  .object({
    app: z.string().max(200),
    window: z.string().max(500),
    snapshot: snapshotSchema,
    nodes: z.array(desktopA11yNodeSchema).max(10_000),
    /** How many interesting nodes the tree had before any cap. */
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type DesktopA11yTreeReply = z.infer<typeof desktopA11yTreeReplySchema>;

export const desktopA11yTreeQuerySchema = z
  .object({
    /** A window title substring, or the application's name. Omitted: the active window. */
    window: z.string().min(1).max(500).optional(),
    /** Start at this element of the current snapshot instead of the window root (a sub-tree). */
    ref: refSchema.optional(),
    depth: z.coerce.number().int().min(0).max(100).optional(),
    /** Keep only nodes whose role or name contains this text, plus their ancestors. */
    filter: z.string().min(1).max(200).optional(),
  })
  .strict();
export type DesktopA11yTreeQuery = z.infer<typeof desktopA11yTreeQuerySchema>;

export const desktopA11yFindQuerySchema = z
  .object({
    window: z.string().min(1).max(500).optional(),
    name: z.string().min(1).max(200).optional(),
    role: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((query) => query.name !== undefined || query.role !== undefined, {
    message: 'name or role is required',
  });
export type DesktopA11yFindQuery = z.infer<typeof desktopA11yFindQuerySchema>;

export const desktopA11yActRequestSchema = z
  .object({
    /** The snapshot the ref came from; acting after a newer one is still allowed if nothing changed. */
    snapshot: snapshotSchema,
    ref: refSchema,
    action: desktopA11yActionSchema,
    /** The replacement text for `set_text`; never a shell string. */
    text: z.string().max(10_000).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.action === 'set_text' && request.text === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'is required' });
    }
    if (request.action !== 'set_text' && request.text !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'is only allowed with set_text',
      });
    }
  });
export type DesktopA11yActRequest = z.infer<typeof desktopA11yActRequestSchema>;

export const desktopA11yActReplySchema = z
  .object({
    ok: z.literal(true),
    action: desktopA11yActionSchema,
    role: z.string().min(1).max(200),
    name: z.string().max(500).optional(),
    /** The window and app the element belongs to, so the caller can take a fresh snapshot. */
    window: z.string().max(500),
    app: z.string().max(200),
  })
  .strict();
export type DesktopA11yActReply = z.infer<typeof desktopA11yActReplySchema>;

/** One allowed app's tree at the startup check (S54); `tree: false` is the warning. */
export const desktopA11yAppStatusSchema = z
  .object({
    app: desktopAppSchema,
    tree: z.boolean(),
    nodes: z.number().int().nonnegative(),
  })
  .strict();
export type DesktopA11yAppStatus = z.infer<typeof desktopA11yAppStatusSchema>;

export const desktopA11yStatusReplySchema = z
  .object({
    /** False when the helper is down; then every app is missing. */
    helper: z.boolean(),
    apps: z.array(desktopA11yAppStatusSchema),
    missing: z.array(desktopAppSchema),
  })
  .strict();
export type DesktopA11yStatusReply = z.infer<typeof desktopA11yStatusReplySchema>;

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
    /** F10/S53: what the desktop layer can do. Absent on the base image. */
    desktop: z
      .object({
        accessibility: z.boolean(),
        screenshots: z.boolean(),
        takeControl: z.boolean(),
      })
      .strict()
      .optional(),
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
  desktopState: '/desktop/state',
  desktopScreenshot: '/desktop/screenshot',
  desktopInputMouse: '/desktop/input/mouse',
  desktopInputKeyboard: '/desktop/input/keyboard',
  desktopWindows: '/desktop/windows',
  desktopLaunch: '/desktop/apps/launch',
  desktopClipboard: '/desktop/clipboard',
  desktopOcr: '/desktop/ocr',
  desktopA11yTree: '/desktop/a11y/tree',
  desktopA11yFind: '/desktop/a11y/find',
  desktopA11yAct: '/desktop/a11y/act',
  desktopA11yStatus: '/desktop/a11y/status',
} as const;
