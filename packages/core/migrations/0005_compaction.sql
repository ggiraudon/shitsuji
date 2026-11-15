-- 0005: how much of a session's transcript its compaction summary covers. The transcript itself is
-- never deleted; the summary replaces the covered prefix in the model's context (F04, S23).
-- Forward-only: never edit this file once committed; add a new migration instead.

ALTER TABLE sessions ADD COLUMN summary_count integer NOT NULL DEFAULT 0;
