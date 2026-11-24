-- What the thread agents tell the people who build opspile (send_feedback, src/agent/feedback.js):
-- one row per piece of feedback, kept before it is filed as a GitHub issue (or a comment on an
-- open one) in FEEDBACK_REPO, so that a failed filing is tried again by the cron.
--
-- `issue_number` is the issue it was filed in (or added to, `comment_url` then), `filed_at`
-- when; both stay NULL until it is filed. `attempts` counts the tries, `error` keeps the last
-- one's; the cron gives up after five (STATE-MACHINES.md, "Agent feedback"). `thread` and
-- `person` (who asked for it in the sidebar, if anyone) stay here and never go to GitHub.
CREATE TABLE agent_feedback (
  id TEXT PRIMARY KEY,               -- fb_…
  thread TEXT,                       -- the agent's inbox entry, NULL for one without a thread
  team TEXT,
  person INTEGER REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                -- bug | missing | instructions | idea
  tool TEXT,                         -- the tool or MCP server it is about, if one
  title TEXT NOT NULL,
  body TEXT NOT NULL,                -- markdown
  issue INTEGER,                     -- an open feedback issue to add to, as the agent asked
  model TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  issue_number INTEGER,
  issue_url TEXT,
  comment_url TEXT,
  filed_at TEXT
);
CREATE INDEX agent_feedback_thread ON agent_feedback(thread, created_at);
CREATE INDEX agent_feedback_unfiled ON agent_feedback(created_at) WHERE filed_at IS NULL;
