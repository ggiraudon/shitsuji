-- 0003: the SOUL, assembled from ordered fragments into numbered revisions (Q6, S23).
-- Forward-only: never edit this file once committed; add a new migration instead.

CREATE TABLE soul_fragments (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES owners(id),
  kind         text NOT NULL CHECK (kind IN ('base', 'trait', 'session')),
  session_kind text CHECK (session_kind IN ('chat', 'task', 'helper', 'schedule', 'observer')),
  body         text NOT NULL,
  position     integer NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  -- A session fragment names its session kind; the others must not.
  CHECK ((kind = 'session') = (session_kind IS NOT NULL))
);
CREATE INDEX soul_fragments_by_owner ON soul_fragments (owner_id, position);

CREATE TABLE soul_revisions (
  owner_id   text NOT NULL REFERENCES owners(id),
  revision   integer NOT NULL,
  body       text NOT NULL,
  source     text NOT NULL CHECK (source IN ('initial', 'owner', 'assistant')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, revision)
);

-- Each turn records the SOUL revision it ran with; a new revision waits for the next turn.
ALTER TABLE turns ADD COLUMN soul_revision integer;
