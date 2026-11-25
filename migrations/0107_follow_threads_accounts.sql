-- A person follows a thread (`thread`, an inbox entry's key: it stays in their personal view) and
-- a person known by their platform account only (`account`, an identity key
-- `<source>:<tenant>:<user id>`, as messages.author_key has it: a customer's people, who are no
-- person of D1; the threads they post in), besides customers, people and areas (0087).
--
-- SQLite cannot change a CHECK constraint, so the table is rebuilt with the same columns and rows,
-- as migration 0098 did for the rules.
CREATE TABLE person_follows_by_new (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('org', 'person', 'area', 'account', 'thread')),
  target TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (person, kind, target)
);
INSERT INTO person_follows_by_new (person, kind, target, added_at)
  SELECT person, kind, target, added_at FROM person_follows_by;
DROP TABLE person_follows_by;
ALTER TABLE person_follows_by_new RENAME TO person_follows_by;
CREATE INDEX person_follows_by_target ON person_follows_by (kind, target);
