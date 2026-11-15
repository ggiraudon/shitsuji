# F02 — Persistence and durable jobs

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 0 Foundations | 2 | M | F01 | F04, F11, F13, F15, F16, F17, F22 |

## What it is

A PostgreSQL database behind repository interfaces, plus a durable job queue. Every message, turn, task,
approval, memory note and usage record is stored, so a restart or crash loses nothing that was acknowledged.
Replaces `SessionStore` (one JSON file per session).

## Inspiration

- **nod:** PostgreSQL with pg-boss. Creating a turn also queues a `thread-drain` job **in the same
  transaction**, so the worker wakes as soon as the turn commits. `withTurnLock` fences every write a turn
  makes: it only runs while the turn is still `running`.
- **openfuse:** durable tasks with checkpoints and **SQL leases**; interrupted work recovers; no hidden retry
  after an uncertain external write.
- **OpenMausBot:** every state change is one transaction that writes the row and an append-only event; a
  crash keeps what was accepted.

## Design

### Ports

```ts
export interface UnitOfWork {
  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface ThreadRepository { getOrCreateForOwner(ownerId: OwnerId, tx?: Transaction): Promise<Thread>; … }
export interface TurnRepository  { insert(turn: Turn, tx?): Promise<void>; transition(id, from, to, tx?): Promise<boolean>; … }
export interface MessageRepository { append(msg: StoredMessage, tx?): Promise<void>; search(q: HistoryQuery): Promise<Page<StoredMessage>>; }
// …one per aggregate: Task, Approval, MemoryNote, Skill, Schedule, UsageRecord, TurnEvent, Secret

export interface JobQueue {
  enqueue(name: JobName, payload: unknown, opts?: { startAfter?: Date; singletonKey?: string }, tx?: Transaction): Promise<JobId>;
  work(name: JobName, handler: JobHandler, opts?: { concurrency: number }): Promise<void>;
}
```

- `transition(id, from, to)` is a compare-and-set (`UPDATE … WHERE status = $from`), so two workers can never
  both start the same turn.
- Repositories accept an optional transaction so a service can write several aggregates atomically (for
  example: save a message, insert a turn, enqueue its job).

### `TurnLock` (unit of work for a running turn)

```ts
class TurnLock {
  /** Runs fn only if the turn is still running; otherwise throws TurnNoLongerActive. */
  async write<T>(turnId: TurnId, fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
```

Every write a turn's tools make (memory, schedules, task updates, approvals) goes through it. After Stop, a
slow tool cannot write late.

### Schema sketch

| Table | Key columns |
|-------|------------|
| `owners` | id, display_name, timezone, locale, settings jsonb |
| `threads` | id, owner_id, status (active/archived), created_at |
| `sessions` | id, thread_id, kind (chat/task/schedule/observer/helper), transcript jsonb, summary, created_at |
| `turns` | id, session_id, source (user/task/schedule/event/resume), status, parent_turn_id, start_after, reply_channel, error |
| `messages` | id, thread_id, session_id, turn_id, role, author (owner/assistant/system), content jsonb, channel, external_ref, withdrawn |
| `turn_events` | id, turn_id, kind (tool_start/tool_end/model_call/…), data jsonb (redacted), at |
| `tasks` | see [F15](F15-tasks-and-subagents.md) |
| `approvals` | see [F11](F11-trust-and-approvals.md) |
| `memory_notes`, `memory_archive` | see [F13](F13-long-term-memory.md) |
| `skills`, `skill_revisions` | see [F14](F14-skills.md), [F19](F19-learned-skills.md) |
| `schedules`, `watches` | see [F16](F16-scheduler-and-routines.md) |
| `usage` | see [F22](F22-observability-and-cost.md) |
| `secrets` | see [F12](F12-secrets-vault.md) |
| `mail_accounts`, `mail_envelopes`, `mail_sync_state`, `mail_sends` | see [F18](F18-integrations-mcp.md#email-connector) |
| `channel_bindings` | channel, external_chat_id, owner_id, verified_at |

Migrations are plain SQL files run at startup (Kysely migrator), versioned and **forward-only**: never edit a
shipped migration.

### Recovery at startup

1. Turns left `running` by a crash become `failed` with reason `interrupted`. They are **not retried**:
   a tool may already have acted outside. The next turn in that session is told what was interrupted.
2. Jobs whose lease expired are picked up again by pg-boss; handlers are idempotent by turn ID.

## Changes to existing code

| File | Change |
|------|--------|
| `memory/SessionStore.ts` | Removed; replaced by `SessionRepository` and `MessageRepository` |
| `memory/Memory.ts` | Removed; long-term memory is [F13](F13-long-term-memory.md) |
| `core/Session.ts` | No longer persists itself; repositories load and save it |

## Test strategy

- Repository tests against a real Postgres via Testcontainers.
- An `InMemoryRepositories` adapter for fast unit tests of application services.
- A crash test: kill the process mid-turn, restart, check the turn is `failed(interrupted)` and the session
  can continue.

## Acceptance criteria

- Restarting `core` keeps all threads, messages and queued turns.
- A turn can be started by only one worker at a time (proved by a concurrency test).
- `docker compose up` creates the schema from migrations.

## Risks and open questions

- **SQLite mode.** A single-container "lite" mode with SQLite would be easy behind the same ports, but
  pg-boss and pgvector need Postgres. Proposal: Postgres only for now; keep the in-memory adapter for tests.
- **Backups.** One `pg_dump` job on a schedule, written to a host folder. Decide retention.
