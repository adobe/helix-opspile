-- Conflicts between the teams' technologies (src/techconflicts.js) are computed from tech_stack
-- every time; this keeps the ones the admin team settled as they are (an intended override, a
-- shared name that is meant): hidden while their definitions stay what they were when kept
-- (`fingerprint`), open again once one changes.
CREATE TABLE tech_conflict_keeps (
  key TEXT PRIMARY KEY,               -- diverging:<tech> | name:<name>
  fingerprint TEXT NOT NULL,          -- of the definitions it was kept with
  kept_by TEXT NOT NULL,              -- the admin's email
  kept_at TEXT NOT NULL,
  note TEXT                           -- why, in their words
);
