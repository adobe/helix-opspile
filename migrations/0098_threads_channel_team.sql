-- The teams of a channel's threads, each found by one search of this index (src/shares.js
-- `roomsOf`, which asks for them on every load of /api/me and of the personal view): the least
-- team of the channel, then the next after it. threads_channel has the channel's threads in time
-- order only, so finding its few teams read every one of them, the tens of thousands of an alert
-- channel's.
CREATE INDEX threads_channel_team ON threads(channel_id, source, team);
