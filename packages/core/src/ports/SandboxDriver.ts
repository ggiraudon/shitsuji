import type { OwnerId } from '../domain/model/ids.js';
import type { Tool } from './Tool.js';

/**
 * Where commands and files run (F08, decisions W1–W6, X1–X6). A driver advertises what its sandbox
 * can do; `core` owns the standard tools and registers only the ones the driver supports, so tool
 * names, schemas, effects and trust rules stay the same whichever driver runs them.
 */
export interface SandboxDriver {
  /** `host`, `opensandbox`, `shitsuji`. */
  readonly id: string;
  /** What this sandbox offers, checked once at startup before tools are registered. */
  capabilities(): Promise<SandboxCapabilities>;
  /** One long-lived sandbox per owner now; one per task comes with F15. */
  open(lease: LeaseRequest): Promise<Sandbox>;
  /** Whether the driver and its sandbox are usable now; the answer is logged at startup. */
  health(): Promise<DriverHealth>;
  /**
   * F10/S51: the view-only VNC password for the owner's viewer. Optional: a driver without a
   * desktop does not implement it.
   */
  viewerCredentials?(): Promise<ViewerCredentials>;
  /** Optional tools of the driver itself, always named `<id>.*`. They go through the same pipeline. */
  extraTools?(): Tool[];
}

/** Who the sandbox is opened for; a driver may keep one sandbox per owner. */
export interface LeaseRequest {
  /** The owner the sandbox belongs to; its files and desktop are theirs. */
  ownerId: OwnerId;
}

/** What `health` reports about a driver. */
export interface DriverHealth {
  /** True when the sandbox answered a health check. */
  ok: boolean;
  /** Why it is not healthy, in words the owner can read. */
  detail?: string;
}

/** The view-only credential the viewer page needs (S51). The full-control one never leaves the sandbox. */
export interface ViewerCredentials {
  /** The password for the view-only VNC session; the full-control one is never handed to `core`. */
  viewOnlyPassword: string;
}

/** What a driver's sandbox can do. A missing capability means its tools are not registered. */
export interface SandboxCapabilities {
  /** Can run commands; `maxTimeoutMs` is the longest run it accepts. */
  exec?: {
    /** The driver's own ceiling; the tool never asks for more. */
    maxTimeoutMs: number;
  };
  /** Can read and write files; `roots` names the allowed roots, e.g. `workspace`, `handoff`. */
  files?: {
    /** The roots a model-provided path may resolve inside. */
    roots: readonly string[];
  };
  /** F10. */
  desktop?: {
    /** Can read the widget tree through AT-SPI. */
    accessibility: boolean;
    /** Can take screenshots of the display. */
    screenshots: boolean;
    /** Can expose the owner's VNC viewer. */
    takeControl: boolean;
  };
  /** F09. */
  browser?: {
    /** Exposes a CDP endpoint Playwright can attach to. */
    cdp: boolean;
    /** Keeps a browser profile between runs. */
    persistentProfiles: boolean;
  };
  /** Can reset, snapshot or give each task its own sandbox. */
  lifecycle?: {
    /** Can throw the sandbox's state away. */
    reset: boolean;
    /** Can save and restore a snapshot. */
    snapshot: boolean;
    /** Can open one sandbox per task. */
    perTask: boolean;
  };
  /** Claims `core` checks with its egress probes (S42); not trusted until then. */
  egress: {
    /** Claims the sandbox cannot reach the LAN or `core`. */
    lanBlocked: boolean;
    /** Claims placeholders are swapped for real credentials on bound hosts. */
    credentialSwap: boolean;
  };
}

/** One open sandbox: the capabilities it actually provides, and how to close it. */
export interface Sandbox {
  /** Command execution, when the driver implements it. */
  exec?: SandboxExec;
  /** File access inside the sandbox's roots. */
  files?: SandboxFiles;
  /** GUI control, when a desktop is available. */
  desktop?: DesktopCapability;
  /** Browser control, when a browser is available. */
  browser?: BrowserCapability;
  /** Answers whether an address is reachable from inside this sandbox (S42). */
  egress?: SandboxEgress;
  /** Releases the sandbox; the process calls it once on shutdown. */
  close(): Promise<void>;
}

/**
 * The egress probe's way in: can the sandbox open a TCP connection to this address? It runs where the
 * commands run, so an `exec` host and a container answer for their own network.
 */
export interface SandboxEgress {
  /** Resolves true when a TCP connection to `host:port` succeeds within `timeoutMs`. */
  reachable(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

/** Runs one program. No shell: each argument is passed as itself. */
export interface SandboxExec {
  /** The longest timeout this sandbox allows; the tool caps the request to it. */
  readonly maxTimeoutMs: number;
  /** Streams output, then one exit event; throws for a program that could not start. */
  run(request: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecEvent>;
}

/** One command to run: a program, its arguments, and the folder and limits it gets. */
export interface ExecRequest {
  /** The program to start, as a path or a name on the sandbox's PATH. */
  program: string;
  /** The arguments, passed as themselves (no shell). */
  args: readonly string[];
  /** Absolute path inside the sandbox. */
  cwd: string;
  /** How long the program may run; the tool caps it to `maxTimeoutMs`. */
  timeoutMs: number;
  /** The environment the program sees; never the host's own. */
  env?: Readonly<Record<string, string>>;
}

/** One line of a command's output, or the single exit event. */
export type ExecEvent =
  | {
      /** A line or chunk of standard output. */
      type: 'stdout';
      /** The text as the program wrote it. */
      text: string;
    }
  | {
      /** A line or chunk of standard error. */
      type: 'stderr';
      /** The text as the program wrote it. */
      text: string;
    }
  | {
      /** The program ended; no further events follow. */
      type: 'exit';
      /** The exit code, or null when a signal ended it. */
      code: number | null;
      /** The signal that ended it, e.g. `SIGTERM`, when there was one. */
      signal?: string;
      /** True when the driver stopped it at `timeoutMs`. */
      timedOut: boolean;
    };

/** What `stat` reports about one path. */
export interface FileStat {
  /** Size in bytes. */
  size: number;
  /** True for a regular file; false for a directory or a device. */
  isFile: boolean;
}

/** One entry of a folder listing. */
export interface FileEntry {
  /** The entry's name, without its path. */
  name: string;
  /** True for a folder, false for a file. */
  directory: boolean;
}

/**
 * Files inside the sandbox's roots. `resolve` and `resolveRead` confine a model-provided path;
 * every other method takes the absolute path they returned.
 */
export interface SandboxFiles {
  /** An absolute path inside the workspace; refuses `..`, absolute paths and links out. */
  resolve(path: string): Promise<string>;
  /** Like `resolve`, but the read-only roots (the handoff folder) are allowed too. */
  resolveRead(path: string): Promise<string>;
  /** The path as the owner should see it: relative to the workspace. */
  display(absolute: string): string;
  /** The file's text; throws when it is missing or not readable as UTF-8 text. */
  read(absolute: string): Promise<string>;
  /** The file's bytes, unchanged: an image or a PDF is not text. */
  readBytes(absolute: string): Promise<Uint8Array>;
  /** Writes bytes, for a screenshot or another binary result (S53). */
  writeBytes(absolute: string, content: Uint8Array): Promise<void>;
  /** Undefined when nothing is there. */
  stat(absolute: string): Promise<FileStat | undefined>;
  /** Writes text, replacing the file unless `append` is set; creates the file's folder. */
  write(absolute: string, content: string, options: { append: boolean }): Promise<void>;
  /** Creates a folder (and its parents) inside the roots. */
  mkdir(absolute: string): Promise<void>;
  /** Undefined when the folder is not there. */
  list(absolute: string): Promise<FileEntry[] | undefined>;
}

/** F10/S53: the desktop the agent can see and drive. */
export interface DesktopCapability {
  /** Can read the widget tree through AT-SPI. */
  readonly accessibility: boolean;
  /** Can take screenshots of the display. */
  readonly screenshots: boolean;
  state(signal?: AbortSignal): Promise<DesktopState>;
  screenshot(opts?: { scale?: number }, signal?: AbortSignal): Promise<DesktopImage>;
  windows(signal?: AbortSignal): Promise<DesktopWindow[]>;
  act(action: DesktopAction, signal: AbortSignal): Promise<void>;
  ocr(opts?: { region?: DesktopRect }, signal?: AbortSignal): Promise<DesktopOcrResult>;
  readClipboard(signal?: AbortSignal): Promise<string>;
  writeClipboard(text: string, signal?: AbortSignal): Promise<void>;
}

export interface DesktopState {
  display: string;
  width: number;
  height: number;
}

/** A PNG the provider can send; `width`/`height` are the returned pixels, the originals are pre-scale. */
export interface DesktopImage {
  mediaType: 'image/png';
  data: Uint8Array;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** Scale actually applied, 0.05..1. */
  scale: number;
}

export interface DesktopWindow {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  desktop: number;
}

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { kind: 'double_click'; x: number; y: number }
  | { kind: 'right_click'; x: number; y: number }
  | {
      kind: 'drag';
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      button?: 'left' | 'right' | 'middle';
    }
  | {
      kind: 'scroll';
      x: number;
      y: number;
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: number;
    }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'launch_app'; app: 'chromium' | 'libreoffice' | 'thunar' | 'xfce4-terminal' };

export interface DesktopOcrResult {
  text: string;
}

/** F09; named now for the same reason. */
export interface BrowserCapability {
  /** Exposes a CDP endpoint Playwright can attach to. */
  readonly cdp: boolean;
}
