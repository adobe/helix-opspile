-- Teams bots known from the apps installed in a Teams team, not only from messages.
--
-- The cron lists every known Teams team's installed apps, so a bot can be mentioned from the
-- inbox before anyone has mentioned it in that team. `installed` is when that list last
-- showed the bot. A row the list created, without a message showing the bot, has `at = ''`
-- (it sorts after the bots people use), and goes again when the bot is no longer installed.
ALTER TABLE bot_teams ADD COLUMN installed TEXT;
