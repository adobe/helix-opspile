-- What the expert finder showed and what people did with it (src/expertevents.js), for a better
-- finder to learn from: `list` is what GET /api/experts computed for someone, every candidate
-- with its signals (`data`: JSON `{ finder, candidates: [{ id, person, pos, features }] }`);
-- the others are the page's, about such a list: `shown` (on screen in the open thread), `open`
-- (its ▾ list opened), `pick` (someone picked, `account` and their `pos`), `dismiss` (the ▾ list
-- closed, or left, with nobody picked). Whom the person mentioned afterwards, and who answered,
-- the training reads from `mentions` and `messages`.
CREATE TABLE expert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  thread TEXT NOT NULL,               -- the inbox entry's key
  action TEXT NOT NULL,               -- list | shown | open | pick | dismiss
  list INTEGER,                       -- the `list` event this one is about (all but a list)
  account TEXT,                       -- pick: the account picked, on the thread's platform
  pos INTEGER,                        -- pick: their place in the list, 0 the one in the header
  data TEXT                           -- list: the candidates, as above
);
CREATE INDEX expert_events_at ON expert_events(at);
CREATE INDEX expert_events_list ON expert_events(list);
