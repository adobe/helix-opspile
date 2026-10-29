-- Slack: the workspace whose address a channel's links open in (`<domain>.slack.com`), so that
-- someone in several workspaces lands in the right one. NULL until the channel is looked up
-- again, '' when its workspace's domain could not be found (src/lookup.js).
ALTER TABLE channels ADD COLUMN domain TEXT;
