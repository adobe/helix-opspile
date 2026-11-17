-- A channel request may ask to move a channel, not only to add it (src/requests.js): `move`
-- confirms it as a move, so the channel is filed under the team even when another team holds it
-- (otherwise it would be shared with the team). The thread agent files such requests from its
-- sidebar (`request_channel_reassignment`, src/agent/channelrequest.js) for the person who asked
-- there; `thread` is the inbox entry whose sidebar it was, NULL for a request from a team's page.
ALTER TABLE channel_requests ADD COLUMN move INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_requests ADD COLUMN thread TEXT;
