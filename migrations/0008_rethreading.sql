-- Re-threading: a root message that continues an earlier thread (a repeat alert, or a
-- follow-up posted as a new message) points to that thread. The platform thread is never
-- changed; undoing a match is clearing these columns.
ALTER TABLE threads ADD COLUMN logical_thread TEXT;   -- the earlier thread this one continues
ALTER TABLE threads ADD COLUMN logical_via TEXT;      -- vector | clef
ALTER TABLE threads ADD COLUMN logical_p REAL;        -- similarity or Clef probability
ALTER TABLE threads ADD COLUMN rethreaded_at TEXT;    -- when the decision was made (match or not)
CREATE INDEX threads_logical ON threads(logical_thread);
