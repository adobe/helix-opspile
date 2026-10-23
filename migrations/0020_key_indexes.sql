-- Messages, mentions and reactions name identities and messages by composite keys
-- (`source:tenant:user_id`, `source:tenant:channel_id:id`), and the inbox joins on them.
-- Without an index on the same expression every such join scanned the whole table: loading
-- the inbox spent most of its D1 time there. The queries compare against `+column`, so
-- SQLite uses these indexes (a plain column would bring its text affinity, and no index).
CREATE INDEX IF NOT EXISTS identities_key ON identities(source || ':' || tenant || ':' || user_id);
CREATE INDEX IF NOT EXISTS messages_key
  ON messages(source || ':' || tenant || ':' || channel_id || ':' || id);
