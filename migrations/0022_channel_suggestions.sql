-- Channel suggestions on the admin pages: who is in a channel, and what Clef says about each
-- channel the admin team holds (the fallback for channels no rule files under an ops team).

-- What a channel is about, in its own words: the Slack purpose (or topic), the Teams channel's
-- description (or its team's). Filled in by the channel lookup.
ALTER TABLE channels ADD COLUMN topic TEXT;
-- When the members below were last listed, and why that failed if it did.
ALTER TABLE channels ADD COLUMN members_at TEXT;
ALTER TABLE channels ADD COLUMN members_error TEXT;

-- The people in a channel (Slack conversations.members; on Teams, the members of the team),
-- so a team member who reads but never posts still counts. Replaced as a whole per listing.
CREATE TABLE channel_members (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT COLLATE NOCASE,          -- from the platform (Teams) or a known identity (Slack)
  name TEXT,
  PRIMARY KEY (source, tenant, channel_id, user_id)
);
CREATE INDEX channel_members_email ON channel_members(email);

-- One Clef classification per channel: which ops team should own it, and what kind of channel
-- it is. Recomputed when the channel has new activity, the ops teams change, or it is a week old.
CREATE TABLE channel_labels (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  team TEXT,                          -- Clef's pick: an ops team slug, or `none`
  team_p REAL,
  teams TEXT,                         -- JSON { slug: probability } for every option
  kind TEXT,                          -- channel | alert | ignore
  kind_p REAL,
  labeled_through TEXT,               -- the channel's latest activity when it was labeled
  options TEXT,                       -- the ops teams Clef chose between (sorted slugs)
  model TEXT NOT NULL,
  labeled_at TEXT NOT NULL,
  PRIMARY KEY (source, tenant, channel_id)
);
