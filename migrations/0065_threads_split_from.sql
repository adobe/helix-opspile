-- The group a root is being split out of (src/rethread.js dethread): written with the split,
-- `logical_via = 'split'`, and cleared once its root file, the roots that followed it in a burst
-- and the open inboxes have all been brought along. Set means that work is unfinished: a retry
-- of the reply, a later reply, or `sweepRethreads` finishes it.
ALTER TABLE threads ADD COLUMN split_from TEXT;
CREATE INDEX threads_split_from ON threads (split_from) WHERE split_from IS NOT NULL;
