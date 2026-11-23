-- Follow rules, and the conflicts between team rules the admin team keeps (src/ruleconflicts.js).
--
-- A rule of target `follow` files nothing: every follow rule that matches a channel shares it with
-- its team, as a share added by hand does (`channel_teams`, migration 0024), unless the channel is
-- filed under that team. src/followrules.js writes those shares, `added_by` `rule:<id>`, whenever a
-- rule changes and on the cron, and takes them away once the rule no longer matches.
--
-- SQLite cannot change a CHECK constraint, so the table is rebuilt with the same columns and rows,
-- as migration 0026 did; the code that reads it is unchanged.
CREATE TABLE rules_new (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('team', 'org', 'kind', 'follow')),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT CHECK (source IS NULL OR source IN ('slack', 'teams', 'discord', 'portal')),
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

-- Conflicts between team rules are computed from the rules and the channels every time; this keeps
-- the ones the admin team settled as they are (a manual assignment that is meant to win): hidden
-- while their rules and channels stay what they were when kept (`fingerprint`), open again after.
CREATE TABLE rule_conflict_keeps (
  key TEXT PRIMARY KEY,               -- the conflict's key: its two sides
  fingerprint TEXT NOT NULL,          -- of the rules and channels it was kept with
  kept_by TEXT NOT NULL,              -- the admin's email
  kept_at TEXT NOT NULL,
  note TEXT                           -- why, in their words
);
