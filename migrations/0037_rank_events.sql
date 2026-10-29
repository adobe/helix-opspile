-- What people pick in the thread list, to learn the team order from (scripts/rank.mjs): each
-- time someone opens a thread by clicking it in the list, the threads on screen then, with
-- their place in the list and the features ui/rank.js computed for each (`shown`: JSON
-- `[{ thread, pos, features }]`, the clicked one among them), and the model that ordered them.
CREATE TABLE rank_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  view TEXT NOT NULL,                 -- a team's slug, or 'personal'
  clicked TEXT NOT NULL,
  shown TEXT NOT NULL,
  model TEXT
);
CREATE INDEX rank_events_at ON rank_events(at);
