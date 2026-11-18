# F08 — Sandbox drivers and the workspace

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 2 Own computer | 10 | M | F05, F11 | F09, F10, F20, F21 |

## What it is

Where the agent runs commands, writes code and handles files: Python, Node, git, ffmpeg, pandoc, poppler,
tesseract, jq, ripgrep, sqlite. Today's shell and file tools run on the host with no real limits; this
feature moves them into a sandbox.

`core` reaches the sandbox through a **driver** (decisions W1–W6 in
[05-open-questions.md](../05-open-questions.md)). A driver advertises what its sandbox can do; `core` owns
the tools and registers the ones the driver supports. Three drivers are planned:

| Driver | What it is | When |
|--------|-----------|------|
| `host` | Today's workspace tools on the host, wrapped as a driver. No isolation; it reports no egress control | First, so nothing changes while the port lands |
| `opensandbox` | A self-hosted [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) server, reached through its TypeScript SDK | Next, to test real isolation early |
| `shitsuji` | Our own `sandbox` container with `sandboxd`, plus `egress-proxy` | Then; the default once it passes the conformance suite |

## Inspiration

- **nod:** commands run as an unprivileged user; no host environment; a **command supervisor** owns each
  command's process session and kills the whole tree on Stop (escalating to `SIGKILL`), including detached
  children; timeouts; output capped at 1 MiB with head and tail kept and the full log saved; a lost
  acknowledgement fences the workspace until restart; provider keys never enter the container; installed tools
  persist in a separate home volume.
- **openfuse:** a `ComputerSession` with `exec`, file operations and `stop`; nonroot, no host mounts; command
  receipts; no fallback to running on the API host if Docker is unavailable.
- **OpenSandbox** (used as a service, not as code): per-sandbox egress allow/deny enforced by DNS filtering
  and a default-deny firewall; a sandbox lifecycle API; an optional credential vault on the egress path.

## Design

### The driver port

```ts
// ports/SandboxDriver.ts
export interface SandboxDriver {
  readonly id: string;                          // 'host', 'opensandbox', 'shitsuji'
  capabilities(): Promise<SandboxCapabilities>;
  open(lease: LeaseRequest): Promise<Sandbox>;  // one long-lived sandbox now; one per task later (F15)
  health(): Promise<DriverHealth>;
  extraTools?(): Tool[];                        // optional, always named `<id>.*`
}

export interface SandboxCapabilities {
  exec?: { maxTimeoutMs: number };
  files?: { roots: string[] };
  desktop?: { accessibility: boolean; screenshots: boolean; takeControl: boolean }; // F10
  browser?: { cdp: boolean; persistentProfiles: boolean };                          // F09
  lifecycle?: { reset: boolean; snapshot: boolean; perTask: boolean };
  egress: { lanBlocked: boolean; credentialSwap: boolean };                         // checked, see below
}

export interface Sandbox {
  exec?: ExecCapability;        // run(req, signal) → stream of output, then the exit code
  files?: FileCapability;       // read, write, list, stat, move inside the roots
  desktop?: DesktopCapability;  // F10
  browser?: BrowserCapability;  // F09
  close(): Promise<void>;
}
```

A driver is a plugin that `provides: ['sandbox']`. The config picks one:

```yaml
sandbox:
  driver: shitsuji          # host | opensandbox | shitsuji
  opensandbox:
    url: http://opensandbox:8080
    apiKey: ${OPENSANDBOX_API_KEY}
```

### Core owns the tools

`core` defines every standard tool once, whichever driver runs it, so trust rules
(`{ tool: workspace.exec, verdict: ask }`), receipts, evals and the prompt stay the same:

| Tool | Needs | Effect | Notes |
|------|-------|--------|-------|
| `workspace.exec` | `exec` | `write_local` | Default timeout 10 min, max 60 (capped by the driver's `maxTimeoutMs`); output head+tail to the model, full log to a file |
| `workspace.read` / `write` / `edit` / `list` / `find` | `files` | `read` / `write_local` | Edits by exact string replacement, like coding agents |
| `workspace.send` | `files` | `external` (to you) | Delivers a sandbox file through the gateway; the shipped default rule allows it without asking (X4) |

Tools whose capability the driver lacks are not registered. A driver's extra tools go through the same
pipeline, trust checks and receipts, their output is wrapped as untrusted data, and they are found through
`tool_search`. A driver can never change a standard tool's effect; an extra tool's declared effect can be
tightened by a standing rule.

**What S41 builds.** The standard tools are complete: `workspace.edit` replaces an exact piece of text
and refuses a missing or ambiguous match, and `workspace.find` looks for files by glob, by text, or both.
`workspace.exec` defaults to ten minutes (at most an hour, still capped by the driver's `maxTimeoutMs`);
output over 1 MiB keeps its head and tail for the model and the whole of it goes to
`sessions/<sessionId>/exec-<turnId>-<n>.log`. The sandbox opens with `shared/` and `tools/` in place.
`workspace.send` is `external`, its bytes come over the files port and are staged in
`<dataDir>/handoff/outbox` for the channel (so an image or a PDF arrives unchanged, whichever driver
runs), and a shipped rule always allows it without a card (X4), merged with the owner's rules so an
owner's `ask` or `deny` rule still overrides it.

**What S40 builds.** The port above, the tool definitions moved to `application/sandbox/tools`, and the
`host` driver in `adapters/sandbox/host`: the workspace root, its path confinement, and exec as a child
process, exactly as before. `SandboxService` opens the sandbox named by `sandbox.driver` (default `host`)
once for the owner, registers the tools its capabilities allow, and closes it on stop. Tool names, schemas,
effects, receipts and the config's `tools.exec.enabled` are unchanged, so nothing about a turn differs
from the old code; naming a driver this build does not have yet is a `SandboxUnavailable` error at
startup, never a fallback to `host`.

### Safety claims are checked

`egress.lanBlocked` and `egress.credentialSwap` are claims, and `core` tests them:

- At startup (and on `health()`), `core` runs probes inside the sandbox: a private LAN address, `core`'s own
  API, Postgres. If any is reachable while the driver claims `lanBlocked`, the driver is refused and the
  sandbox tools stay off, with a clear error.
- Without `lanBlocked`, the sandbox gets **no network** (or the driver is refused, if the config says so).
  The `host` driver always reports `false`.
- Without `credentialSwap`, F12 never gives that sandbox a credential placeholder.

### Conformance suite

One contract test file (`test/contracts/sandbox.contract.ts`) runs against every driver; each test runs only
if the driver claims the capability it covers:

- `python3 -c 'print(1)'` returns `1`; a non-zero exit and stderr come back as such.
- A timeout kills the command; Stop kills the whole process tree, including `sleep infinity &`.
- A fork bomb is contained and cleaned up.
- Output over the cap keeps head and tail and saves the full log.
- File paths that escape the roots (`..`, symlinks) are refused.
- The egress probes match the driver's claim.

The `host` driver runs the suite in unit tests; `opensandbox` and `shitsuji` run it in integration tests
against real containers.

### The `shitsuji` driver

**The container.** One `sandbox` service, built in two layers: `shitsuji/sandbox` for this feature, and
`shitsuji/sandbox-desktop` on top of it for [F10](F10-desktop.md) and [F09](F09-browser.md).

```yaml
sandbox:
  image: shitsuji/sandbox            # shitsuji/sandbox-desktop once F10 lands
  user: "1000:1000"
  init: true
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  read_only: true
  tmpfs: ["/tmp:size=1g"]
  pids_limit: 1024
  mem_limit: 4g
  cpus: 2
  volumes:
    - type: volume                   # project files, per-session folders: the existing
      source: coredata               # workspace folder, no copy (X5)
      target: /workspace
      volume: { subpath: workspace }
    - type: volume                   # shared with core: channel attachments in, files to send out
      source: coredata
      target: /handoff
      volume: { subpath: handoff }
    - sandbox-home:/home/agent       # pip/npm installs, later browser profiles
  networks: [sandbox]                # internet only through egress-proxy
  environment:
    SANDBOX_TOKEN: ${SANDBOX_TOKEN}  # only secret: authenticates core to sandboxd
```

**sandboxd**, a small TypeScript daemon in `packages/sandbox-daemon`, sharing types with `core` through
`packages/sandbox-protocol` (X1), listening only on the `sandbox` network:

| Endpoint | Purpose |
|----------|---------|
| `POST /exec` | Start a command: `{ argv, cwd, env, timeoutMs, stdin? }` → stream of stdout/stderr chunks, then the exit code |
| `POST /exec/:id/signal` | Stop a command: kill its whole process group, then `SIGKILL` after a grace period |
| `POST /files/read`, `/files/write`, `/files/list`, `/files/stat`, `/files/move` | File API confined to `/workspace` and `/handoff` (paths resolved, symlinks checked) |
| `GET /capabilities`, `GET /health` | What this image supports; Compose health checks |

The supervisor starts each command in its own process session (`setsid`), tracks every descendant, enforces
the timeout and an output cap, and confirms when the command ends. The desktop endpoints come with F10.

**egress-proxy** is its own small Node container, the sandbox's only way out: it blocks private ranges and
`core`, tunnels ordinary HTTPS, and later swaps credential placeholders on bound hosts
([F12](F12-secrets-vault.md#the-credential-injecting-egress-proxy)).

### The `opensandbox` driver

An adapter over OpenSandbox's TypeScript SDK: `exec` and `files` map to its command and file APIs, and egress
maps to its per-sandbox allow/deny policy (deny private ranges and `core`; allow the internet). It runs as an
optional Compose profile (`opensandbox`), off by default. Its credential vault is not used: credentials stay
with F12's own proxy, so it reports `credentialSwap: false`. Notes: on Docker Desktop its sandboxes are plain
containers (Firecracker and Kata need Kubernetes or a Linux host); gVisor cannot be combined with its egress
rules.

### Session folders

```
/workspace/
├── shared/                  files any session may read
├── sessions/<sessionId>/    each task's working files and outputs
└── tools/                   forged tools (F20)
```

Folders organise work; they are not security boundaries (one sandbox per owner).

## Changes to existing code

| File | Change |
|------|--------|
| `adapters/tools/workspace.ts` (today's host tools) | Split: the tool definitions move to `application/sandbox/tools`, the host execution becomes the `host` driver |
| `composition/createShitsuji.ts` | Picks the driver from `sandbox.driver`, runs the egress probes, registers tools by capability |

## Acceptance criteria

- `workspace.exec("python3 -c 'print(1)'")` returns `1`; the command never runs on the host.
- A fork bomb or `sleep infinity &` is contained (PID limit) and cleaned up on Stop.
- The workspace has no route to Postgres or the `core` admin API (network test).
- `env` inside the workspace shows no model keys, only placeholders for the run's declared secrets.
- `curl` to a LAN address or to `core` fails; `pip install` works through the proxy.
- The `opensandbox` and `shitsuji` drivers both pass the conformance suite for every capability they claim,
  and switching `sandbox.driver` changes no tool name, schema or effect.
- A driver that claims `lanBlocked` while a probe gets through is refused at startup.

## Risks and open questions

- **Network egress.** The sandbox needs the internet (pip, git, APIs) but must not reach your LAN. With the
  `shitsuji` driver it sits only on the `sandbox` network and `egress-proxy` is its only way out; tools that
  ignore `HTTPS_PROXY` have no internet and need configuring. With `opensandbox`, its egress sidecar does the
  same job, and the startup probes check it.
- **OpenSandbox on Windows.** Its Docker mode should run under Docker Desktop, but this is unverified; the
  first step of the driver is a spike that runs the conformance suite against it.
- **Per-task sandboxes** give stronger isolation. `opensandbox` may offer them early (`lifecycle.perTask`);
  the `shitsuji` driver needs a restricted Docker-socket proxy first (see
  [02-target-architecture.md](../02-target-architecture.md#containers)).
