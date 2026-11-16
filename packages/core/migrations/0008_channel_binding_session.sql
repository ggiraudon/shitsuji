-- 0008: a chat channel can have its own conversation after /new, instead of always using the main
-- chat session. Forward-only: never edit this file once committed; add a new migration instead.

ALTER TABLE channel_bindings ADD COLUMN session_id text REFERENCES sessions(id);
