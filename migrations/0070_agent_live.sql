-- What the thread agent's latest turn is now, by inbox entry (src/agent/kept.js `keepLive`): a
-- copy of `latestTurn` (src/agent/turn.js) over the agent's transcript, working ones and those
-- that answer a sidebar message included, which GET /api/agent answers with, so that asking
-- what the agent is doing does not start its Durable Object. The agent writes it whenever the
-- turn may have changed (work accepted, a round of tools, an answer); `at` is when it read the
-- transcript, and an older reading never replaces a newer one. `turn` is JSON, `null` before
-- the agent's first turn. No row: the agent has not written one, and is asked.
CREATE TABLE agent_live (
  thread TEXT PRIMARY KEY,            -- the inbox entry's key, as the agent is named
  turn TEXT NOT NULL,
  at TEXT NOT NULL
);
