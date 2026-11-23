# Desktop performance: findings and optimisations

Status: **parked**. We come back to desktop performance after the rest of the fifth pass. This file is the
working record: the measurements, what causes the slowness, what other projects do differently, and the
candidate fixes. Update it as fixes land or new runs are measured.

Related issues: #115 (S56 live run), #150 (empty summaries, fixed), #151 (desktop tool usability),
#153 (compaction cost), #154 (a tool ran during a takeover).

## The task we measure

"In the Calc window, put 42 in A1 and 7 in B1. Save the document. Send it to me and close Calc." The model is
`deepseek/deepseek-flash`, text only (no vision), so it works through `desktop.inspect` / `desktop.act` on
the accessibility tree.

Reference point: the same steps done by hand as one script (launch, fill, open Save As, close) take
**about 4.5 s**.

## Measurements

### Run 1: 2026-11-22, before S56's additions and before #150

5 min 29 s, 40 model calls, stopped by the step limit without saving.

- About 170 s went to summarize calls that returned empty text (#150).
- About 85 s went to chat calls (about 2 s each).
- About 77 s went to tools: a Calc-window inspect or act took 4–6 s, a dialog call 0.2–0.6 s.
- About 15 steps were wasted. The "Keep current format" dialog is named "Question" in AT-SPI, and the
  Save dialog ran off the 1440x900 screen.

### Run 2: 2026-11-23, S56 and #150 merged, 1920x1080

Session `b478d08e`. Three turns, 4 min 24 s in total. The owner had to take over to answer two popups
(overwrite, then keep format).

| Turn | Length | Summarize | Chat | Tools |
|---|---|---|---|---|
| 7bbe6ede: fill and save | 2 min 58 s | ~66 s (16 calls) | ~75 s (36 calls) | ~37 s |
| c869b03a: cancelled | 22 s | 22 s (3 calls) | none | none |
| 233e1f55: close and send | 1 min 04 s | ~48 s (7 calls) | ~11 s (9 calls) | ~5 s |

- **Summarising took about 136 s, half of all the time.** Summaries are no longer empty, and they use no
  reasoning, but compaction runs at almost every step (see below).
- **Chat calls are fine.** Most take 1–2 s. Input grew to 54k tokens by the end of turn 1, mostly from
  cache.
- **Calc-window tree reads take 3.6–4.1 s each.** There were nine in turn 1 (~34 s), counting the tree
  re-read after each act. Dialog reads take 0.2–0.5 s.
- **The save phase took 38 s and 15 model calls** before the owner stepped in. The agent never saw either
  popup:
  - After clicking Save, the act re-read the old "Save" window, not the new alert.
  - `desktop.inspect` with no window returned an unnamed `xfwm4` frame.
  - `find: { role: "dialog" }` found nothing, because the popups use the `alert` role.
  - `window: "soffice"` returned the main Calc frame, not the modal alert on top of it.

  Details are in the #151 comment.

## Why it is slow: root causes

1. **Every observation stays in the history forever.** Each desktop tree is about 10k characters. The
   session holds 37 `desktop.inspect` results, 352k characters in total. Every later model call resends them,
   and the summariser has to work through them.
2. **Compaction is triggered by message count, not tokens.** `historyLimit` is 40 (`Agent.ts`), and a
   desktop turn writes about 70 messages. No context window is configured for DeepSeek, so the message
   count is the only trigger. The context window is **not** too small.
3. **Compaction runs inside the step, before the model call.** It does up to 4 rounds of 24k characters per
   step until it catches up. Because the tree messages are large, a round covers only a few messages, and it
   took six steps to catch up.
4. **The summary bloats past its budget.** The prompt asks for at most 200 words, but the summary reached
   the 2048-token cap and was cut off mid-text, and each later fold builds on the cut text.
5. **Large-window tree reads are slow** (3.6–4.1 s for Calc), and every act re-reads the whole window.
6. **The agent cannot script the desktop.** `workspace.exec` does not get `DISPLAY`
   (`packages/sandbox-daemon/src/main.ts`, exec env), so every input is one model round trip.
7. **The agent can't find new dialogs**: wrong default window, role mismatch, and modal alerts hidden behind
   the app frame. So it guesses and loops.

## What other projects do (ideas only, no code taken)

- **openfuse** (`../inspiration/openfuse`, `apps/server/src/computer-tools.ts`):
  - It has a vision model, and each action returns a fresh screenshot. The screenshot is attached **for
    that step only**; the chat history keeps a short text receipt.
  - Its prompt says shell commands run with `DISPLAY` set, so GUI apps can be started and driven from a
    command.
  - It prefers keyboard shortcuts.
- **OpenMausBot** (`../inspiration/OpenMausBot`, `server/computer-*.ts`):
  - Its engines are coding agents (Claude Code, Codex, Cline), which write scripts by habit.
  - It drives the desktop through Cua Driver, which has element tokens from `get_window_state` and batch
    runners (`run_steps`, `run_script`). OpenMausBot hides the batch runners from the model on purpose, so
    each screen action gets its own approval.
  - It doesn't send the model a screenshot that is byte-identical to the previous one (`computer-observation.ts`).
- **kwin-mcp** (MIT, KDE/Wayland): durable refs re-validated on use, search by app across windows,
  present/absent waits, a report of what changed after an action, two-line errors with a remedy. Filed as
  #151.

The common pattern is **observe, act, forget the old observation**. Ours is observe, act, keep everything.

## Candidate optimisations

Ordered by expected impact. Fill in the status as work lands.

| # | Change | Expected effect | Status |
|---|---|---|---|
| 1 | **Keep only the latest tree in full.** Replace older `desktop.inspect` / `desktop.act` tree results in the history with a one-line stub ("snapshot s5 of Calc, superseded"). Same later for browser trees. | Removes most of the compaction work; smaller input on every call | Browser rule in S58 |
| 2 | **Compaction triggered by tokens, off the critical path.** Token or exchange trigger instead of a count of 40; compact after the turn or once at turn start with a time budget; summarise tool results as one short line; enforce the summary size (re-ask when cut, never store a cut summary); record summarize time in turn_events. | −66 s in turn 1, −48 s in turn 3 | #153 |
| 3 | **Desktop scripting from `workspace.exec`.** Give exec `DISPLAY` (plus the D-Bus/AT-SPI env), and a prompt line that it can use xdotool or a short Python AT-SPI script for a known sequence. For Calc data entry, consider driving LibreOffice directly. **Needs an owner decision on security:** the takeover pause must block exec too (#154), and scripted desktop input must pass the same trust check as `desktop.act`. | A Calc task in seconds, like the 4.5 s script | Not filed (needs a decision) |
| 4 | **Find new dialogs reliably.** The no-window default should pick the focused app window or dialog, not the xfwm4 frame; app search should include alert / file chooser roles; prefer an app's modal dialog. | Ends the popup loop | #151 (with t2) |
| 5 | **Report what changed after an act instead of re-reading the window.** List new and closed windows plus the focused element. | −3.6 s per act on Calc, fewer re-inspects | #151 item 3; browser rule in S58 |
| 6 | **Faster large-window reads.** Profile `a11y_helper.py` on the Calc frame (3.6 s): cache the frame subtree between reads, skip the sheet table unless asked, use cheaper state queries. | −2–3 s per Calc read | Not filed |
| 7 | **Batch input** (`desktop.act` `steps`, up to 20). | Fewer round trips for typing | Done in S56 |
| 8 | **A bigger screen and windows fitted to it** (1920x1080, fit-windows). | No off-screen buttons | Done in S56 |
| 9 | **A vision model for `computer.act`**, with screenshots kept for one step only (openfuse pattern), duplicate frames suppressed (OpenMausBot pattern), and scale mapping stated. | Option for apps without a usable tree | Designed for the browser in S58; desktop later |

The browser steps (S57–S61 in [12-fifth-pass-plan.md](12-fifth-pass-plan.md)) apply items 1, 5, 7 and 9 from
the start, because browser activity is expected to be the main use of the desktop: one live snapshot, actions
that report a diff, batches for forms, waits on page state, and one-step screenshots with element boxes.

Target for the next measured run: the Calc task finishes without help, in **under 60 s and under 15 model
calls**, with no summarize call on the critical path. For the browser, a simple lookup runs in **under 20 s
and under 8 model calls** with one snapshot body in the history (S61).

## How to measure a run

Use the live stack's Postgres (`docker exec shitsuji-postgres-1 psql -U shitsuji -d shitsuji`):

```sql
-- the turns
select id, started_at, ended_at, ended_at - started_at, status
from turns order by started_at desc limit 5;

-- model calls by purpose; "at" is when the call finished
select to_char(at, 'HH24:MI:SS.MS'), purpose, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens
from usage where turn_id = '<turn>' order by at;

-- tools: data->>'ms' on tool_end is the tool time
select to_char(at, 'HH24:MI:SS.MS'), kind, data->>'tool', data->>'ms', data->>'outcome'
from turn_events where turn_id = '<turn>' order by id;
```

A model call's duration is the gap between its `usage.at` and the previous tool end or usage row. A run of
`summarize` rows before a `chat` row is compaction on the critical path. Core logs "Compacted the
transcript" with the new `summaryCount`.

## Open questions

- Should desktop scripting (item 3) be allowed at all, and under which trust level?
- Is the accessibility tree the right default for LibreOffice, or should known apps get a direct path (UNO
  scripting, `soffice --convert-to`) and the tree only for unknown apps?
- Does a stronger chat model change the picture? DeepSeek Flash's 1–2 s per call is not the bottleneck
  today; the number of calls is.
