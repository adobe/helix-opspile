-- Teams bots that can be mentioned in a reply.
--
-- A bot's `identities` row (kind `bot`) is written when it posts or is mentioned. People
-- mention a bot by its short name (the mention text), which can differ from the name it
-- posts under, so that is kept apart as `handle`.
ALTER TABLE identities ADD COLUMN handle TEXT;

-- The Teams teams a bot has shown up in (it posted, or was mentioned, in one of their
-- channels), so a reply only offers bots that are installed where it is going.
CREATE TABLE bot_teams (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  at TEXT NOT NULL,                   -- latest message that showed the bot there
  PRIMARY KEY (source, tenant, bot_id, group_id)
);
