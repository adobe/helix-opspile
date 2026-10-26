-- Channels followed by more than one ops team. A channel is filed under one team, its first:
-- the rules (and manual assignments) pick it, and its pile-2 folders, thread rows, knowledge
-- base and agents are that team's. The teams here follow the channel as well: its threads are
-- in their inboxes, and their members read, reply, react, resolve and draft there. Adding a team
-- to a channel the admin team (or nobody) holds moves it; adding one to a channel another team
-- holds puts a row here. Configuration, like the rules: not derived from pile 2, so a rebuild
-- of the index keeps it.
CREATE TABLE channel_teams (
  source TEXT NOT NULL,               -- slack | teams
  channel_id TEXT NOT NULL,           -- Slack or Teams channel id
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (source, channel_id, team)
);
CREATE INDEX channel_teams_team ON channel_teams(team);
