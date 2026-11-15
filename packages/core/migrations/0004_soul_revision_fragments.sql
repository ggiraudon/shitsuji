-- 0004: a SOUL revision keeps the fragments it was assembled from, so a session-kind part can be
-- re-assembled for each turn and a revision can be rolled back exactly (Q6, S23).
-- Forward-only: never edit this file once committed; add a new migration instead.

ALTER TABLE soul_revisions ADD COLUMN fragments jsonb NOT NULL DEFAULT '[]'::jsonb;
