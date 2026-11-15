-- 0002: one row per model request, with tokens and (when the price is known) cost. F03, F22.
-- Forward-only: never edit this file once committed; add a new migration instead.

CREATE TABLE usage (
  id                   bigserial PRIMARY KEY,
  owner_id             text NOT NULL REFERENCES owners(id),
  turn_id              text REFERENCES turns(id),
  purpose              text,
  provider             text NOT NULL,
  model                text NOT NULL,
  input_tokens         integer NOT NULL,
  output_tokens        integer NOT NULL,
  cached_input_tokens  integer,
  reasoning_tokens     integer,
  cost_micros          bigint,              -- NULL when the model has no configured price
  currency             text,
  at                   timestamptz NOT NULL
);
CREATE INDEX usage_by_time ON usage (owner_id, at);
CREATE INDEX usage_by_turn ON usage (turn_id);
