-- When a channel was archived on its platform (a Slack channel; a Teams channel, or its Teams
-- team), as its last lookup saw it (src/lookup.js, getChannel); NULL while it is not. The admin
-- pages leave archived channels out (src/admin.js), and Clef does not label them.
ALTER TABLE channels ADD COLUMN archived_at TEXT;
-- When the channel sweep (src/lookup.js, sweepChannels) last asked the platform about it,
-- answered or not, so that one that fails does not stay at the head of the sweep.
ALTER TABLE channels ADD COLUMN checked_at TEXT;
