-- The customer portal (the fourth source, after Slack, Teams and Discord): a Worker of its own
-- (src/portal/), which the inbox reads as a platform. docs/ARCHITECTURE.md, "Customer portal".

-- Rules may be limited to the portal too. SQLite cannot change a CHECK constraint, so the table
-- is rebuilt with the same columns and rows, as migration 0026 did for Discord; the code that
-- reads it is unchanged.
CREATE TABLE rules_new (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('team', 'org', 'kind')),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT CHECK (source IS NULL OR source IN ('slack', 'teams', 'discord', 'portal')),
  field TEXT NOT NULL CHECK (field IN ('channel_id', 'name', 'group_name', 'connected')),
  pattern TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT
);
INSERT INTO rules_new (id, target, priority, source, field, pattern, value, note, updated_by,
  updated_at)
  SELECT id, target, priority, source, field, pattern, value, note, updated_by, updated_at
  FROM rules;
DROP TABLE rules;
ALTER TABLE rules_new RENAME TO rules;
CREATE INDEX rules_target ON rules(target, priority);

-- What a customer's lobby in the portal asks for: a channel, for the people of one mail domain
-- (`domain`, the tenant of its channels) who use these technologies (`tech`, ids of
-- `tech_stack`). The portal tells how the lobby is now with every change (its `lobby` events,
-- in pile 1; `seq` is the latest one's number, and an older one changes nothing). The admin
-- team opens a channel for it, or declines it; a team's managers open one for their team when
-- it follows a technology the lobby picked (`team_follows`). Status: open (waiting), opened
-- (it has a channel), declined. docs/STATE-MACHINES.md, "Portal requests".
CREATE TABLE portal_requests (
  id INTEGER PRIMARY KEY,
  portal TEXT NOT NULL,               -- the portal it is from (its PORTAL_NAME)
  domain TEXT NOT NULL,               -- the lobby: a customer's mail domain
  company TEXT,                       -- what its people call it
  tech TEXT NOT NULL DEFAULT '[]',    -- JSON array of technology ids
  note TEXT,                          -- what they need, in their words
  members TEXT NOT NULL DEFAULT '[]', -- JSON array of { id, name, email, joined }
  requested_by TEXT,                  -- mail address
  requested_name TEXT,
  requested_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'opened', 'declined')),
  decided_by TEXT,
  decided_name TEXT,
  decided_at TEXT,
  reason TEXT,                        -- why it was declined
  channel_id TEXT,                    -- the channel opened for it (the latest)
  team TEXT,                          -- the team that channel was filed under
  org TEXT,                           -- and the customer
  UNIQUE (portal, domain)
);
CREATE INDEX portal_requests_status ON portal_requests(status, requested_at);

-- The technologies a lobby picks from: Adobe's own, of the admin team's tech stack. A team's
-- entry, and one added later, is offered once this is set.
ALTER TABLE tech_stack ADD COLUMN portal INTEGER NOT NULL DEFAULT 0;
UPDATE tech_stack SET portal = 1 WHERE team = 'admin' AND tech IN (
  'eds', 'aemcs', 'aem65', 'byom', 'da', 'ue', 'xw', 'sidekick', 'aemcontent', 'msm', 'ema',
  'edgefunctions', 'contentai', 'productbus', 'rum', 'aso', 'assets', 'dm', 'forms', 'commerce',
  'aco', 'analytics', 'target', 'rtcdp', 'ajo', 'campaign', 'workfront', 'genstudio', 'llmo',
  'semrush', 'brandconcierge', 'coworker', 'appbuilder');
