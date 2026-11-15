# F16 — Scheduler, routines and watches

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 4 Autonomy | 17 | M | F15 (and F09 for page watches) | F17 |

## What it is

Work that starts on its own:

- **Routines:** an instruction on a schedule ("every weekday at 8:00, summarise my inbox"), one-off reminders
  ("remind me Friday at 5"), or a trigger (a webhook call, an app event).
- **Watches:** cheap, code-first checks of a public page or feed for a change, a text appearing, or a price
  crossing a threshold, which wake the agent only when something happened.
- **Quiet runs:** a run with nothing to report says nothing.

The `Task` type already planned in today's `PROJECT_OVERVIEW.md` (section 3.5) becomes this feature.

## Inspiration

- **nod:** each schedule fire has its own session; a recurring schedule skips a fire while the previous one is
  still queued, running or waiting on you; a schedule run cannot create schedules; `watch` signals with
  fingerprints skip the model when nothing changed; projected monthly cost shown when a schedule is created.
- **openbot:** routines with schedule, webhook and local-script triggers; `routine_no_update` for quiet runs;
  failed-run reporting; a routine re-read before each occurrence so edits apply; missed occurrences become one
  run; signed webhooks with secret rotation.
- **openfuse:** recurring public-page checks for changes, text availability or USD price thresholds, with
  de-duplicated alerts and failure back-off.

## Design

### Records

```ts
interface Routine {
  id: RoutineId;
  instruction: string;                 // your words: the authority for its runs (F11)
  trigger:
    | { kind: 'cron'; expr: string; tz: string }
    | { kind: 'once'; at: Date }
    | { kind: 'webhook'; path: string; secretRef: SecretId; filter?: JsonFilter }
    | { kind: 'event'; source: string; filter?: JsonFilter };   // app events from F18
  status: 'active' | 'paused';
  quiet: boolean;                      // report only when there is news
  lastRun?: { at: Date; outcome: 'news' | 'quiet' | 'failed'; turnId: TurnId };
  createdBy: MessageId;                // the owner message that created it
}

interface Watch {
  id: WatchId;
  target: { url: string; selector?: string };
  condition:
    | { kind: 'changed' }
    | { kind: 'text_appears'; text: string }
    | { kind: 'price_below'; amount: Money };
  intervalMinutes: number;             // floor of 15 by default
  fingerprint?: string;                // hash of the last relevant content
  failures: number;                    // back-off
  onMatch: 'notify' | { routineId: RoutineId };
}
```

### Classes

| Class | Responsibility |
|-------|---------------|
| `Scheduler` | One pg-boss cron job per minute; finds due routines and watches; re-reads each before starting it |
| `RoutineRunner` | Creates a `schedule` turn in a fresh session with the routine's instruction; skips if the last run is still open |
| `WatchRunner` | Fetches the target with a plain HTTP client (or the browser for JS pages), extracts, hashes, compares — **no model** unless the condition matched |
| `WebhookReceiver` | Verifies the HMAC signature, applies the filter, starts a run with the payload as untrusted data |
| `QuietRunPolicy` | A run that calls `routine.no_update()` posts nothing and does not notify |
| `CostProjector` | Estimates monthly cost from recent runs and shows it when a routine is created or changed |

### Tools

| Tool | Effect |
|------|--------|
| `schedule.create`, `schedule.update`, `schedule.pause`, `schedule.delete` | `write_self` (trust-checked; your words must cover it) |
| `schedule.list` | `read` |
| `watch.create`, `watch.list`, `watch.delete` | `write_self` / `read` |
| `routine.no_update()` | ends a run quietly |
| `routine.report_failure({ reason })` | marks the run failed with a reason |

### Rules

- A run's authority is the routine's instruction plus your standing rules, nothing more
  ([F11](F11-trust-and-approvals.md)). Outside actions not covered by the instruction wait for you.
- Runs cannot create or change routines.
- Missed fires during downtime collapse into one run.
- Quiet hours ([F17](F17-proactivity.md)) delay notifications, not the runs themselves.

## Changes to existing code

`WebhookChannel` becomes `WebhookReceiver`: a trigger source, not a chat channel.

## Acceptance criteria

- "Every Monday at 9, send me the week's weather for Paris" creates a routine and shows its projected cost.
- A watch on a product page notifies once when the price drops below the threshold, not on every check.
- A webhook with a bad signature starts nothing.

## Risks and open questions

- JavaScript-heavy pages need the browser for watches, which is heavier. Use plain HTTP first; fall back to the
  browser per watch.
