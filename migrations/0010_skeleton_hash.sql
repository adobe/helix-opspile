-- Exact repeats are matched by the hash of their skeleton in D1, before (and independent of)
-- vector search, which is eventually consistent and rate limited.
ALTER TABLE threads ADD COLUMN skeleton_hash TEXT;
CREATE INDEX threads_skeleton ON threads(source, tenant, channel_id, skeleton_hash);
