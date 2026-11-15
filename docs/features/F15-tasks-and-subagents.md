# F15 — Tasks and sub-agents

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 4 Autonomy | 16 | L | F02, F04, F22 | F16, F24 |

## What it is

A way to hand Shitsuji substantial work and keep chatting while it runs. The main chat acts as a
**coordinator**: quick requests are answered in chat; bigger jobs become **tasks**, each with its own session,
goal, completion condition, steps and result. Tasks run in parallel, ask you questions, wait for things, and
report back to the same conversation. Inside a turn, the agent can **delegate** to short-lived helper agents.

## Inspiration

- **nod:** a coordinator chat; the `tasks` table is the ledger (goal, completion condition, brief, steps,
  progress, result); task, session and turn are separate concepts; a task calls `finish` only after checking
  its completion condition; replies to a task's message go to that task; `delegate` runs parallel in-memory
  helpers whose answers return as untrusted tool results; helpers cannot message you or connect apps; a shared
  workspace with per-task folders.
- **OpenMausBot:** the **job runtime contract**: one `Assignment` record for any delegated work; a tree with
  `rootId`, `parentId`, `depth`; `mode` (`work`, `consult`, `notify`); `reply` (`resume`, `poll`, `none`);
  lifecycle `queued → running → waiting / needs_input → completed / failed / cancelled`; enqueue refuses work
  back to an ancestor; depth and budget limits; stall detection; one terminal outcome, reported once.
- **openfuse:** durable task plans, checkpoints after each step, SQL leases, pause / resume / cancel / retry.

## Design

### Records

```ts
interface Task {
  id: TaskId;
  threadId: ThreadId;
  sessionId: SessionId;          // the task's own session
  title: string;
  goal: string;
  doneWhen: string;              // completion condition the agent must check
  brief: string;                 // context from the coordinator
  steps: Array<{ text: string; status: 'pending' | 'active' | 'done' | 'skipped' }>;
  status: 'open' | 'waiting' | 'done' | 'failed' | 'stopped';
  origin: 'owner' | 'schedule' | 'observer';   // decides its authority in F11
  sourceMessageId?: MessageId;
  result?: { summary: string; files: FileRef[] };
  budget: { maxSpend?: Money; maxSteps?: number; deadline?: Date };
}

interface Delegation {                // a helper run inside a turn (OpenMausBot's Assignment idea)
  id: DelegationId;
  parentTurnId: TurnId;
  rootTurnId: TurnId;
  depth: number;                       // max 2 by default
  mode: 'work' | 'consult';            // consult = answer only, act on nothing
  brief: string;
  profile?: AgentProfileId;            // F24
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;                     // returned to the parent as untrusted data
}
```

### Classes

| Class | Responsibility |
|-------|---------------|
| `TaskService` | `start`, `update`, `finish`, `stop`, `list`; writes the task, its first message and its first turn in one transaction |
| `TaskRouter` | Routes owner replies: a reply to a task message → that task; otherwise the coordinator decides or asks |
| `DelegationService` | Runs helper sessions in parallel within a turn, enforces depth, budget, and "no work back to an ancestor" |
| `StallDetector` | Ends work after two continuations with no successful tool call, or the same error three times |
| `TaskLedgerInjectable` | Shows the coordinator up to N open and recent tasks |

### Tools

| Tool | For | Notes |
|------|-----|-------|
| `task.start({ title, goal, doneWhen, brief, steps })` | coordinator | Use for substantial, multi-step or waiting work |
| `task.update({ steps?, progress? })` | task session | |
| `task.ask({ question, choices? })` | task session | Turn → `waiting`; your reply resumes it |
| `task.finish({ summary, files })` | task session | Refused while an owner update is unread |
| `task.list`, `task.stop` | coordinator | |
| `delegate({ brief, mode, profile? , count? })` | any session | Helpers get their own browser context and output folder; their results come back as untrusted data |

### Helper restrictions

Helpers cannot message you, ask for approvals (a step that would ask is refused and reported to the parent),
connect apps, change memory, schedules or rules, or start tasks. This keeps authority with the parent turn.

### Long waits

A task can `task.wait_until({ at | condition })`: its turn ends `waiting`, and a scheduled resume
([F16](F16-scheduler-and-routines.md)) continues it later.

## Acceptance criteria

- "Plan a weekend in Lyon and compare three hotels" becomes a task; you can keep chatting meanwhile; the
  result arrives as a reply to the task's message with a file.
- Replying to a task's question continues that task, not the chat.
- A helper's attempt to send an email is refused.
- Stopping a task cancels its turns and helpers; others continue.

## Risks and open questions

- Parallel tasks share one desktop. Browser contexts are per session, but GUI computer use is one screen:
  serialise `computer.act` with a desktop lock, or run more desktops later.
- Cost can grow fast with parallel helpers. Budgets per task and the check-in ([F22](F22-observability-and-cost.md))
  are mandatory, not optional.
