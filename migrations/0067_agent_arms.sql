-- The experiment arm a thread's agent is pinned to (src/agent/arms.js, src/experiments.js): decided
-- once, when the agent first starts inside an experiment's window, and kept for the thread's life,
-- so a thread never changes model. The COGS dashboard counts the arms' drafts by it.
CREATE TABLE agent_arms (
  name TEXT NOT NULL,                 -- the agent's name: the inbox entry's key
  experiment TEXT NOT NULL,           -- src/experiments.js, e.g. `model`
  arm TEXT NOT NULL,                  -- e.g. `opus`, `sonnet`
  at TEXT NOT NULL,                   -- when it was pinned
  PRIMARY KEY (experiment, name)
) WITHOUT ROWID;
