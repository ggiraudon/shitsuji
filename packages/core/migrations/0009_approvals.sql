-- 0009: approvals waiting for the owner, and what became of them (F11, S36).
-- Forward-only: never edit this file once committed; add a new migration instead.
-- The action hash binds an approval to the exact arguments; status is a compare-and-set target so an
-- action can never run twice.

CREATE TABLE approvals (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES owners(id),
  turn_id      text NOT NULL REFERENCES turns(id),
  session_id   text NOT NULL REFERENCES sessions(id),
  tool         text NOT NULL,
  effect       text NOT NULL,
  target       text NOT NULL,
  action_hash  text NOT NULL,
  arguments    jsonb NOT NULL,
  summary      text NOT NULL,
  reason       text,
  status       text NOT NULL
               CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'executed', 'uncertain')),
  created_at   timestamptz NOT NULL,
  decided_at   timestamptz,
  ended_at     timestamptz
);

CREATE INDEX approvals_by_status ON approvals (status, created_at);
CREATE INDEX approvals_by_turn ON approvals (turn_id);
