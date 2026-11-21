import type { ColumnType, Generated } from 'kysely';
import type { SoulFragment } from '../../domain/model/Soul.js';

/**
 * Kysely table types for migrations/0001_initial.sql. Kept by hand next to the SQL; the integration
 * test "matches the migrated schema" fails if a table or column here does not exist in the database.
 */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Json<T> = ColumnType<T, string, string>;

/** The single owner profile; `settings` is a JSON bag for future preferences. */
export interface OwnersTable {
  /** The fixed owner id (`owner`). */
  id: string;
  /** The name the assistant uses when it speaks about the owner. */
  display_name: string;
  /** IANA zone, e.g. `Europe/Paris`. */
  timezone: string;
  /** BCP 47 language tag, e.g. `fr-FR`. */
  locale: string;
  /** Free-form settings as JSON; stored as text, read back as an object. */
  settings: ColumnType<Record<string, unknown>, string | undefined, string>;
  /** When the row was seeded. */
  created_at: Generated<Date>;
}

/** The owner's one conversation, across every channel. */
export interface ThreadsTable {
  /** The thread's id. */
  id: string;
  /** The owner who owns the thread. */
  owner_id: string;
  /** `active` while sessions may start in it; `archived` afterwards. */
  status: 'active' | 'archived';
  /** When it was created. */
  created_at: Timestamp;
}

/** One line of work inside a thread; a session runs one turn at a time. */
export interface SessionsTable {
  /** The session's id. */
  id: string;
  /** The owner the session belongs to. */
  owner_id: string;
  /** The thread that owns it. */
  thread_id: string;
  /** What the session is for; decides the step limit and the SOUL fragments. */
  kind: 'chat' | 'task' | 'helper' | 'schedule' | 'observer';
  /** The compaction summary of older messages, when there is one. */
  summary: string | null;
  /** How many of the oldest messages that summary covers. */
  summary_count: Generated<number>;
  /** When it was created. */
  created_at: Timestamp;
}

/** One run of the agent in a session; every state change is a compare-and-set. */
export interface TurnsTable {
  /** The turn's id. */
  id: string;
  /** The owner the turn belongs to. */
  owner_id: string;
  /** The session the turn runs in. */
  session_id: string;
  /** What started it. */
  source: 'user' | 'task' | 'schedule' | 'event' | 'resume';
  /** Where it is in the state machine. */
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  /** Reserved: the turn that caused this one; nothing sets it yet. */
  parent_turn_id: string | null;
  /** Do not start before this time; null means now. */
  start_after: Timestamp | null;
  /** Where the reply goes, e.g. `telegram:12345`. */
  reply_channel: string | null;
  /** Why it failed or was cancelled. */
  error: string | null;
  /** The SOUL revision the turn ran with. */
  soul_revision: number | null;
  /** When it was queued. */
  created_at: Timestamp;
  /** When a worker moved it to `running`. */
  started_at: Timestamp | null;
  /** When it reached a terminal status. */
  ended_at: Timestamp | null;
}

/** The transcript; rows are appended and only ever withdrawn. */
export interface MessagesTable {
  /** Insertion order, for a stable listing; a bigserial, which pg returns as a string. */
  seq: Generated<string>;
  /** The message's id. */
  id: string;
  /** The owner the message belongs to. */
  owner_id: string;
  /** The thread it belongs to. */
  thread_id: string;
  /** The session whose transcript it is. */
  session_id: string;
  /** The turn that produced it. */
  turn_id: string | null;
  /** What the model sees. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Who wrote it. */
  author: 'owner' | 'assistant' | 'system';
  /** The `ContentPart[]`, as jsonb. */
  content: Json<unknown[]>;
  /** The channel it came in on or went out through. */
  channel: string | null;
  /** The channel's own id for it. */
  external_ref: string | null;
  /** Set by a Stop; a withdrawn message no longer feeds the model. */
  withdrawn: Generated<boolean>;
  /** When it was appended. */
  created_at: Timestamp;
}

/** The append-only per-turn event log behind receipts and the activity view. */
export interface TurnEventsTable {
  /** The row's id. */
  id: Generated<string>;
  /** The owner the event belongs to. */
  owner_id: string;
  /** The turn the event belongs to. */
  turn_id: string;
  /** What kind of step it records, e.g. `model_call` or `tool_end`. */
  kind: string;
  /** The redacted payload, as jsonb. */
  data: Json<Record<string, unknown>>;
  /** When it happened. */
  at: Timestamp;
}

/** One chat on one channel, bound to the owner. */
export interface ChannelBindingsTable {
  /** The adapter the chat lives on, e.g. `telegram`. */
  channel: string;
  /** The channel's own conversation id. */
  external_chat_id: string;
  /** The owner the chat was paired with. */
  owner_id: string;
  /** When pairing succeeded; null for a binding that has not proven the owner's code. */
  verified_at: Timestamp | null;
  /** The session this chat talks to after `/new`; null means the main chat. */
  session_id: string | null;
}

/** The ledger of model spending: one row per completed request. */
export interface UsageTable {
  /** The row's id. */
  id: Generated<string>;
  /** The owner the spend belongs to. */
  owner_id: string;
  /** The turn that made the request, when there was one. */
  turn_id: string | null;
  /** The session the request was made for, when there was one. */
  session_id: string | null;
  /** The routing purpose, e.g. `chat` or `trust`. */
  purpose: string | null;
  /** The provider id, e.g. `deepseek`. */
  provider: string;
  /** The model id within that provider. */
  model: string;
  /** Prompt tokens, cached ones included. */
  input_tokens: number;
  /** Generated tokens, reasoning included. */
  output_tokens: number;
  /** Prompt tokens served from the provider's cache. */
  cached_input_tokens: number | null;
  /** Reasoning tokens inside `output_tokens`. */
  reasoning_tokens: number | null;
  /** True when no owner message started the work. */
  background: Generated<boolean>;
  /** The cost in micro-units; a bigint, which pg returns as a string. */
  cost_micros: ColumnType<string | null, number | null, number | null>;
  /** The currency of `cost_micros`. */
  currency: string | null;
  /** When the request completed. */
  at: Timestamp;
}

/** The SOUL's editable fragments; the set is replaced together on every publish. */
export interface SoulFragmentsTable {
  /** The fragment's id. */
  id: string;
  /** The owner whose SOUL it is. */
  owner_id: string;
  /** Whether it is shared (`base`, `trait`) or limited to one session kind. */
  kind: 'base' | 'trait' | 'session';
  /** For `session` fragments, the kind that sees it. */
  session_kind: 'chat' | 'task' | 'helper' | 'schedule' | 'observer' | null;
  /** The fragment's text. */
  body: string;
  /** Ascending within the assembled SOUL. */
  position: number;
  /** When it was first stored. */
  created_at: Timestamp;
  /** When it was last replaced. */
  updated_at: Timestamp;
}

/** One published state of the SOUL, with the fragments it was assembled from. */
export interface SoulRevisionsTable {
  /** The owner whose SOUL it is. */
  owner_id: string;
  /** The revision number, starting at 1. */
  revision: number;
  /** The assembled shared text. */
  body: string;
  /** The fragments at publish time, as jsonb. */
  fragments: Json<SoulFragment[]>;
  /** Who published it. */
  source: 'initial' | 'owner' | 'assistant';
  /** When it was published. */
  created_at: Timestamp;
}

/** Budget holds: a conservative maximum until the request settles or is released. */
export interface BudgetReservationsTable {
  /** The hold's id, chosen by the caller. */
  id: string;
  /** The owner whose month it counts against. */
  owner_id: string;
  /** The held amount in micro-units; a bigint, which pg returns as a string. */
  amount_micros: ColumnType<string, number, number>;
  /** The currency of `amount_micros`. */
  currency: string;
  /** True when the hold covers background work. */
  background: boolean;
  /** The session that made the request. */
  session_id: string | null;
  /** The turn that made the request. */
  turn_id: string | null;
  /** `held` until the request settles, is released, or dies with the process. */
  state: 'held' | 'settled' | 'released';
  /** When the hold was placed. */
  created_at: Timestamp;
  /** When it settled or was released. */
  ended_at: Timestamp | null;
}

/** Approval cards; `action_hash` is what binds one to one exact action. */
export interface ApprovalsTable {
  /** The card's id. */
  id: string;
  /** The owner who must answer. */
  owner_id: string;
  /** The turn that is blocked on the answer. */
  turn_id: string;
  /** The session whose new message supersedes the card. */
  session_id: string;
  /** The tool the action calls. */
  tool: string;
  /** The action's effect, as a string. */
  effect: string;
  /** Where the action runs. */
  target: string;
  /** SHA-256 of the exact action. */
  action_hash: string;
  /** The redacted argument preview, as jsonb. */
  arguments: Json<Record<string, unknown>>;
  /** One line the owner reads before deciding. */
  summary: string;
  /** Why the policy or the judge asked. */
  reason: string | null;
  /** Where the card is in its state machine. */
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'executed' | 'uncertain';
  /** When the card was stored. */
  created_at: Timestamp;
  /** When the owner approved or declined it. */
  decided_at: Timestamp | null;
  /** When it expired, ran, or became uncertain. */
  ended_at: Timestamp | null;
}

/** The whole migrated schema, as Kysely sees it. */
export interface Database {
  /** The single owner row. */
  owners: OwnersTable;
  /** The owner's threads. */
  threads: ThreadsTable;
  /** Sessions of those threads. */
  sessions: SessionsTable;
  /** Turns and their compare-and-set status. */
  turns: TurnsTable;
  /** The transcript. */
  messages: MessagesTable;
  /** The per-turn event log. */
  turn_events: TurnEventsTable;
  /** Chat → owner/session bindings. */
  channel_bindings: ChannelBindingsTable;
  /** The spending ledger. */
  usage: UsageTable;
  /** The SOUL's editable fragments. */
  soul_fragments: SoulFragmentsTable;
  /** Published SOUL revisions. */
  soul_revisions: SoulRevisionsTable;
  /** Budget holds. */
  budget_reservations: BudgetReservationsTable;
  /** Approval cards. */
  approvals: ApprovalsTable;
}
