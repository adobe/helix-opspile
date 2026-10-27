-- Channel assignment requests: a team manager asks the admin team to put a channel in their
-- team's inbox ("assign channel X to team Y"), with a note; the admin team confirms (which runs
-- the manual assignment of src/admin.js: the channel moves to the team, or is shared with it
-- when another team holds it) or declines, with a reason. One open request per channel and
-- team. Decided requests stay, so the manager sees the outcome.
CREATE TABLE channel_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,               -- slack | teams | discord
  channel_id TEXT NOT NULL,           -- the platform's channel id
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  note TEXT,                          -- why, from the manager
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'declined', 'withdrawn')),
  requested_by TEXT NOT NULL,         -- email of the manager
  requested_name TEXT,
  requested_at TEXT NOT NULL,
  decided_by TEXT,                    -- email of whoever confirmed, declined or withdrew it
  decided_name TEXT,
  decided_at TEXT,
  reason TEXT,                        -- why it was declined
  outcome TEXT                        -- confirmed: moved | shared | assigned (nothing to move)
);
CREATE UNIQUE INDEX channel_requests_open ON channel_requests(source, channel_id, team)
  WHERE status = 'open';
CREATE INDEX channel_requests_status ON channel_requests(status, requested_at);
CREATE INDEX channel_requests_team ON channel_requests(team, requested_at);
