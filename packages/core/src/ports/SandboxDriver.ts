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
  capabilities(): Promise<SandboxCapabilities>;
  /** One long-lived sandbox per owner now; one per task comes with F15. */
  open(lease: LeaseRequest): Promise<Sandbox>;
  health(): Promise<DriverHealth>;
  /** Optional tools of the driver itself, always named `<id>.*`. They go through the same pipeline. */
  extraTools?(): Tool[];
}

export interface LeaseRequest {
  ownerId: OwnerId;
}

export interface DriverHealth {
  ok: boolean;
  /** Why it is not healthy, in words the owner can read. */
  detail?: string;
}

/** What a driver's sandbox can do. A missing capability means its tools are not registered. */
export interface SandboxCapabilities {
  exec?: { maxTimeoutMs: number };
  files?: { roots: readonly string[] };
  /** F10. */
  desktop?: { accessibility: boolean; screenshots: boolean; takeControl: boolean };
  /** F09. */
  browser?: { cdp: boolean; persistentProfiles: boolean };
  lifecycle?: { reset: boolean; snapshot: boolean; perTask: boolean };
  /** Claims `core` checks with its egress probes (S42); not trusted until then. */
  egress: { lanBlocked: boolean; credentialSwap: boolean };
}

/** One open sandbox: the capabilities it actually provides, and how to close it. */
export interface Sandbox {
  exec?: SandboxExec;
  files?: SandboxFiles;
  desktop?: DesktopCapability;
  browser?: BrowserCapability;
  /** Answers whether an address is reachable from inside this sandbox (S42). */
  egress?: SandboxEgress;
  close(): Promise<void>;
}

/**
 * The egress probe's way in: can the sandbox open a TCP connection to this address? It runs where the
 * commands run, so an `exec` host and a container answer for their own network.
 */
export interface SandboxEgress {
  reachable(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

/** Runs one program. No shell: each argument is passed as itself. */
export interface SandboxExec {
  /** The longest timeout this sandbox allows; the tool caps the request to it. */
  readonly maxTimeoutMs: number;
  /** Streams output, then one exit event; throws for a program that could not start. */
  run(request: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecEvent>;
}

export interface ExecRequest {
  program: string;
  args: readonly string[];
  /** Absolute path inside the sandbox. */
  cwd: string;
  timeoutMs: number;
  /** The environment the program sees; never the host's own. */
  env?: Readonly<Record<string, string>>;
}

export type ExecEvent =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'exit'; code: number | null; signal?: string; timedOut: boolean };

export interface FileStat {
  size: number;
  isFile: boolean;
}

export interface FileEntry {
  name: string;
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
  read(absolute: string): Promise<string>;
  /** The file's bytes, unchanged: an image or a PDF is not text. */
  readBytes(absolute: string): Promise<Uint8Array>;
  /** Undefined when nothing is there. */
  stat(absolute: string): Promise<FileStat | undefined>;
  write(absolute: string, content: string, options: { append: boolean }): Promise<void>;
  /** Creates a folder (and its parents) inside the roots. */
  mkdir(absolute: string): Promise<void>;
  /** Undefined when the folder is not there. */
  list(absolute: string): Promise<FileEntry[] | undefined>;
}

/** F10; named now so the driver port does not change when the desktop lands. */
export interface DesktopCapability {
  readonly accessibility: boolean;
  readonly screenshots: boolean;
}

/** F09; named now for the same reason. */
export interface BrowserCapability {
  readonly cdp: boolean;
}
