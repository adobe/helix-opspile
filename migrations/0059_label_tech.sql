-- The technologies a thread shows (src/label.js techOf): what Clef is sure of and what the
-- rules detected (1), as JSON `{ "<tech>": <probability> }`, `{}` when none. Set by every
-- relabel; null on labels written before it, for which the thread view falls back to the
-- threads that set the channel's highest probability (channel_tech.thread).
ALTER TABLE labels ADD COLUMN tech TEXT;
