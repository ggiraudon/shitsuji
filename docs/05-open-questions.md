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
| M1 | `deepseek/deepseek-v4.1-flash` for chat, task, summarize, trust and vision |
| P1 | One owner; every table still has `owner_id` |
| R1 | **F01 + F02 + F03 in one first pass** (structure, database, model providers), not F01 alone |
| R2 | Commit the docs and the rename in the existing `seahorse` repo, then clone it into WSL, keeping its history |
| R3 | A checklist in the repo (`docs/PROGRESS.md`), ticked in the commit that meets each criterion. Commit very often; the rule goes in `AGENTS.md` |

Still open: D2–D5, M2–M4, P2–P6. None of them blocks the first pass.

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
| D3 | Egress filtering for workspace and desktop (block LAN and `core`)? | Yes, from M3: the `egress-proxy` service is their only way out; it also swaps credential placeholders (F12) | F08, F09, F10, F12 |
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
