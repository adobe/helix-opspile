-- Adobe's own bots (src/ourbots.js, the admin page's Bots): an admin says whether a bot is
-- Adobe's. Bots have no mail address, so the mail domain cannot say; an Adobe bot counts as
-- staff (src/lookup.js, toAuthor), and the inbox shows its messages on Adobe's side.
-- 1 Adobe's, 0 not Adobe's (an admin took the flag off again), NULL never decided. Looking the
-- account up again (src/lookup.js, getIdentity) leaves it as it is.
ALTER TABLE identities ADD COLUMN ours INTEGER;
-- Who said so last (their mail address) and when.
ALTER TABLE identities ADD COLUMN ours_by TEXT;
ALTER TABLE identities ADD COLUMN ours_at TEXT;
