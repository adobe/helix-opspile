-- When the inbox first sent a group's reply into this folded root's platform thread, because it
-- was the group's latest (src/post.js target): as the inbox's reply, the app's or a thread
-- agent's. The group's conversation goes on there now, where the people in the channel see it,
-- so the root stays in its group for good (src/rethread.js): replies in its thread, the inbox's
-- or theirs, do not split it out, nor does a forced re-threading.
ALTER TABLE threads ADD COLUMN routed_at TEXT;
