-- 0001: owners, threads, sessions, turns, messages, turn events, channel bindings.
-- Forward-only: never edit this file once committed; add a new migration instead.
-- IDs are text (UUIDs from the app, or fixed ids such as 'owner'). Every table carries owner_id
-- (05-open-questions P1), filled from the parent row where the app does not pass it.

CREATE TABLE owners (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  timezone      text NOT NULL,
  locale        text NOT NULL,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE threads (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES owners(id),
  status      text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL
);
-- One live thread per owner (F04: one conversation across all channels).
CREATE UNIQUE INDEX threads_one_active_per_owner ON threads (owner_id) WHERE status = 'active';

CREATE TABLE sessions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES owners(id),
  thread_id   text NOT NULL REFERENCES threads(id),
  kind        text NOT NULL CHECK (kind IN ('chat', 'task', 'helper', 'schedule', 'observer')),
  summary     text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX sessions_by_thread ON sessions (thread_id, created_at);

CREATE TABLE turns (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES owners(id),
  session_id      text NOT NULL REFERENCES sessions(id),
  source          text NOT NULL CHECK (source IN ('user', 'task', 'schedule', 'event', 'resume')),
  status          text NOT NULL
                  CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  parent_turn_id  text REFERENCES turns(id),
  start_after     timestamptz,
  reply_channel   text,
  error           text,
  created_at      timestamptz NOT NULL,
  started_at      timestamptz,
  ended_at        timestamptz
);
CREATE INDEX turns_by_status ON turns (status, created_at);
CREATE INDEX turns_by_session ON turns (session_id, created_at);

CREATE TABLE messages (
  seq           bigserial UNIQUE,           -- insertion order, for stable listing
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES owners(id),
  thread_id     text NOT NULL REFERENCES threads(id),
  session_id    text NOT NULL REFERENCES sessions(id),
  turn_id       text REFERENCES turns(id),
  role          text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  author        text NOT NULL CHECK (author IN ('owner', 'assistant', 'system')),
  content       jsonb NOT NULL,             -- ContentPart[]
  channel       text,
  external_ref  text,
  withdrawn     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL
);
CREATE INDEX messages_by_session ON messages (session_id, seq);

CREATE TABLE turn_events (
  id        bigserial PRIMARY KEY,
  owner_id  text NOT NULL REFERENCES owners(id),
  turn_id   text NOT NULL REFERENCES turns(id),
  kind      text NOT NULL,
  data      jsonb NOT NULL,                 -- redacted before it is written
  at        timestamptz NOT NULL
);
CREATE INDEX turn_events_by_turn ON turn_events (turn_id, id);

CREATE TABLE channel_bindings (
  channel           text NOT NULL,
  external_chat_id  text NOT NULL,
  owner_id          text NOT NULL REFERENCES owners(id),
  verified_at       timestamptz,
  PRIMARY KEY (channel, external_chat_id)
);
