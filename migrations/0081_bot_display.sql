-- A bot's name and picture as the inbox shows them, an admin's say on the admin page's Bots
-- (src/ourbots.js): the platforms give some bots neither a picture (a Teams app has none in
-- Graph's messages) nor a name people know (a Teams bot posts under its registration's name).
-- NULL shows the platform's. Looking the account up again (src/lookup.js, getIdentity) leaves
-- them as they are.
ALTER TABLE identities ADD COLUMN display_name TEXT;
-- An https:// image URL.
ALTER TABLE identities ADD COLUMN display_avatar TEXT;
