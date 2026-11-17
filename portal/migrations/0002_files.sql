-- Files, mentions, pictures and logos (docs/ARCHITECTURE.md, "Customer portal"). The bytes are
-- in the portal's bucket (`FILES`); this is what they are.

-- A file attached to a message: uploaded first, to a channel, by whoever writes the message,
-- then named by the message that carries it (`message`). One that no message took within a day
-- is deleted by the cron. Its bytes: `files/<lobby>/<channel>/<id>`.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  lobby TEXT NOT NULL,
  channel TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                 -- its content type, as uploaded
  size INTEGER NOT NULL,
  width INTEGER,                      -- an image's size, as its uploader measured it
  height INTEGER,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);
CREATE INDEX files_message ON files(message);
CREATE INDEX files_orphans ON files(at) WHERE message IS NULL;

-- Who a message mentions: a JSON array of account ids, the people of its channel whose
-- `@Name` it has.
ALTER TABLE messages ADD COLUMN mentions TEXT;

-- A person's picture: one they uploaded (`avatar_key`, its key in the bucket), else, for the
-- Adobe people who answer from the inbox, the address of the one the inbox knows (`avatar`).
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN avatar_key TEXT;

-- A customer's logo, uploaded by one of its people: its key in the bucket.
ALTER TABLE lobbies ADD COLUMN logo_key TEXT;
