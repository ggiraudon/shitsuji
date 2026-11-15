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

### Activity log and receipts

`ReceiptMiddleware` ([F05](F05-tool-system.md)) writes `turn_events`: tool name, redacted arguments, effect,
target, trust basis (the quoted owner words or rule), outcome, duration. Workspace commands also keep the
exit code and the last 16 KB of redacted output. The web UI's Usage screen lists them and exports CSV.

### Logs, metrics, traces

- Structured JSON logs from every container to stdout; Compose collects them.
- Optional OpenTelemetry export (traces per turn: model calls, tool calls) behind a config switch.
- Health endpoints: `core /health`, workspace and desktop daemons `/health`; Compose health checks use them.

### Health scanner

A scheduled job (inside `core`, model-free) that reads recent `turn_events`, failed turns, queue wait times
and spend, groups repeated failures by signature, and posts one weekly "health" note, or a nudge when
something is clearly broken (for example, every browser call failing for an hour).

### Evaluation harness

- `evals/` holds scenarios: a task prompt, fake services (a mock mailbox, a local test website served from a
  container), and checks on the resulting state ("an email draft to Anna exists", "nothing was sent").
- Runs against a chosen model binding; reports pass rate, cost, steps and unsafe actions.
- Used to compare DeepSeek against local models, and to gate risky changes such as self-modification
  ([F21](F21-self-modification.md)).
- A **context budget** test measures the system prompt and core tool schemas in tokens and fails when they
  grow beyond a set number.

## Acceptance criteria

- Every model request appears once in the ledger with tokens; cost appears when the price is known.
- A task that passes its check-in pauses and asks on the channel it came from.
- The Usage screen shows each action with what allowed it.
- `pnpm eval --model deepseek/deepseek-flash` runs at least five scenarios and prints a report.

## Risks and open questions

- Token prices change. Keep prices in configuration with a "last checked" date.
- Live-model evals cost money and are not deterministic; run them manually, keep CI on recorded fixtures.
