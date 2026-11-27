-- Dreams (src/dreams.js, src/agent/dream.js, the dream experiment in src/experiments.js): a
-- customer's knowledge-base agent consolidating kb-org once the customer's channels have been quiet
-- for eight hours. One row per dream, written before the agent is asked; `submitted_at` once it
-- took the dream, `ended_at` and `outcome` once it settled. An open row (no `ended_at`) is the
-- sweep's to ask about again.
CREATE TABLE kb_dreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org TEXT NOT NULL,                  -- the customer whose kb-org it consolidates
  team TEXT NOT NULL,                 -- whose knowledge-base agent dreams: kb:<team>:<org>
  quiet_since TEXT NOT NULL,          -- the customer's latest message it dreamed after
  entries_before INTEGER,             -- knowledge_bases.entries of kb-org when it started
  entries_after INTEGER,              -- and when it ended
  started_at TEXT NOT NULL,
  submitted_at TEXT,                  -- the agent accepted it
  ended_at TEXT,
  outcome TEXT,                       -- done | unanswered | timeout | failed
  note TEXT,                          -- the agent's closing sentences: what it merged, moved, deleted
  error TEXT
);
CREATE INDEX kb_dreams_org ON kb_dreams(org, started_at);
CREATE INDEX kb_dreams_open ON kb_dreams(ended_at, started_at);
