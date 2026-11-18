# Fourth pass plan: F08 sandbox drivers

> **Status:** planned; decisions X1–X6 taken on 2026-11-18.

The fourth pass starts Phase 2 ("its own computer"). Today `workspace.exec` and the file tools run inside
`core`'s own container, next to the model keys, the vault and the database password. This pass moves them
into a sandbox, behind the driver port decided in W1–W6 ([05-open-questions.md](05-open-questions.md)):

- a `SandboxDriver` port, with the standard tools owned by `core` and registered by capability;
- the `host` driver (today's behaviour), so the port lands with no visible change;
- one conformance suite and the startup egress probes, which every driver must pass;
- an `opensandbox` driver, to test real isolation early against a self-hosted
  [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox);
- our own `shitsuji` driver: the `sandbox` container with `sandboxd`, and `egress-proxy`. It becomes the
  default in Compose once it passes the suite.

The order follows W6: each driver is a working state, so the pass can stop after any of them. As before, each
step is a GitHub issue under F08, every commit passes `pnpm check`, and [PROGRESS.md](PROGRESS.md) is ticked in
the commit that makes a criterion true.

**Done when**, with `sandbox.driver: shitsuji` in Compose:
- `workspace.exec("python3 -c 'print(1)'")` returns `1`, and the command ran in `sandbox`, not in `core`;
- `env` in the sandbox shows no model key, token or password;
- `curl` to your router, to `core` and to `postgres` fails; `pip install requests` works through the proxy;
- a fork bomb is contained, and `/stop` during `sleep infinity &` leaves no process behind;
- the conformance suite passes for `host`, `shitsuji` and (if the spike works) `opensandbox`, and switching
  drivers changes no tool name, schema or effect;
- a driver that claims `lanBlocked` while a probe gets through is refused at startup, with a clear error.

**Not in this pass:**
- The desktop layer and the browser ([F10](features/F10-desktop.md), [F09](features/F09-browser.md)). The
  image is built so `shitsuji/sandbox-desktop` can sit on top of it later.
- Credential swapping in `egress-proxy` ([F12](features/F12-secrets-vault.md)). Every driver reports
  `credentialSwap: false`; the proxy only blocks and tunnels.
- One sandbox per task (`lifecycle.perTask`, F15). There is one long-lived sandbox per owner.
- The web UI (F07).

## Decisions

Decided on 2026-11-18 and recorded in
[05-open-questions.md](05-open-questions.md#fourth-pass-decided-2026-11-18).

| # | Question | Decision |
|---|----------|----------|
| X1 | Where do the `core` ↔ `sandboxd` wire types live? | **`packages/sandbox-protocol`**, in this repo; `shitsuji-shared` stays the client contract. It can be split out later if a client needs it |
| X2 | What does `core` probe as "your LAN"? | `sandbox.probes.lan`, default `[192.168.1.1]`, plus `core`'s API and `postgres:5432`, always |
| X3 | Default driver | **`host` from source** (`pnpm dev`), **`shitsuji` in `compose.yaml`** from S49. A refused driver leaves the sandbox tools off: **no fallback to `host`** |
| X4 | `workspace.send`'s effect | **`external`**, with a shipped default rule `{ tool: workspace.send, verdict: allow }`, so it runs without asking |
| X5 | Existing workspace files | **No copy:** the sandbox mounts the `workspace` folder of the existing `coredata` volume (Compose `volume.subpath`), and `handoff` is mounted the same way in both containers. With the `shitsuji` driver, `core` reaches the workspace only through `sandboxd` |
| X6 | If OpenSandbox won't run | One spike step (S43); if it fails on Docker Desktop, the findings go in F08 and S44 waits. The `shitsuji` driver doesn't depend on it |

## Target additions

```
packages/
├── core/src/
│   ├── ports/        SandboxDriver, Sandbox, SandboxCapabilities, ExecCapability, FileCapability
│   ├── application/  sandbox/ (SandboxService, tool definitions, EgressProbe, OutputCap)
│   ├── adapters/     sandbox/host, sandbox/opensandbox, sandbox/shitsuji (HTTP client for sandboxd)
│   └── plugins/      sandbox drivers (provides: ['sandbox'])
├── sandbox-protocol/ zod schemas for sandboxd's requests, stream chunks and errors (X1)
├── sandbox-daemon/   sandboxd: files API, exec supervisor, health and capabilities
└── egress-proxy/     HTTP CONNECT + plain HTTP proxy that blocks private ranges
docker/
├── sandbox/          Dockerfile for shitsuji/sandbox (Debian + tools + sandboxd)
└── egress-proxy/     Dockerfile for shitsuji/egress
test/contracts/       sandbox.contract.ts (W5)
```

## Steps

Before S40, t2 fixes [#68](https://github.com/ggiraudon/shitsuji/issues/68) (a `/stop` shown as an error).

### The port (no visible change)

#### S40. The `SandboxDriver` port and the `host` driver
- The port and capability types from [F08](features/F08-workspace-sandbox.md#the-driver-port).
  `SandboxService` opens the driver's sandbox at startup and closes it on shutdown.
- The tool definitions move from `adapters/tools/workspace.ts` to `application/sandbox/tools` (`git mv`);
  the host execution becomes `adapters/sandbox/host`. Tools are registered only for the capabilities the
  driver reports.
- Config: `sandbox.driver` (`host` | `opensandbox` | `shitsuji`), default `host` (X3). Q1's `tools.exec.enabled`
  keeps working.
- *Check:* every existing workspace test passes unchanged; a fake driver without `exec` gets no
  `workspace.exec` tool.

#### S41. The standard tools, complete
- `workspace.edit` (exact string replacement, refuses an ambiguous match) and `workspace.find` (glob and
  text search inside the roots).
- `workspace.exec`: default timeout 10 min, max 60, capped by the driver's `maxTimeoutMs`; output over
  1 MiB keeps head and tail for the model and saves the full log in the session folder.
- `workspace.send` becomes `external`, and the shipped default `trust.rules` gets
  `{ tool: workspace.send, verdict: allow }` (X4), so it still runs without asking. F11's tests, the example
  config and the eval scenarios follow.
- Session folders: `shared/`, `sessions/<sessionId>/`, `tools/`.
- *Check:* unit tests on the `host` driver; the output cap test.

#### S42. The conformance suite and the egress probes
- `test/contracts/sandbox.contract.ts`: each test runs only when the driver claims the capability
  ([list in F08](features/F08-workspace-sandbox.md#conformance-suite)). The `host` driver runs it in unit
  tests (fork bomb and network tests skipped: it claims neither).
- `EgressProbe`: runs `sandbox.probes.lan` (default `[192.168.1.1]`, X2), `core` and `postgres` from inside the sandbox at startup and on
  `health()`. A failing `lanBlocked` claim refuses the driver; without `lanBlocked` the driver must report
  no network, or it is refused.
- *Check:* a fake driver that lies about `lanBlocked` is refused with a clear error; the `host` driver passes
  the suite.

### OpenSandbox (early isolation)

#### S43. OpenSandbox spike
- An `opensandbox` Compose profile running its server, off by default. Find out on Docker Desktop: does it
  start sandboxes, do its egress rules hold (private ranges, `core`), how long does a sandbox take to start,
  and does it need anything Linux-only.
- *Check:* findings written in F08's risks section, with the exact image versions; decision whether S44 goes
  ahead (X6).

#### S44. The `opensandbox` driver
- An adapter over its TypeScript SDK: `exec` and `files` map to its APIs; egress maps to a per-sandbox policy
  that denies private ranges and `core`. It reports `credentialSwap: false`.
- *Check:* the conformance suite passes in an integration test against the profile (skipped when it isn't
  running), including the egress probes.

### Our own sandbox

#### S45. The `sandbox` image and `sandboxd` files API
- `docker/sandbox`: Debian slim with Python, Node, git, ffmpeg, pandoc, poppler, tesseract, jq, ripgrep,
  sqlite, and `sandboxd`, running as user 1000.
- `packages/sandbox-protocol` (X1) and `packages/sandbox-daemon` with `GET /health`, `GET /capabilities` and
  the files endpoints, confined to `/workspace` and `/handoff` (paths resolved, symlinks checked). A shared
  token in `SANDBOX_TOKEN` authenticates `core`.
- *Check:* unit tests for path confinement (`..`, symlinks, absolute paths); the image builds in CI.

#### S46. The exec supervisor
- `POST /exec` streams stdout and stderr chunks as NDJSON, then the exit code. Each command gets its own
  process session (`setsid`); `POST /exec/:id/signal` kills the whole group, then `SIGKILL` after a grace
  period; the timeout and output cap are enforced in the daemon too.
- *Check:* tests in the container: `sleep infinity &` is gone after a stop; a fork bomb hits the PID limit
  and is cleaned up; the timeout kills.

#### S47. `egress-proxy`
- A small Node proxy: HTTP `CONNECT` for HTTPS and plain HTTP forwarding. It resolves the host itself and
  refuses private, loopback, link-local and CGNAT addresses and `core`, checking the **resolved** address so
  DNS tricks don't get through. No TLS interception yet (F12).
- Compose: a `sandbox` network marked `internal: true`; `egress-proxy` on `sandbox` and `egress`.
- *Check:* unit tests on the address checks (IPv4 and IPv6, including IPv4-mapped addresses); an
  integration test that `pip install` works and a LAN address fails.

#### S48. The `shitsuji` driver
- `adapters/sandbox/shitsuji`: an HTTP client for `sandboxd` that validates every reply with
  `sandbox-protocol`. It reports `lanBlocked: true` and `credentialSwap: false`.
- `compose.yaml` adds `sandbox` (with the hardening from F08) and `egress-proxy`. The sandbox mounts the
  `workspace` and `handoff` folders of the existing `coredata` volume (`volume.subpath`, X5) and its own
  `sandbox-home` volume. With this driver, `core` never reads `/data/workspace` itself, so a symlink the
  sandbox plants can't make `core` read its own files.
- *Check:* the conformance suite and the egress probes pass against real containers in
  `pnpm test:integration`.

#### S49. Switch the default, live check and docs
- `compose.yaml` sets `sandbox.driver: shitsuji` (X3); existing workspace files are already in place (X5).
  The `core` image stops shipping the command-line tools the sandbox now has.
- Live check through Compose, from Telegram: the **Done when** list above.
- Update the README, AGENTS.md, the class map, F08 and PROGRESS.
- *Check:* every F08 criterion is ticked, except the credential placeholders (F12).

## Things you'll need to provide

| When | What |
|------|------|
| Before S40 | Answers to X1–X6 (done) |
| S43 | Nothing to sign up for (OpenSandbox is self-hosted), but Docker Desktop may need more memory: the sandbox alone gets 4 GB |
| S49 | About ten minutes with your phone for the live check |
