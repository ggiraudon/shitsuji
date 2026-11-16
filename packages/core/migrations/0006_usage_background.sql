-- 0006: the usage ledger says which session a request belongs to and whether background work paid
-- for it, so the budget can count background spend separately (F22, S27).
-- Forward-only: never edit this file once committed; add a new migration instead.

ALTER TABLE usage ADD COLUMN session_id text REFERENCES sessions(id);
ALTER TABLE usage ADD COLUMN background boolean NOT NULL DEFAULT false;

CREATE INDEX usage_by_session ON usage (session_id, at);
