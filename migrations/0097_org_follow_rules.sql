-- A team follows a customer: a follow rule (target `follow`, migration 0086) of field `org`, whose
-- pattern matches the org the other rules file a channel under (src/rules.js `followers`). It
-- shares every channel of the customer with its team, now and later, as any follow rule does
-- (src/followrules.js); the channels stay filed under their teams. Managers make them on the
-- customer's page (PUT /api/admin/org-follows).
--
-- SQLite cannot change a CHECK constraint, so the table is rebuilt with the same columns and rows,
-- as migrations 0026 and 0086 did; `org` is a field of follow rules only.
CREATE TABLE rules_new (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('team', 'org', 'kind', 'follow')),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT CHECK (source IS NULL OR source IN ('slack', 'teams', 'discord', 'portal')),
  field TEXT NOT NULL CHECK (field IN ('channel_id', 'name', 'group_name', 'connected', 'org')
    AND (field != 'org' OR target = 'follow')),
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
