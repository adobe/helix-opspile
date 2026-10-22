-- Generated thread titles, and the tech stack seen per channel.

-- A short title written by a language model: the specific failure for an alert group,
-- the topic for a conversation. The inbox prefers it to the first line of the root.
ALTER TABLE labels ADD COLUMN title TEXT;

-- Technologies a customer's channel shows (Clef, per thread; the channel keeps the highest
-- probability seen). Shown as chips on every thread of the channel.
CREATE TABLE channel_tech (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  tech TEXT NOT NULL,
  p REAL NOT NULL,
  thread TEXT,                         -- the thread that showed it most clearly
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, tenant, channel_id, tech)
);
