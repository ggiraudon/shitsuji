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

**What S45 builds.** Our own sandbox: `docker/sandbox` (Debian bookworm on a pinned Node image, Python,
Node, git, ffmpeg, pandoc, poppler, tesseract, jq, ripgrep, sqlite, user 1000 `agent`), the wire contract
in `packages/sandbox-protocol` (X1), and `packages/sandbox-daemon` (`sandboxd`) with `GET /health`,
`GET /capabilities` and the files routes. Every route but health needs `SANDBOX_TOKEN`, compared in
constant time, and the daemon refuses to start without it. The routes take the model's **relative** path
and the daemon resolves it in the same request as the I/O: `..`, absolute paths and links that leave
`/workspace` or `/handoff` are refused on the resolved path, so a symlink planted in the workspace cannot
reach a host file (tested). `/handoff` is read-only to the sandbox; files leaving go through core's
staging. Exec followed in S46, and the image joins `compose.yaml` in S48; CI builds it and runs the
health, token, round-trip and symlink checks against the real image.

**What S47 builds.** `packages/egress-proxy` and `docker/egress-proxy` are the sandbox's only way out
(X7): HTTP `CONNECT` and plain HTTP, resolving the host **once**, checking every answer and connecting
to the exact address it checked, so DNS rebinding cannot swap it. Private, loopback, link-local, CGNAT,
multicast, unspecified and cloud-metadata addresses (`169.254.169.254`, `fd00:ec2::254`) are always
refused, including IPv4-mapped forms; the default is otherwise open. Optional `sandbox.egress.allow` and
`deny` lists take domains, `*.` wildcards and IPv4/IPv6 CIDRs, matched on the name or the resolved
address; an allow range overlapping a blocked range is refused at startup, and `core` is never reachable.
Refusals are logged with host, address and reason only. Compose puts it on an internal `sandbox` network
(the service it serves arrives in S48), hardened like the sandbox. SOCKS is not needed for pip, npm, git
over HTTPS or curl; it can be added later if a tool insists on it.

**What S46 builds.** `POST /exec` streams NDJSON — a start frame, stdout and stderr chunks, then one exit
frame with `timedOut` and `truncated` — and `POST /exec/:id/signal` stops a command (TERM, then KILL after
a grace). Each child gets its own process session (`setsid`), so a stop or a timeout kills the whole tree,
including `sleep infinity &`; the timeout and an output cap are enforced in the daemon as well as by the
tool. Commands start from a fixed, explicit environment (`PATH`, `HOME`, `LANG`, `USER`, `TERM`, `TMPDIR`)
and never inherit the daemon's, so nothing the daemon holds is in `env`.

**The token is not in the environment, and commands are not the daemon's uid.** `/proc/<pid>/environ`
keeps the startup environment, so deleting `SANDBOX_TOKEN` from `process.env` does not remove it, and a
same-uid command could read either the environment or a file. So the image runs commands as uid 1000
(`agent`) and sandboxd as uid 1001 (`sandboxd`), with the token in `/run/sandbox/token` (0400, owned by
1001). A root entrypoint writes or takes the token, owns it to 1001, fixes the workspace modes (2770,
owned by 1000, group-writable so the daemon's files API works) and starts the daemon with only `SETUID`,
`SETGID`, `SETPCAP` and `KILL`. A command therefore cannot read the token file, the daemon's
`/proc/<pid>/environ`, or the token in `env` — the container test checks all three.

**A command gets no capabilities.** `spawn(..., { uid })` only calls `setuid`, and a non-root to non-root
change does not clear the capability sets, so the daemon's ambient `SETUID`/`SETGID`/`KILL` would survive
into the command (it could `setpriv --reuid=0 id`). Every command is therefore launched through
`setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all
--no-new-privs -- <argv>`, in its own session, with the same clean environment. The container test runs
`grep Cap /proc/self/status` (every set zero) and `setpriv --reuid=0 id` / `--reuid=1001 true` (both
refused).

The container needs `init: true`: without an init the daemon is PID 1 and never reaps a fork bomb's
orphans, which leaves the PID limit exhausted; with it, the bomb is contained and the sandbox answers
again.

**For S48.** Compose drops every capability, so `sandbox` needs `cap_add: [CHOWN, FOWNER, SETUID, SETGID,
SETPCAP, KILL]` and nothing else: `CHOWN` for the token file and workspace ownership, `FOWNER` for the
`chmod` that repairs core-created files, `SETUID`/`SETGID` to start the daemon as 1001 and commands as
1000, `SETPCAP` to set the daemon's ambient set and empty each command's bounding set, and `KILL` to stop
a command that runs as another uid. The CI job runs the image with exactly this set plus
`no-new-privileges`; if it starts there, it starts in Compose.

**What S42 builds.** One conformance suite, `test/contracts/sandbox.contract.ts`, runs against every
driver: each test runs only for a capability the driver claims (exec, files, network), and the fork bomb
only when it contains processes. The `host` driver runs it in unit tests with containment and network
skipped. `EgressProbe` checks the egress claims from inside the sandbox — `sandbox.probes.lan` (default
`[192.168.1.1]`, X2), core's API and Postgres — at startup and on `health()`: a `lanBlocked` claim that an
address contradicts is refused with `SandboxUnavailable` naming it, and so is a claim that cannot be
probed at all. A driver making no claim (the host) may have network, says so in the log, and is refused
only when `sandbox.probes.requireIsolation` is on; nothing falls back to another driver (X3). A driver's
extra tools must be named `<driverId>.*`, so none can shadow a standard tool.

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
  # No `user:`: the entrypoint starts as root, prepares the token file and workspace, then runs
  # sandboxd as uid 1001; commands run as 1000 (S46).
  init: true
  cap_drop: [ALL]
  cap_add: [CHOWN, FOWNER, SETUID, SETGID, SETPCAP, KILL]
  security_opt: [no-new-privileges:true]
  read_only: true
  tmpfs: ["/tmp:size=1g", "/run/sandbox:size=1m"]
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
      read_only: true
    - type: volume                   # the token core generated (S48); read-only
      source: coredata
      target: /etc/sandbox-token
      volume: { subpath: sandbox.token }
      read_only: true
    - sandbox-home:/home/agent       # pip/npm installs, later browser profiles
  networks: [sandbox]                # internet only through egress-proxy
  environment:
    SANDBOX_EGRESS_PROXY: http://egress-proxy:3128  # HTTP(S)_PROXY for commands (S48)
```

Core is **not** on the `sandbox` network (S48): a small `sandboxd-gateway` relay, on `internal` and
`sandbox` only, forwards core's control port to sandboxd. Without it the sandbox could dial core's
admin API on the shared bridge, and the `lanBlocked` probe would rightly refuse the driver; Docker
networks have no per-port isolation.

**What S48 builds.** `packages/core/src/adapters/sandbox/shitsuji` is an HTTP client for sandboxd
that validates every reply with `sandbox-protocol`; it reports `lanBlocked: true` and
`credentialSwap: false`. Compose adds `sandbox`, `sandboxd-gateway` and `egress-proxy`, plus a
one-shot `sandbox-files` that seeds `workspace`, `handoff`, an empty `sandbox.token` and a closed
`"ready": false` rules file in the volume, because Compose resolves file subpaths when it creates a
container. Core generates the token on first start in `<dataDir>/sandbox.token` (32 random bytes);
the sandbox mounts it read-only at `/etc/sandbox-token`, and the root entrypoint installs it in
`/run/sandbox/token` (0400, uid 1001). Since root runs with `cap_drop: ALL`, it has no
`DAC_OVERRIDE`: it opens the 0700 folder while it copies the token, then closes it before sandboxd
starts, so a command cannot traverse to it. `sandbox.egress.allow/deny` is written to
`<dataDir>/sandbox.egress.json`, which the proxy mounts and polls; the proxy denies everything
until core marks the file ready. Commands get `HTTP_PROXY`/`HTTPS_PROXY` and the lowercase forms
from `SANDBOX_EGRESS_PROXY`, with `NO_PROXY` covering only loopback. `pnpm test:integration` builds
the sandbox and proxy images and runs the conformance suite and the egress probes against them.

**sandboxd**, a small TypeScript daemon in `packages/sandbox-daemon`, sharing types with `core` through
`packages/sandbox-protocol` (X1), listening only on the `sandbox` network:

| Endpoint | Purpose |
|----------|---------|
| `POST /exec` | Start a command: `{ argv, cwd, env, timeoutMs, stdin? }` → stream of stdout/stderr chunks, then the exit code |
| `POST /exec/:id/signal` | Stop a command: kill its whole process group, then `SIGKILL` after a grace period |
| `POST /files/read`, `/files/write`, `/files/list`, `/files/stat`, `/files/move`, `/files/mkdir` | File API confined to `/workspace` and `/handoff` (paths resolved, symlinks checked) |
| `POST /probe` | Whether an address answers a TCP connection from inside the sandbox (S42 probes) |
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
- **OpenSandbox on Windows** runs (the S43 spike answers it below). It needs the Docker socket; the
  findings and the go/no-go for S44 are in the next subsection.
- **Per-task sandboxes** give stronger isolation. `opensandbox` may offer them early (`lifecycle.perTask`);
  the `shitsuji` driver needs a restricted Docker-socket proxy first (see
  [02-target-architecture.md](../02-target-architecture.md#containers)).

### S43 spike: OpenSandbox on Docker Desktop (2026-11-18)

Run with the opt-in Compose profile (`docker compose --profile opensandbox`), server
`opensandbox/server:release-1.1.0` (digest `sha256:68ca02…`), execd `v1.1.0`, egress `v1.1.7`, Docker
Desktop on WSL2 (kernel `6.18.58.1-microsoft-standard-WSL2`). Under its own project name, so nothing
else ran differently.

- **Does the server start?** Yes, on Docker Desktop/WSL2; `/health` answers and it creates sandboxes.
- **Can it create a sandbox and run Python?** Yes. `python:3.12-slim`, `entrypoint` required,
  `resourceLimits` required without a pool; `python3 -c 'print(1)'` returns `1` (about 1 s per exec).
- **Start time.** First create 13.6 s (it pulls the sandbox, execd and egress images); afterwards 2.1 s
  without an egress policy and 3.7–3.9 s with one. The server uses ~140 MB of RAM idle; the three images
  are ~1 GB together.
- **Isolation here.** Plain `runc` containers (the daemon offers only runc and nvidia; no gVisor or
  Kata), not privileged, no host binds, the configured capability drop, `no-new-privileges:true`,
  `pids_limit 512`, on the default bridge — but **root inside**, on the shared WSL2 kernel. No user
  namespace remapping and no microVM: a kernel bug is the boundary, so it is a container, not a VM.
- **Egress.** Without a `networkPolicy` there is **no egress control at all**: the sandbox reached
  `192.168.1.1:80` and a helper container on the same bridge. With `{defaultAction: "deny", egress: []}`
  the LAN address, a `10.x` address, the helper container and even DNS were blocked. With deny plus
  allow rules for `pypi.org`, `files.pythonhosted.org` and `example.com`, HTTPS to those answered `200`
  and `pip install requests` worked while the LAN stayed blocked. This needs `[egress] mode = "dns+nft"`
  (the example's plain `dns` only inspects DNS, not IPs).
- **A setup trap.** When the server is itself in a container, the egress sidecar readiness probe uses
  `[docker].host_ip` to reach the sandbox's host-mapped port. Left unset it probes the server's own
  loopback, and every policy sandbox fails with "Egress sidecar did not become ready within 30s".
  Setting `host_ip` and `publish_host` to the default bridge gateway (`172.17.0.1`) fixed it.
- **Client reachability.** Sandbox ports are host-mapped; a client that cannot route to the sandbox's
  bridge IP (anything on the Windows host) needs the SDK's `use_server_proxy=True`, and the server-side
  proxy is deprecated upstream (maintenance mode). That is the main integration risk for S44.
- **What the server needs from its host.** Outbound internet to pull images, a writable state directory
  (SQLite), a host port range for sandbox ports, and — the important one — **the Docker socket**, mounted
  read-write. The server container is not privileged, but the socket is **root on the host** (the Linux VM
  under Docker Desktop, the real host on Linux): through it anything can be started, host paths mounted,
  and every container reached. It must be fenced before it runs anywhere but a development machine — a
  socket proxy limited to the endpoints this server uses, or a dedicated Docker daemon/context — and never
  given to the production `shitsuji` stack.

**Go/no-go for S44: GO, with conditions.** The API, sandboxes, exec, files and egress enforcement all
work on Docker Desktop, which is what S44 needs to test real isolation early. Conditions: the `opensandbox`
driver requires a containerised server to set `host_ip`/`publish_host` and `dns+nft`; it must prove how it
reaches sandbox endpoints with the deprecated server proxy (or another route) in its conformance run; and
the socket stays fenced as above, with the `shitsuji` driver (S48) still the only production default. If
the owner judges the deprecated proxy too risky, S44 waits (X6).
