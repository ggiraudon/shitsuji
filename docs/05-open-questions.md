# Open questions

Decisions to make together before implementation starts. Each has a proposal so we have a default.

## Decided (2026-11-14)

| # | Decision |
|---|----------|
| A1 | pnpm monorepo: `core`, `shared`, `web`, `workspace-daemon`, `desktop-daemon` |
| A2 | Our own agent loop, behind an `AgentEngine` port |
| A3 | Postgres only (with pgvector). Unit tests use in-memory repository fakes; integration tests use a real Postgres container. None of the reference projects uses an ORM: nod and openfuse use raw SQL on Postgres, openbot and OpenMausBot use `node:sqlite` |
| A4 | Kysely, with plain migration files |
| A5 | The TUI becomes a client of the core HTTP API, built **early**: it is the first working interface, used for troubleshooting before the web UI is ready |
| D1 | Develop on **Windows**, in the existing repo folder, with **Docker Desktop** (WSL2 backend; WSL integration also on for Debian). Mounting Windows folders into containers is slow and file watching is unreliable, so dev containers mount as little source as possible, keep `node_modules` and database data in named volumes, and run watchers inside the container. Compose files must still work on a plain Linux host: no Docker Desktop-only features such as `host.docker.internal`, and no Windows paths |
| M1 | DeepSeek V4.1 Flash for chat, task, summarize, trust and vision. Its API model name is `deepseek-flash` (checked against the API on 2026-11-15: it rejects `deepseek-v4.1-flash` and offers `deepseek-flash` and `deepseek-v4-pro`), so refs are `deepseek/deepseek-flash` |
| P1 | One owner; every table still has `owner_id` |
| R1 | **F01 + F02 + F03 in one first pass** (structure, database, model providers), not F01 alone |
| R2 | Commit the docs and the rename in the existing `seahorse` repo, then clone it into WSL, keeping its history |
| R3 | A checklist in the repo (`docs/PROGRESS.md`), ticked in the commit that meets each criterion. Commit very often; the rule goes in `AGENTS.md` |

### Second pass (decided 2026-11-15)

| # | Decision |
|---|----------|
| Q1 | Until F08, the file tools work only inside `<dataDir>/workspace` (no `../` or symlink escapes). The shell tool is **on by default**, runs one program without a shell interpreter, inside that folder, with a timeout and an output cap, and can be turned off in the config |
| Q2 | Web search through a self-hosted **SearXNG** container behind a `SearchProvider` port, plus `web.fetch`; the unofficial proxy is removed |
| Q3 | Owner key: random, created at first start, stored hashed, shown once and saved to a file only the owner can read; the TUI sends it as a Bearer token, the web UI will exchange it for a cookie |
| Q4 | Remove the stdin CLI channel once the TUI works |
| Q5 | Step limits per session kind: chat 40, task 200, helper 30, schedule 40, observer 20, configurable in `runtime.limits` |
| Q6 | The SOUL is **assembled and evolving**: fragments and numbered revisions in the database, which holds the real copy; `SOUL.md` is a readable export. Changes take effect between turns. Shitsuji may propose changes; the owner confirms them (needs F11) |
| Q7 | Injectables declare their **placement** (`header` = system prompt, `context` = in the history, `tail` = attached to the latest turn) and an ascending **order** (Identity -1, SOUL 0, tool index 1…). Anything that changes often goes in the tail, so prompt caching keeps working. A **mood** (F25) is planned for the tail |

### Third pass (decided 2026-11-15)

| # | Decision |
|---|----------|
| P2 | Spending limits in `budget.*`: **$30** a month, a **$5** background allowance, and a **$1** check-in per session since the owner's last message |
| P6 | **Auto-accept workspace changes**: `write_local` runs; `external` and `write_self` go to the judge, which may only allow with a verbatim quote of the owner's words; `payment` always asks |
| M3 | `deepseek/deepseek-flash` for `purpose: trust` (judging and reading typed approval replies). A cheaper classifier on OpenRouter waits until F17 needs it |
| D2 | No remote access needed for Telegram: the bot uses long polling, so no port is opened. Tailscale or a domain is decided with the web UI (F07) |
| T1 | Telegram through **grammY**, with long polling, inside `core` as a plugin adapter |
| T2 | Until F08, Telegram attachments go to `<dataDir>/handoff`, next to the workspace folder; the file tools may read it |

### Sandbox design (decided 2026-11-17)

| # | Decision |
|---|----------|
| W1 | **One `sandbox` service instead of separate `workspace` and `desktop` containers.** Both run untrusted work and hold no secrets, so splitting them protects nothing, while one container shares one filesystem (no handoff dance between a download and a script), one daemon, one egress path and one set of limits. The image is built in two layers: `shitsuji/sandbox` (shell, files, CLI tools: F08) and `shitsuji/sandbox-desktop` on top of it (X, XFCE, Chromium, LibreOffice, AT-SPI, noVNC: F10, F09). `core` never runs inside it. `egress-proxy` stays its own container, since it is trusted and talks to `core`. One `packages/sandbox-daemon` replaces the `workspace-daemon` and `desktop-daemon` packages planned in A1 |
| W2 | **Sandbox drivers behind a `SandboxDriver` port.** A driver is a plugin (`provides: ['sandbox']`), selected in config (`sandbox.driver`). It advertises its **capabilities** (exec, files, desktop, browser, lifecycle, egress); `core` registers tools only for the capabilities the active driver has |
| W3 | **Core owns the standard tools; drivers implement them.** Names, input schemas and effects of `workspace.*`, `desktop.*`, `computer.*` and `browser.*` are defined once in `core`, so trust rules, receipts, evals and the prompt do not depend on the driver. A driver may add extra tools, always namespaced by its id (`opensandbox.*`), through the same pipeline and trust checks. A driver can never change a standard tool's effect |
| W4 | **Safety capabilities are checked, not trusted.** A driver declares `egress.lanBlocked` and `egress.credentialSwap`. At startup `core` probes from inside the sandbox (a LAN address, `core` itself, Postgres) and refuses a driver whose claim does not hold. Without `lanBlocked` the sandbox gets no network; without `credentialSwap` it never receives a credential placeholder (F12) |
| W5 | **One conformance suite for every driver**, like the channel contract tests: each test runs when the driver claims the capability it covers, and a driver ships only when it passes everything it claims |
| W6 | **Order: a `host` driver first (today's tools, unchanged), then an `opensandbox` driver to test against early, then our own `shitsuji` driver** (sandboxd + egress-proxy), which becomes the default when it passes the suite. [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) (Apache-2.0, self-hosted) is used as a **running service through its TypeScript SDK**, not as copied code; it is optional and off by default. Our desktop layer (F10) is ours regardless, since accessibility-first desktop control is not something it offers |

D4 now reads "one long-lived sandbox": per-task sandboxes come later through the driver's `lifecycle.perTask`
capability (F15).

### Fourth pass (decided 2026-11-18)

| # | Decision |
|---|----------|
| X1 | The `core` ↔ `sandboxd` wire types live in a new workspace package, **`packages/sandbox-protocol`**, in this repo. `shitsuji-shared` stays the client contract; the protocol can be split out later if a client ever needs it |
| X2 | The startup egress probes always try `core`'s API and `postgres:5432`, plus the addresses in `sandbox.probes.lan`, which defaults to `[192.168.1.1]` (the owner's router) |
| X3 | Default driver: **`host` when running from source** (`pnpm dev`), **`shitsuji` in `compose.yaml`** from S49. A driver refused at startup leaves the sandbox tools off; there is **no fallback to `host`** |
| X4 | `workspace.send` is `external` (sending the owner a file). The shipped default `trust.rules` holds `{ tool: workspace.send, verdict: allow }`, so it runs without asking; the owner can remove the rule |
| X5 | **No copy:** the sandbox mounts the existing workspace folder of the `coredata` volume as `/workspace` (Compose `volume.subpath`), and `handoff` the same way in both containers. With the `shitsuji` driver, `core` never reads `/data/workspace` directly; every file operation goes through `sandboxd` |
| X6 | OpenSandbox gets one spike step (S43). If it does not run on Docker Desktop (WSL2), the findings go in F08 and its driver waits; the `shitsuji` driver does not depend on it |
| X7 | The sandbox's egress proxy is **open to any public address by default**. Private, loopback, link-local, CGNAT, multicast, unspecified and cloud-metadata (`169.254.169.254`, `fd00:ec2::254`) addresses are **always refused**, checked on the **resolved** address (IPv4, IPv6 and IPv4-mapped) and pinned for the connection, and the whole name is refused when any answer is blocked. Optional `sandbox.egress.allow`/`deny` lists take domains, `*.` wildcards and IPv4/IPv6 CIDR ranges; an allow range overlapping a blocked one is a config error, and the lists never open `core`. Refusals are logged with host, address and reason, never content. No SOCKS for now |

### Fifth pass (decided 2026-11-20)

| # | Decision |
|---|----------|
| Y1 | Before the web UI (F07), you watch the desktop on **one minimal viewer page** that `core` serves at `/desktop`: noVNC, watch-only until Take control, behind the owner key (exchanged for a short-lived viewer cookie, never put in a URL). F07 absorbs it later |
| Y2 | The viewer is on **this PC by default** (`127.0.0.1`). A config switch (`api.listen`, `SHITSUJI_API_BIND`) can publish it on the LAN, and **TLS is optional** (`api.tls.cert` / `api.tls.key`), so it can be used plain inside your network; binding beyond loopback without TLS only logs a warning. This does not decide D2 (remote access from outside) |
| Y3 | **Playwright runs inside `sandboxd`**, against a Chromium it launches with a CDP pipe. CDP never leaves the container and is out of the commands' reach; `core` stays off the sandbox network and uses browser endpoints on the token-protected API |
| Y4 | The desktop is **always on** in the fifth pass. Idle stop and start-on-demand come later |

Still open: D2 for the web UI, D3–D5, M2, M4, P3–P5.

## Architecture

| # | Question | Proposal | Affects |
|---|----------|----------|---------|
| A1 | Single package or a pnpm monorepo (`core`, `web`, `shared`, `workspace-daemon`, `desktop-daemon`)? | Monorepo from the start of Phase 1, since the web UI and container daemons need shared types | F01, F07, F08, F10 |
| A2 | Own agent loop or wrap an existing harness? | Own loop (BYOK and local models, OO design goal); keep an `AgentEngine` port open | F04 |
| A3 | Postgres only, or also a SQLite "lite" mode? | Postgres only; in-memory adapters for tests | F02 |
| A4 | Kysely or Drizzle for SQL? | Kysely (typed SQL, plain migrations) | F02 |
| A5 | Keep the Ink TUI? | Yes, as an optional client of the HTTP API; low priority | F01 |

## Deployment

| # | Question | Proposal | Affects |
|---|----------|----------|---------|
| D1 | Where will it run first: your PC (Docker Desktop on Windows) or a home server / VPS? | Develop on Docker Desktop; design for a Linux host | all containers |
| D2 | Remote access: none, Tailscale, or a public domain with HTTPS? | Tailscale first (no open ports); Caddy profile for a domain later | F06, F07 |
| D3 | Egress filtering for the sandbox (block LAN and `core`)? | Yes, from M3: the `egress-proxy` service is their only way out; it also swaps credential placeholders (F12) | F08, F09, F10, F12 |
| D5 | Credential proxy: own Node service or mitmproxy with an addon? | Own small Node service, intercepting TLS only for hosts with a credential binding | F12 |
| D4 | One desktop container, or start one on demand per task? | One long-lived desktop; idle stop; revisit later | F10, F15 |

## Models

| # | Question | Proposal | Affects |
|---|----------|----------|---------|
| M1 | Which DeepSeek models for chat and tasks? | DeepSeek V4.1 Flash for chat/tasks (confirm the exact API model ID); check whether a reasoning model is worth it for planning | F03 |
| M2 | Vision for computer use: is DeepSeek V4.1 Flash good enough at reading screenshots (small text, finding where to click)? | Use V4.1 Flash for `purpose: vision` (it accepts images); test it on desktop scenarios in the eval suite, and switch only that purpose if it falls short | F03, F10, F22 |
| M3 | Cheap classification model? | A small model on OpenRouter now; local Qwen-class model on Ollama later | F03, F17 |
| M4 | Embeddings: API or local? | Local `nomic-embed-text` on Ollama if the CPU allows, else an API | F13 |

## Product

| # | Question | Proposal | Affects |
|---|----------|----------|---------|
| P1 | One owner only? | Yes; every table keeps `owner_id` | F02, F04 |
| P2 | Default monthly spend limit? | $30, configurable | F22 |
| P3 | Email and calendar: IMAP/CalDAV or Google APIs first? Himalaya? | IMAP/CalDAV (provider-neutral, no OAuth app needed), with imapflow/nodemailer in `core`; Himalaya only as an optional backend run by `core`, never as a CLI in the agent's shell | F18 |
| P4 | Proactivity on by default? | Off; daily brief opt-in first | F17 |
| P5 | Learned skills active immediately or after review? | After review | F19 |
| P6 | Default approval level? | "Auto-accept workspace changes"; outside actions judged | F11 |

## Process

| # | Question | Proposal |
|---|----------|----------|
| R1 | Start with F01 as one focused refactor before any feature work? | Yes |
| R2 | Put Shitsuji under git now? | Yes, before F01, so every step is reviewable |
| R3 | How do we track progress against this plan? | Turn each feature's acceptance criteria into issues or a checklist |

