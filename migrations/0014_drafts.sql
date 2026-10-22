-- Shared drafts: at most one unsent reply per inbox entry, visible to everyone in the team
-- that owns the channel. User state, like watermarks: not derived from pile 2, so a rebuild
-- of the index keeps it.
CREATE TABLE drafts (
  thread TEXT PRIMARY KEY,            -- the inbox entry (a group's first thread, or the thread)
  body TEXT NOT NULL,
  mentions TEXT,                      -- JSON [{ id, name }]: picked @-mentions
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, -- who saved it last
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL            -- the draft's version, for saves that would overwrite
);
