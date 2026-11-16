-- What a discarded draft's first author last proposed (`drafts.origin_body`), kept for an Undo of
-- the discard (src/draftevents.js), where it is not the text discarded: the draft that comes back
-- is then compared with it when sent, as it would have been. Only while the Undo can come, a
-- minute (UNDO_SECONDS); the Undo takes it, and later ones are pruned.
CREATE TABLE draft_undo (
  thread TEXT NOT NULL,               -- the inbox entry's key, as on the discard's event
  draft TEXT NOT NULL,                -- the draft's created_at
  origin_body TEXT NOT NULL,
  at TEXT NOT NULL,                   -- when it was discarded
  PRIMARY KEY (thread, draft)
);
CREATE INDEX draft_undo_at ON draft_undo(at);
