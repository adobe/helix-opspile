-- Pile 4 (first part): people, ops teams, the channel and identity caches, and the
-- rules that map channels to ops teams and customers. Rows are data and live only in
-- D1; nothing identifying is committed (this repository is public).

-- Ops teams, e.g. one per on-call rotation.
CREATE TABLE teams (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- People opspile knows about. Staff are added by hand (team members); others appear
-- through identities when they post.
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  name TEXT,
  staff INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE team_members (
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (team, person)
);

-- Platform accounts (cache of users.info / Graph users), linked to a person by email.
CREATE TABLE identities (
  source TEXT NOT NULL,               -- slack | teams
  tenant TEXT NOT NULL,               -- Slack enterprise/team id, Entra tenant id
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- person | bot | system
  name TEXT,
  email TEXT COLLATE NOCASE,
  home TEXT,                          -- Slack user_team / home tenant, if known
  person INTEGER REFERENCES people(id) ON DELETE SET NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, tenant, user_id)
);
CREATE INDEX identities_email ON identities(email);

-- Channels (cache of conversations.info / Graph team + channel).
CREATE TABLE channels (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT,
  group_id TEXT,                      -- Teams team id; Slack workspace id
  group_name TEXT,                    -- Teams team name
  shared INTEGER NOT NULL DEFAULT 0,  -- Slack Connect / shared channel
  connected TEXT,                     -- JSON array of connected Slack team ids
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, tenant, channel_id)
);

-- Rules: for each target, the matching rule with the lowest priority wins. `field` is
-- matched against `pattern` (a regular expression, case-insensitive); `value` may use
-- $1… from the match. Targets: team (ops team slug), org (customer or vendor slug),
-- kind (channel | alert | ignore).
CREATE TABLE rules (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('team', 'org', 'kind')),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT CHECK (source IS NULL OR source IN ('slack', 'teams')),
  field TEXT NOT NULL CHECK (field IN ('channel_id', 'name', 'group_name', 'connected')),
  pattern TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT
);
CREATE INDEX rules_target ON rules(target, priority);
