-- What became of the shared drafts (src/draftevents.js), for the COGS dashboard's acceptance and
-- cost per accepted draft (src/cogs/report.js): who saved each version, whether it was sent (as
-- the person, as the opspile app, or by the thread agent itself), discarded by a person, or
-- withdrawn by the agent that saved it, and how much the text sent differs from what its first
-- author proposed. Numbers and ids only, never the text: `hash` (of a discarded draft's text)
-- only tells an Undo of that discard, which saves the same text again, from a new draft.
CREATE TABLE draft_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread TEXT NOT NULL,               -- the inbox entry's key
  draft TEXT NOT NULL,                -- the draft's created_at: one draft through its versions; '' for a post without one
  version TEXT,                       -- its updated_at the event is about
  action TEXT NOT NULL,               -- saved | sent | discarded | posted (the agent's own post, no draft)
  how TEXT,                           -- sent and posted: me | app | agent
  person INTEGER,                     -- who did it (the agent's person for the agent)
  by_agent INTEGER NOT NULL DEFAULT 0,
  origin INTEGER,                     -- who saved the draft's first version
  origin_agent INTEGER,               -- 1 when that was the agent, null when not known
  changed REAL,                       -- sent: how much of the text differs from the origin's (0–1, by word)
  hash TEXT,                          -- discarded: of the text, for an Undo
  org TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX draft_events_at ON draft_events(at);
CREATE INDEX draft_events_thread ON draft_events(thread, action, at);

-- Who saved a draft's first version, and the latest text they saved: what a sent draft is
-- compared with. The drafts there are now count as their last author's.
ALTER TABLE drafts ADD COLUMN origin INTEGER;
ALTER TABLE drafts ADD COLUMN origin_body TEXT;
UPDATE drafts SET origin = person, origin_body = body;
