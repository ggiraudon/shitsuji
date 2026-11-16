-- 0007: holds placed before a model request, so parallel requests cannot overspend (F22, S27).
-- A hold is settled by the usage row that replaces it, or released when the request fails.
-- Forward-only: never edit this file once committed; add a new migration instead.

CREATE TABLE budget_reservations (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES owners(id),
  amount_micros bigint NOT NULL CHECK (amount_micros >= 0),
  currency      text NOT NULL,
  background    boolean NOT NULL,
  session_id    text REFERENCES sessions(id),
  turn_id       text REFERENCES turns(id),
  state         text NOT NULL CHECK (state IN ('held', 'settled', 'released')),
  created_at    timestamptz NOT NULL,
  ended_at      timestamptz
);

CREATE INDEX budget_reservations_open ON budget_reservations (owner_id, state, created_at);
