-- The history import (src/history.js): the threads a channel had before the inbox did, read from
-- the platforms' history APIs and kept in pile 1 as `via: import`. A message is `imported` while
-- every pile-1 object of it says so (one heard of any other way is not, and stays not); a thread
-- is imported while all its messages are. An imported thread is read, waits on nobody, and gets
-- no agent, label, vectors or full-text items until someone asks for them
-- (docs/ARCHITECTURE.md, "History import").
ALTER TABLE messages ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;

-- One import of a channel: the threads started since `since`, page by page. `run` names the
-- import (when it was asked for); a newer one replaces the row, and the older one's pages stop.
-- `cursor` and `skip` are where the next page starts (the platform's cursor, and how many of that
-- page's roots are done). Done with `done_at`; an error that stays ends it too.
CREATE TABLE history_imports (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  since TEXT NOT NULL,
  run TEXT NOT NULL,
  cursor TEXT,
  skip INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  threads INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  error TEXT,
  PRIMARY KEY (source, tenant, channel_id)
);
