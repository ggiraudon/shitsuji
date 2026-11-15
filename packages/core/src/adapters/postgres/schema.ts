import type { ColumnType, Generated } from 'kysely';
import type { SoulFragment } from '../../domain/model/Soul.js';

/**
 * Kysely table types for migrations/0001_initial.sql. Kept by hand next to the SQL; the integration
 * test "matches the migrated schema" fails if a table or column here does not exist in the database.
 */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Json<T> = ColumnType<T, string, string>;

export interface OwnersTable {
  id: string;
  display_name: string;
  timezone: string;
  locale: string;
  settings: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Generated<Date>;
}

export interface ThreadsTable {
  id: string;
  owner_id: string;
  status: 'active' | 'archived';
  created_at: Timestamp;
}

export interface SessionsTable {
  id: string;
  owner_id: string;
  thread_id: string;
  kind: 'chat' | 'task' | 'helper' | 'schedule' | 'observer';
  summary: string | null;
  created_at: Timestamp;
}

export interface TurnsTable {
  id: string;
  owner_id: string;
  session_id: string;
  source: 'user' | 'task' | 'schedule' | 'event' | 'resume';
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  parent_turn_id: string | null;
  start_after: Timestamp | null;
  reply_channel: string | null;
  error: string | null;
  soul_revision: number | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
}

export interface MessagesTable {
  seq: Generated<string>; // bigserial comes back as a string from pg
  id: string;
  owner_id: string;
  thread_id: string;
  session_id: string;
  turn_id: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  author: 'owner' | 'assistant' | 'system';
  content: Json<unknown[]>;
  channel: string | null;
  external_ref: string | null;
  withdrawn: Generated<boolean>;
  created_at: Timestamp;
}

export interface TurnEventsTable {
  id: Generated<string>;
  owner_id: string;
  turn_id: string;
  kind: string;
  data: Json<Record<string, unknown>>;
  at: Timestamp;
}

export interface ChannelBindingsTable {
  channel: string;
  external_chat_id: string;
  owner_id: string;
  verified_at: Timestamp | null;
}

export interface UsageTable {
  id: Generated<string>;
  owner_id: string;
  turn_id: string | null;
  purpose: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  cost_micros: ColumnType<string | null, number | null, number | null>; // bigint comes back as a string
  currency: string | null;
  at: Timestamp;
}

export interface SoulFragmentsTable {
  id: string;
  owner_id: string;
  kind: 'base' | 'trait' | 'session';
  session_kind: 'chat' | 'task' | 'helper' | 'schedule' | 'observer' | null;
  body: string;
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SoulRevisionsTable {
  owner_id: string;
  revision: number;
  body: string;
  fragments: Json<SoulFragment[]>;
  source: 'initial' | 'owner' | 'assistant';
  created_at: Timestamp;
}

export interface Database {
  owners: OwnersTable;
  threads: ThreadsTable;
  sessions: SessionsTable;
  turns: TurnsTable;
  messages: MessagesTable;
  turn_events: TurnEventsTable;
  channel_bindings: ChannelBindingsTable;
  usage: UsageTable;
  soul_fragments: SoulFragmentsTable;
  soul_revisions: SoulRevisionsTable;
}
