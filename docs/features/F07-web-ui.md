# F07 — Web UI

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 1 Reach and control | 7 | L | F04, F06 | the UI parts of F10, F11, F13, F15, F22 |

## What it is

The main place to use and supervise Shitsuji from a browser: chat with live progress, tasks, approvals, the
agent's desktop with **Take control**, memory and skills, schedules, settings and usage. It is also a
`ChannelAdapter` (`web`), so it shares the thread with Telegram.

## Inspiration

- **nod:** the composer never blocks; text the model writes between tool calls shows as live status, not as
  messages; tasks show as compact cards that expand into steps and activity; approvals are cards whose buttons
  answer one approval by ID; the browser hand-off shows the live tab in chat; file previews are sandboxed
  (`srcdoc` iframe, no same-origin, no-network CSP); every local API request needs an owner key.
- **openfuse:** rich inline result cards (email, browser, PDF, plan); a follow-up queue; drafts kept on Stop;
  **Take control** opens the same browser session.
- **OpenMausBot / openbot:** a Computer panel with a live screen preview; memory editor with a change journal.

## Design

### Architecture

- **Frontend:** React + Vite + TypeScript in `packages/web`, built into static files that `core` serves.
- **Transport:** REST for reads and commands, one WebSocket per client for live events.
- **Shared types:** `packages/shared` (the `shitsuji-shared` submodule) holds the API and event types used by both sides, so they cannot drift.
- **Auth:** a single-owner access key, printed at first start and exchanged for an HTTP-only cookie (nod's
  model). Later: passkeys. All routes are owner-scoped even with one owner.

### Live events

`core` subscribes to the `EventBus` and forwards a filtered, redacted stream to connected clients:

| Event | UI effect |
|-------|-----------|
| `turn.status` | Working indicator, Stop button |
| `turn.text_delta` | Streaming reply |
| `turn.activity` | Live status line ("Reading the invoice…") and activity list |
| `tool.started` / `tool.finished` | Activity entries; command output for workspace commands |
| `approval.requested` / `approval.resolved` | Approval card appears / closes on every client |
| `task.updated` | Task card progress |
| `desktop.frame` | Thumbnail of the agent's screen (low rate) |

### Screens

| Screen | Content |
|--------|---------|
| **Chat** | Thread messages, streaming, attachments, choice buttons, approval cards, task cards, result cards; composer with queue; Stop |
| **Computer** | Live desktop (noVNC canvas, view-only by default), **Take control** / **Give back**, terminal history of workspace commands, file browser of the workspace and `handoff` volume |
| **Tasks** | Open and finished tasks; steps, activity, cost; Stop / Resume |
| **Schedules** | Routines and watches; pause, edit, run now; last runs |
| **Memory** | Notes by area with source quotes; edit, confirm, forget; archive; change journal |
| **Skills** | Built-in and learned skills; revisions and diffs; enable / disable |
| **Tools** | Registered tools by source (built-in, MCP, forged); proposals waiting for review ([F20](F20-tool-forge.md)) |
| **Usage** | Spend by day, session and purpose; limits; every action with its receipt ([F22](F22-observability-and-cost.md)) |
| **Settings** | Models and keys (write-only fields), channels and pairing, rules, quiet hours, approval level |

### Result cards

The agent can attach a structured result to a message (`ResultCard` with `kind: 'file' | 'table' | 'plan' |
'comparison' | 'browser_snapshot' | 'email_draft'`). The web renderer shows a rich card; other channels get a
text summary plus a file. Generated HTML previews render only in a sandboxed `srcdoc` iframe.

## Changes to existing code

The Ink TUI stays as an optional terminal client. Its bootstrap is replaced by an HTTP client of `core`.

## Acceptance criteria

- Chat, Stop, approvals and task cards work and stay in sync with Telegram.
- Take control lets you click and type in the agent's desktop, and Give back resumes the agent.
- Secrets typed in settings never come back from the API (only "configured: yes").
- Every API route rejects requests without the owner key.

## Risks and open questions

- The UI is the largest single piece of work. Build it in slices: chat + approvals first (M2), then Computer
  (M3), then Memory and Skills (M4), then Tasks and Schedules (M5).
- Mobile: a responsive web UI plus Telegram covers phones for now; a PWA manifest is cheap to add.
