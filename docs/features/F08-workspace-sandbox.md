# F08 — Workspace sandbox container

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 2 Own computer | 10 | M | F05, F11 | F20, F21 |

## What it is

A hardened Linux container where the agent runs commands, writes code and handles files: Python, Node, git,
ffmpeg, pandoc, LibreOffice (headless), poppler, tesseract, jq, ripgrep, sqlite. A small **workspace daemon**
inside it supervises every command. `core` talks to the daemon over the internal network. This replaces
today's shell and file tools, which run on the host with no real limits.

## Inspiration

- **nod:** commands run as an unprivileged user; no host environment; a **command supervisor** owns each
  command's process session and kills the whole tree on Stop (escalating to `SIGKILL`), including detached
  children; timeouts; output capped at 1 MiB with head and tail kept and the full log saved; a lost
  acknowledgement fences the workspace until restart; provider keys never enter the container; installed tools
  persist in a separate home volume.
- **openfuse:** a `ComputerSession` with `exec`, file operations and `stop`; nonroot, no host mounts; command
  receipts; no fallback to running on the API host if Docker is unavailable.

## Design

### Container

```yaml
workspace:
  build: ./containers/workspace
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
    - workspace-data:/workspace        # project files, per session folders
    - workspace-home:/home/agent       # pip/npm installs persist
    - handoff:/handoff                 # shared with desktop and core
  networks: [sandbox]                # internet only through egress-proxy (F12)
  environment:
    WORKSPACE_TOKEN: ${WORKSPACE_TOKEN}  # only secret: authenticates core to the daemon
```

### Workspace daemon (inside the container)

A small Node (or Go) HTTP service on the `sandbox` network:

| Endpoint | Purpose |
|----------|---------|
| `POST /exec` | Start a command: `{ cmd, cwd, env, timeoutMs, stdin? }` → stream of stdout/stderr chunks, then exit code |
| `POST /exec/:id/signal` | Stop a command: kill its whole process group, then `SIGKILL` after a grace period |
| `POST /files/read`, `/files/write`, `/files/list`, `/files/stat`, `/files/move` | File API confined to `/workspace` and `/handoff` (paths resolved, symlinks checked) |
| `GET /health` | For Compose health checks |

The supervisor starts each command in its own process session (`setsid`), tracks every descendant, enforces
the timeout and an output cap, and confirms when the command ends.

### Port and adapter in `core`

```ts
export interface WorkspaceBackend {
  exec(req: ExecRequest, signal: AbortSignal): AsyncIterable<ExecEvent>;
  files: WorkspaceFiles;
  health(): Promise<HealthStatus>;
}
```

`DockerWorkspaceBackend` speaks HTTP to the daemon. A future `RemoteVmWorkspaceBackend` or
`E2BWorkspaceBackend` can implement the same port.

### Tools

| Tool | Effect | Notes |
|------|--------|-------|
| `workspace.exec` | `write_local` | Default timeout 10 min, max 60; output head+tail to the model, full log to a file |
| `workspace.read` / `write` / `edit` / `list` / `find` | `read` / `write_local` | Edits by exact string replacement, like coding agents |
| `workspace.send_file` | `external` (to you) | Delivers a workspace file through the gateway |

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
| `tools/implementations/ExecuteCommandTool.ts` | Removed; replaced by `workspace.exec` |
| `tools/implementations/FileSystemTool.ts` | Removed; replaced by `workspace.*` file tools |

## Acceptance criteria

- `workspace.exec("python3 -c 'print(1)'")` returns `1`; the command never runs on the host.
- A fork bomb or `sleep infinity &` is contained (PID limit) and cleaned up on Stop.
- The workspace has no route to Postgres or the `core` admin API (network test).
- `env` inside the workspace shows no model keys, only placeholders for the run's declared secrets.
- `curl` to a LAN address or to `core` fails; `pip install` works through the proxy.

## Risks and open questions

- **Network egress.** The workspace needs the internet (pip, git, APIs) but should not reach your LAN. It sits
  only on the `sandbox` network; the `egress-proxy` service ([F12](F12-secrets-vault.md#the-credential-injecting-egress-proxy))
  is its only way out, blocks private ranges and `core`, and swaps placeholders for real credentials on bound
  hosts. Tools that ignore `HTTPS_PROXY` have no internet and need configuring.
- **Per-task containers** would give stronger isolation but need Docker-socket access; postponed (see
  [02-target-architecture.md](../02-target-architecture.md#containers)).
