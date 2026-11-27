-- Team membership requests (src/memberrequests.js): a thread's agent asks, from its sidebar and
-- for the person who wrote there (`request_team_membership`, src/agent/memberrequest.js), that
-- someone be added to an ops team, with a reason. An admin or one of that team's managers
-- confirms it under Requests (or on the team's page), which adds the person as the team's page
-- does, or declines it with a reason. One open request per team and mail address; decided ones
-- stay, so whoever asked sees the outcome.
CREATE TABLE member_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  email TEXT NOT NULL,                -- the person to add, lowercase
  name TEXT,                          -- their name, as the request gives it
  note TEXT,                          -- why
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'declined', 'withdrawn')),
  requested_by TEXT NOT NULL,         -- email of the person who asked
  requested_name TEXT,
  requested_at TEXT NOT NULL,
  thread TEXT,                        -- the inbox entry whose sidebar asked
  decided_by TEXT,
  decided_name TEXT,
  decided_at TEXT,
  reason TEXT,                        -- why it was declined
  outcome TEXT                        -- confirmed: added | member (was one already)
);
CREATE UNIQUE INDEX member_requests_open ON member_requests(team, email) WHERE status = 'open';
CREATE INDEX member_requests_status ON member_requests(status, requested_at);
CREATE INDEX member_requests_team ON member_requests(team, requested_at);
