# F22 — Observability, cost and evals

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 1 Reach and control (started), extended in every phase | 8 | M | F03, F04 | F15, F17, F21 |

## What it is

Four things that let you trust and afford an autonomous agent:

1. **A usage ledger:** one row per model request, with tokens, cost and the turn it belongs to.
2. **Limits:** a monthly limit, a background budget, and a spending check-in per task.
3. **An activity log with receipts:** every tool call and action, its target, the reason it was allowed, and
   the result.
4. **Health and evaluation:** structured logs, a health scanner, and a small test harness that runs real tasks
   against fake websites and apps.

## Inspiration

- **nod:** `model_usage` is the only cost ledger; each request has one usage ID; totals come only from those
  rows; a session pauses and asks when its spend since your last message passes a check-in amount ($5 by
  default); a monthly limit ($200) stops all but your own messages; background work has its own small
  allowance with **reservations before dispatch**, so parallel requests cannot overspend; unknown prices block
  automatic requests; Usage shows each action with the words that allowed it.
- **openfuse:** saved command receipts and action receipts.
- **OpenMausBot:** **Sentinel**, a model-free, out-of-process scanner that reads the databases and logs
  read-only, groups failures into issues and writes a report.
- **openbot:** a CI check that fails when instructions or tool definitions grow (context budget).
- **nod evals:** real errands in simulated apps and sites, scored on what actually changed.

## Design

### Usage ledger

```ts
interface UsageRecord {
  id: UsageId;              // unique per model request; repeats are ignored
  turnId?: TurnId; sessionId?: SessionId; taskId?: TaskId;
  purpose: ModelPurpose;    // chat, classify, trust, memory, summarize…
  model: ModelRef;
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
  cost?: Money;             // undefined when the price is unknown
  background: boolean;      // not started by an owner message
  at: Date;
}
```

Written by `MeteredModelProvider` ([F03](F03-model-providers.md)). Embeddings and speech go through the same
ledger.

### Budget service

```ts
class BudgetService {
  /** Reserve a conservative maximum before a request; replaced by the real cost after. */
  reserve(scope: BudgetScope, estimate: Money): Promise<Reservation | BudgetRefusal>;
  settle(reservation: Reservation, actual: Money): Promise<void>;
  checkIn(sessionId: SessionId): Promise<'continue' | 'ask_owner'>;
}
```

| Limit | Default (proposal) | Effect |
|-------|-------------------|--------|
| Monthly | configurable, e.g. $30 | Only your own messages and limit changes still run |
| Background allowance | e.g. $5 / month | Covers observer, watches, memory upkeep; refuses unknown prices |
| Task check-in | e.g. $1 since your last message | The task pauses and asks whether to continue |

DeepSeek is cheap, so defaults can be low; they are settings, not constants.

How a request is checked (S27):

- Before each model request, `BudgetService` reserves a conservative maximum: every character of the
  prompt and tool schemas at three characters per token, plus the output the request allows, priced
  from `models.catalog`.
- The store checks and inserts the hold atomically, under the owner's row lock, so parallel requests
  (and two cores) cannot overspend. The usage row replaces the hold when the request ends; a failed or
  stopped request releases it, and startup releases any hold left by a crash.
- Past the monthly limit, only owner-started requests run; background work is refused with the limit,
  the spend and the reason. Background work must also fit the background allowance, and is refused
  when the model's price is unknown. Owner-started work runs without a reservation in that case, so
  the monthly total is a lower bound (and the anonymous price is logged once).
- The period is the calendar month in UTC. Limits live in `budget.monthlyLimit`,
  `budget.backgroundAllowance` and `budget.checkIn` (S28), in `budget.currency`.

### The check-in

Before each model call, the turn compares what the session has spent since the owner's last message
with `budget.checkIn`. Past it, the turn ends `waiting` and asks on its channel: "This has cost 1.20
USD so far. Keep going?" The question is stored as Shitsuji's reply, so the owner's next message starts
a `resume` turn that sees both the question and the answer. The check runs before a model call, so
asking costs nothing, and a turn whose last call already produced the final answer is never paused.

### Activity log and receipts

`ReceiptMiddleware` ([F05](F05-tool-system.md)) writes `tool_start` and `tool_end` to `turn_events`: tool
name, redacted and shortened arguments, effect, target, session, outcome, duration and the trust basis
(the fixed policy now; the quoted owner words or a standing rule from F11). It sits outside trust, so a
refused call is a receipt too, marked `denied` with the reason. The receipt path takes a redactor (identity
until F12's vault exists), so arguments are masked before they are stored.

`GET /api/activity?since=&limit=` lists the owner's recent `tool_end` receipts, newest first. The TUI's
`/activity` shows the latest ten and `/usage` shows calls, tokens and the known cost from the ledger. The
web UI's Usage screen (F07) will list the same receipts with CSV export. Workspace commands will also keep
the exit code and the last 16 KB of redacted output (F08).

### Logs, metrics, traces

- Structured JSON logs from every container to stdout; Compose collects them.
- Optional OpenTelemetry export (traces per turn: model calls, tool calls) behind a config switch.
- Health endpoints: `core /health`, workspace and desktop daemons `/health`; Compose health checks use them.

### Health scanner

A scheduled job (inside `core`, model-free) that reads recent `turn_events`, failed turns, queue wait times
and spend, groups repeated failures by signature, and posts one weekly "health" note, or a nudge when
something is clearly broken (for example, every browser call failing for an hour).

### Evaluation harness

- `evals/` holds scenarios: a task prompt, fake services (a mock mailbox, a notification sink and fixture
  pages served in-process), and checks on the resulting state ("a notification exists", "nothing was sent").
- Runs against a chosen model binding; reports pass rate, cost, steps and unsafe actions.
- Used to compare DeepSeek against local models, and to gate risky changes such as self-modification
  ([F21](F21-self-modification.md)).
- A **context budget** test measures the system prompt and core tool schemas in tokens and fails when they
  grow beyond a set number.
- Offline, it replays recorded model replies, so `pnpm check` covers the harness with no network and no
  key. Live runs are on demand only.

S38 builds this: five scenarios (`plain-answer`, `workspace-file`, `notify-allowed`, `notify-asks`, and
F11's `injection` page), a runner that builds a fresh in-memory graph per scenario, and the mock world
wired to `test.mail`, `test.notify` and `web.fetch` (whose resolver pretends the fixture hosts are
public, so no socket opens). The report gives pass rate, steps, tokens and cost, unsafe actions (an
outside action that ran without the owner's words, an approval or a rule), and the context budget.
`pnpm eval --offline` replays the fixtures; `pnpm eval --model <ref>` runs a live binding.

## Acceptance criteria

- Every model request appears once in the ledger with tokens; cost appears when the price is known.
  *(S27/S29: `MeteredModelProvider` writes one row per call, including the trust judge's.)*
- A task that passes its check-in pauses and asks on the channel it came from. *(S28.)*
- The Usage screen shows each action with what allowed it. *(Waits for the web UI, F07; the TUI's
  `/activity` and `/usage` show the same data.)*
- `pnpm eval --model deepseek/deepseek-flash` runs at least five scenarios and prints a report. *(S38:
  `pnpm eval --offline` runs the five in `pnpm check`; the live binding uses the same command.)*

The live monthly-limit behaviour (background spending refused with the limit message) needs a background
turn, which arrives with F15/F16; until then it is covered by the budget tests. The phone/live check list
is in [10-live-checks.md](../10-live-checks.md).

## Risks and open questions

- Token prices change. Keep prices in configuration with a "last checked" date.
- Live-model evals cost money and are not deterministic; run them manually, keep CI on recorded fixtures.
