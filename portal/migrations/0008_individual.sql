-- Individual channels (docs/PORTAL-INTEGRATION.md, "Individual channels"; docs/ARCHITECTURE.md,
-- "Customer portal"): a channel whose customers are each their own customer, as a product's end
-- users are. Each of them sees only the threads they started, wrote in or were added to;
-- Adobe's people see every thread of the channel in the inbox, as in any channel.
--
-- A channel without a row here is shared, as every channel was: this migration adds no row, so
-- every existing channel stays as it is. Keyed by the channel's id, which is a lobby channel's or
-- an integration mapping's reserved one (portal migration 0004), so the audience is set before
-- the channel's first message, and the integration reads it with the mapping.
CREATE TABLE channel_audiences (
  channel TEXT PRIMARY KEY NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('shared', 'individual')),
  set_by TEXT NOT NULL,                     -- the inbox's mail address of who set it
  set_at INTEGER NOT NULL                   -- Unix seconds
);

-- Who is in a thread, of the customers: whoever wrote in it (its first message's author first),
-- and whoever Adobe added (`added_by`). In a shared channel it changes nothing; in an individual
-- one it is who sees the thread. Staff and the app are never rows: they see every thread.
CREATE TABLE thread_members (
  root TEXT NOT NULL,                       -- the thread (its first message's id)
  user TEXT NOT NULL REFERENCES users(id),
  added_by TEXT,                            -- the inbox's mail address of who added them; null: they wrote in it
  at TEXT NOT NULL,
  PRIMARY KEY (root, user)
);
CREATE INDEX thread_members_user ON thread_members(user, root);

CREATE TRIGGER thread_member_author AFTER INSERT ON messages
WHEN (SELECT kind FROM users WHERE id = NEW.author) = 'customer'
BEGIN
  INSERT OR IGNORE INTO thread_members(root, user, at) VALUES (NEW.root, NEW.author, NEW.at);
END;

-- The threads written so far: who wrote in them is in them, so a channel switched to individual
-- later keeps each person's threads theirs, and those they took part in.
INSERT OR IGNORE INTO thread_members(root, user, at)
  SELECT m.root, m.author, MIN(m.at) FROM messages m JOIN users u ON u.id = m.author
  WHERE u.kind = 'customer' GROUP BY m.root, m.author;
