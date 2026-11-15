# Inspiration survey

Four projects in `../inspiration/`. We studied their READMEs, architecture docs, Compose files and module
layout. This page records what each one does well and which ideas are worth borrowing. **We copy no code**;
each feature file says which idea it borrows.

## At a glance

| | **nod** | **openbot** | **openfuse** | **OpenMausBot** |
|---|---|---|---|---|
| Shape | One personal agent, one conversation per owner | A team of "teammate" agents in a desktop app | A personal agent app with an agent computer and rich result cards | A team of bots in a chat app, each with its own computer |
| Agent engine | Pi agent runtime, any model provider | Wraps coding CLIs (Codex, Claude Code, Gemini, OpenCode, ACP agents…) | CopilotKit / AG-UI with OpenAI, Anthropic, Google | Wraps coding CLIs (Claude, Codex, Grok, ACP) |
| Deployment | One Node process + Docker containers (Postgres, workspace, browser) | Electron app, or a headless Docker server | Hono API + task worker + browser worker; optional Docker Linux computer or E2B desktop | Electron app, or a Docker server behind Caddy |
| Agent's computer | Locked-down Linux **workspace** container + separate headed **Chromium** container | Embedded browser + optional Computer Use (`cua-driver`) on the host | Persistent Chromium worker + optional Linux container; E2B desktop VM with VNC | Cloud Linux desktop, local VM, a Cua container on your own VPS, or the host (opt-in) |
| Channels | Web, desktop, Telegram, WhatsApp | Desktop, web, iPhone, Telegram, Slack, Discord, Signal | Expo app on iOS, Android, web | Desktop, phone, web |
| Memory | One structured memory document; facts only from the owner's own words; tentative → confirmed; archive | `remember` / `search_memories` / `forget_memory` tools | Editable personal memories | Plain Markdown files (`MEMORY.md`, topic files, daily log) with a change journal and undo |
| Skills | 27 built-in task guides (Agent Skills format) + **learned skills** the agent writes | Agent Skills folders per workspace, marketplace | — | Skills with saved revisions; **bots draft skills**; optional background skill review |
| Safety | Server-side **trust check** on every action; approvals bound to exact arguments; untrusted-content wrapping; Vault | Full access by default (trusts the user) | Stored action review before every send or calendar change | Approval levels per bot; permission broker; approval cards |
| Proactivity | Observer over connected apps, matters, nudges, quiet hours, preparation budget | Routines (schedule, webhook, script), quiet runs | Goals, page watches, ideas with evidence | "Keep an eye on my day" routine, daily brief |
| Durable work | Threads → sessions → turns in Postgres + pg-boss, task ledger, sub-agents | Message queues, routines, workflows canvas | Durable tasks with SQL leases and checkpoints | Job runtime: assignment tree, budgets, stall detection |
| Cost control | One usage ledger, monthly limit, per-task check-in | Usage reports | — | Usage meter |
| Licence | Apache-2.0 | PolyForm Noncommercial 1.0.0 | MIT | Apache-2.0 (with CLA) |

## nod

The most complete design for a **safe, proactive single assistant**, and the closest match to what Shitsuji
wants to be. Its docs (`docs/src/content/docs/how-it-works/*`) are worth reading in full.

Ideas worth borrowing:

- **Ports and providers.** Capabilities are interfaces in `src/ports`; vendor code sits in `src/providers`;
  one `composition.ts` picks the implementations; a script enforces import directions. This is exactly the
  object-oriented structure Shitsuji needs. → [F01](features/F01-core-architecture.md)
- **Thread → session → turn.** One conversation per owner across all channels. Each piece of work is a
  turn row; each session runs one turn at a time; sessions run in parallel; turns are never retried
  automatically; Stop cancels at once. → [F04](features/F04-agent-runtime.md), [F15](features/F15-tasks-and-subagents.md)
- **Containers as the computer.** A workspace container (no capabilities, unprivileged user, a command
  supervisor that kills whole process trees) and a separate browser container (headed Chromium on a virtual
  display, accessibility snapshots, live JPEG frames for hand-off). Provider keys never enter either. →
  [F08](features/F08-workspace-sandbox.md), [F09](features/F09-browser.md)
- **Policy in the server, not the prompt.** One trust checker sees the owner's words and the exact action, and
  must quote the words that allow it; otherwise it asks. Approvals are bound to exact arguments and run once.
  → [F11](features/F11-trust-and-approvals.md)
- **Untrusted by default.** Web, app and browser results reach the model wrapped as data, not instructions. →
  [F11](features/F11-trust-and-approvals.md)
- **Memory only from the owner's own words**, with provenance quotes, tentative vs confirmed notes, and
  archive instead of delete. → [F13](features/F13-long-term-memory.md)
- **Progressive skill disclosure** and **learned skills** treated as untrusted data. →
  [F14](features/F14-skills.md), [F19](features/F19-learned-skills.md)
- **Proactivity engine** that reads change signals cheaply in code, uses a small model to skip routine
  changes, and only nudges on concrete needs, with quiet hours and a budget. →
  [F17](features/F17-proactivity.md)
- **One cost ledger** with a monthly limit and a per-task spending check-in. →
  [F22](features/F22-observability-and-cost.md)

## openbot

A desktop workspace for **many persistent agents** built on existing coding CLIs.

Ideas worth borrowing:

- **Deferred tool discovery.** A small set of direct tools plus `tool_search`, `tool_describe` and
  `tool_call`, so the prompt does not carry every schema. Important for small or local models. →
  [F05](features/F05-tool-system.md)
- **Agents that configure themselves and each other:** `create_agent`, `update_profile`, adding MCP servers
  with an approval. A practical, safe form of self-evolution. → [04-self-evolution.md](04-self-evolution.md)
- **Routines with several triggers** (schedule, webhook, local script) and **quiet runs** that report
  nothing when there is no news. → [F16](features/F16-scheduler-and-routines.md)
- **Routine flows and workflows:** one agent's routine result handed to other agents; a graph of steps with
  conditions and approvals. → [F16](features/F16-scheduler-and-routines.md) (later phase)
- **Browser take-over** (`request_takeover`) when a sign-in page blocks the agent. → [F09](features/F09-browser.md)
- **Context budget checks** in CI that fail when instructions or tool definitions grow. →
  [F22](features/F22-observability-and-cost.md)

Note: openbot runs agents with full access and no approvals by design. We do not copy that default.

## openfuse

An alpha **agent-computer app** with strong interface ideas.

Ideas worth borrowing:

- **`ComputerBackend` interface** with two implementations: a Docker Linux container and an E2B desktop VM
  with a VNC stream. The cleanest example of a swappable computer. → [F10](features/F10-desktop.md)
- **Durable tasks with checkpoints and SQL leases**, so interrupted work recovers, and no hidden retry after an
  uncertain external write. → [F02](features/F02-persistence.md), [F15](features/F15-tasks-and-subagents.md)
- **Receipts** for every command and action. → [F22](features/F22-observability-and-cost.md)
- **Goals and page watches** (change, text availability, price threshold) with de-duplicated alerts and
  back-off. → [F16](features/F16-scheduler-and-routines.md)
- **Rich result cards** in chat (email, browser, PDF, plan) and **Take control** of the same browser
  session. → [F07](features/F07-web-ui.md)
- A **managed registry for generated tools** is on its roadmap (not built). →
  [F20](features/F20-tool-forge.md)

## OpenMausBot

A **team of bots in a chat app**, each with its own model, computer and apps.

Ideas worth borrowing:

- **Memory as plain Markdown files** the user can open and edit, a journal of changes with undo, and a daily
  log the bot writes. → [F13](features/F13-long-term-memory.md)
- **`SOUL.md` standing instructions** per bot. → [F04](features/F04-agent-runtime.md)
- **Skill authoring and background skill review** behind feature flags. → [F19](features/F19-learned-skills.md)
- **Per-bot Linux desktop container** (Cua) with live preview and noVNC **Take control** bound to localhost.
  → [F10](features/F10-desktop.md)
- **Accessibility elements before pixels** when driving your own Mac (`cua-driver`), and replays that find
  targets by app, window title and accessibility label. Its Linux desktop is screenshot-only; we bring the
  same idea to Linux with AT-SPI. → [F10](features/F10-desktop.md#reading-the-screen-structure-first-pixels-last)
- **Job runtime contract:** one `Assignment` record for every piece of delegated work, a tree with depth and
  budgets, explicit lifecycle (`queued → running → waiting / needs_input → completed / failed / cancelled`),
  stall detection ("two continuations without a successful tool call"). → [F15](features/F15-tasks-and-subagents.md)
- **Approval levels** per agent (Ask, Auto-accept edits, Approve for me, Full access). →
  [F11](features/F11-trust-and-approvals.md)
- **Fast decision model** for cheap routing choices. → [F03](features/F03-model-providers.md)
- **Sentinel:** an out-of-process health scanner over the databases and logs. →
  [F22](features/F22-observability-and-cost.md)
- **Voice:** text-to-speech of replies and calls, with a "spoken register" that drops code and paths. →
  [F23](features/F23-voice.md)

## Does anyone let the agent change its own code?

No. None of the four lets the agent edit its own source code. The closest they come:

| Project | Self-change it allows |
|---|---|
| nod | Writes **learned skills** (procedures) after a task; they load as untrusted data and never grant permission. |
| openbot | Agents create other agents, edit their own profile and model, add MCP servers (with approval), and write skill folders in their workspace. |
| OpenMausBot | Bots **draft skills for review**; an optional background job reviews long conversations and updates learned skills. Skills keep every revision. |
| openfuse | A "managed registry for generated tools" is on the roadmap only. |

The four projects stop at prompts, skills and configuration, which suggests where the safe line is today. See
[04-self-evolution.md](04-self-evolution.md) for a staged plan that goes further with safeguards.

## Licences

We borrow ideas only. Still, note that **openbot is PolyForm Noncommercial**: do not copy its code, text or
assets even by accident. nod and OpenMausBot are Apache-2.0 and openfuse is MIT, which would allow reuse
with attribution, but the decision is to write our own implementation.
