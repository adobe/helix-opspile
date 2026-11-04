-- The thread agent's latest finished turn, by inbox entry (src/agent/kept.js): what the inbox
-- shows under the thread's last message, so it comes with the thread (GET /api/thread) instead
-- of from the agent's Durable Object after it. The agent writes it when a turn ends; a turn in
-- progress is only ever asked of the agent (GET /api/agent). Derived from the agent's
-- transcript, which stays the record.
CREATE TABLE agent_turns (
  thread TEXT PRIMARY KEY,            -- the inbox entry's key, as the agent is named
  state TEXT NOT NULL,                -- done | failed
  text TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  at TEXT NOT NULL
);
