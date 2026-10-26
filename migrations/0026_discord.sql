-- Discord (the third platform, after Slack and Teams).

-- Whether a platform account counts as staff without being linked to a person: a Discord
-- member with one of the DISCORD_STAFF_ROLES (Discord shares no email, so the mail domain
-- cannot say). NULL on Slack and Teams, where people and mail domains decide.
ALTER TABLE identities ADD COLUMN staff INTEGER;

-- Rules may be limited to Discord too. SQLite cannot change a CHECK constraint, so the table
-- is rebuilt with the same columns and rows; the code that reads it is unchanged.
CREATE TABLE rules_new (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('team', 'org', 'kind')),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT CHECK (source IS NULL OR source IN ('slack', 'teams', 'discord')),
  field TEXT NOT NULL CHECK (field IN ('channel_id', 'name', 'group_name', 'connected')),
  pattern TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT
);
INSERT INTO rules_new (id, target, priority, source, field, pattern, value, note, updated_by,
  updated_at)
  SELECT id, target, priority, source, field, pattern, value, note, updated_by, updated_at
  FROM rules;
DROP TABLE rules;
ALTER TABLE rules_new RENAME TO rules;
CREATE INDEX rules_target ON rules(target, priority);
