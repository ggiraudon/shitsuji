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
  /** F10/S55: the full-control password, only while the owner holds control. */
  fullViewerCredentials?(): Promise<FullViewerCredentials>;
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

/** The full-control credential, asked for only while the owner has control (S55). */
export interface FullViewerCredentials {
  /** The password for the full-control VNC session; never logged or returned outside the viewer. */
  fullControlPassword: string;
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
  /** The display's size and name, for coordinates and for the viewer. */
  state(signal?: AbortSignal): Promise<DesktopState>;
  /** A PNG of the whole display, optionally scaled down (`scale` 0.05..1). */
  screenshot(opts?: { scale?: number }, signal?: AbortSignal): Promise<DesktopImage>;
  /** The top-level windows, so the model can aim at one rather than guess coordinates. */
  windows(signal?: AbortSignal): Promise<DesktopWindow[]>;
  /** Performs one pointer, keyboard or launch action; the signal stops a slow one. */
  act(action: DesktopAction, signal: AbortSignal): Promise<void>;
  /** Text found on screen, optionally inside a region; read-only, for the model to inspect. */
  ocr(opts?: { region?: DesktopRect }, signal?: AbortSignal): Promise<DesktopOcrResult>;
  /** The desktop clipboard's text. */
  readClipboard(signal?: AbortSignal): Promise<string>;
  /** Replaces the desktop clipboard's text. */
  writeClipboard(text: string, signal?: AbortSignal): Promise<void>;
  /** The AT-SPI tree with snapshot-scoped refs (S54); only when `accessibility` is true. */
  inspect(request: DesktopA11yTreeQuery, signal?: AbortSignal): Promise<DesktopA11yTree>;
  /** Elements matching a name or role, with refs (S54). */
  find(request: DesktopA11yFindQuery, signal?: AbortSignal): Promise<DesktopA11yTree>;
  /** Runs an action on a ref; a stale ref throws with "stale, take a new snapshot" (S54). */
  actOnElement(request: DesktopA11yActRequest, signal?: AbortSignal): Promise<DesktopA11yActResult>;
  /** Which allowed apps publish a tree, for the startup check and `/status` (S54). */
  accessibilityStatus(signal?: AbortSignal): Promise<DesktopA11yStatus>;
}

/** The display a desktop runs on: its name and its pixel size. */
export interface DesktopState {
  /** The X display, e.g. `:0`. */
  display: string;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** A PNG the provider can send; `width`/`height` are the returned pixels, the originals are pre-scale. */
export interface DesktopImage {
  /** Always PNG; the providers accept it. */
  mediaType: 'image/png';
  /** The image bytes, exactly as captured (or scaled). */
  data: Uint8Array;
  /** The width of the returned pixels. */
  width: number;
  /** The height of the returned pixels. */
  height: number;
  /** The display width before scaling, for mapping a click back to real coordinates. */
  originalWidth: number;
  /** The display height before scaling. */
  originalHeight: number;
  /** Scale actually applied, 0.05..1. */
  scale: number;
}

/** One top-level window on the desktop. */
export interface DesktopWindow {
  /** The window manager's id, stable while the window exists. */
  id: string;
  /** The title bar text. */
  title: string;
  /** Left edge, in display pixels. */
  x: number;
  /** Top edge, in display pixels. */
  y: number;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** The virtual desktop the window is on. */
  desktop: number;
}

/** A rectangle on the display, in pixels. */
export interface DesktopRect {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
}

/** One pointer, keyboard or launch action the model can ask for. */
export type DesktopAction =
  | {
      /** Move the pointer without clicking. */
      kind: 'move';
      /** Target x in display pixels. */
      x: number;
      /** Target y in display pixels. */
      y: number;
    }
  | {
      /** A single click. */
      kind: 'click';
      /** Target x in display pixels. */
      x: number;
      /** Target y in display pixels. */
      y: number;
      /** Which button; left when unset. */
      button?: 'left' | 'right' | 'middle';
    }
  | {
      /** Two clicks in quick succession. */
      kind: 'double_click';
      /** Target x in display pixels. */
      x: number;
      /** Target y in display pixels. */
      y: number;
    }
  | {
      /** A click with the right button. */
      kind: 'right_click';
      /** Target x in display pixels. */
      x: number;
      /** Target y in display pixels. */
      y: number;
    }
  | {
      /** Press, move and release, e.g. to select text or move a window. */
      kind: 'drag';
      /** Start x. */
      fromX: number;
      /** Start y. */
      fromY: number;
      /** End x. */
      toX: number;
      /** End y. */
      toY: number;
      /** Which button; left when unset. */
      button?: 'left' | 'right' | 'middle';
    }
  | {
      /** A scroll wheel step at a point. */
      kind: 'scroll';
      /** Pointer x while scrolling. */
      x: number;
      /** Pointer y while scrolling. */
      y: number;
      /** Which way to scroll. */
      direction: 'up' | 'down' | 'left' | 'right';
      /** How many steps; one when unset. */
      amount?: number;
    }
  | {
      /** Type text into the focused window. */
      kind: 'type';
      /** The text to type. */
      text: string;
    }
  | {
      /** Press one key or chord, named as xdotool names it. */
      kind: 'key';
      /** The key, e.g. `Return` or `ctrl+s`. */
      key: string;
    }
  | {
      /** Start one of the desktop's known applications. */
      kind: 'launch_app';
      /** Which application to start. */
      app: 'chromium' | 'libreoffice' | 'thunar' | 'xfce4-terminal';
    };

/** Text read off the screen. */
export interface DesktopOcrResult {
  /** The recognised text, in reading order. */
  text: string;
}

/** One node of an AT-SPI tree; `ref` is snapshot-scoped and never an AT-SPI object path. */
export interface DesktopA11yTreeNode {
  ref: string;
  depth: number;
  role: string;
  name?: string;
  value?: string;
  states: readonly string[];
  actions: readonly string[];
  /** True when a filter matched this node itself. */
  matched?: boolean;
}

/** A window's tree and the snapshot its refs belong to (S54). */
export interface DesktopA11yTree {
  app: string;
  window: string;
  snapshot: string;
  nodes: readonly DesktopA11yTreeNode[];
  total: number;
  truncated: boolean;
}

export interface DesktopA11yTreeQuery {
  /** A window title substring or the application's name; omitted means the active window. */
  window?: string;
  /** Start at this element of the current snapshot (a sub-tree). */
  ref?: string;
  depth?: number;
  filter?: string;
}

export interface DesktopA11yFindQuery {
  window?: string;
  name?: string;
  role?: string;
}

export interface DesktopA11yActRequest {
  snapshot: string;
  ref: string;
  action: 'click' | 'set_text';
  /** The replacement text for `set_text`, as one value; never a shell string. */
  text?: string;
}

export interface DesktopA11yActResult {
  action: 'click' | 'set_text';
  role: string;
  name?: string;
  /** The window and app, so the tool can take a fresh snapshot of the same window. */
  window: string;
  app: string;
}

export interface DesktopA11yAppStatus {
  app: string;
  tree: boolean;
  nodes: number;
}

export interface DesktopA11yStatus {
  helper: boolean;
  apps: readonly DesktopA11yAppStatus[];
  missing: readonly string[];
}

/** F09; named now for the same reason. */
export interface BrowserCapability {
  /** Exposes a CDP endpoint Playwright can attach to. */
  readonly cdp: boolean;
}
