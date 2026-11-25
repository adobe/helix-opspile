-- What a team follows besides technologies (team_follows, 0072) and customers (a follow rule of
-- field `org`, 0098): areas, the topics Clef puts threads in (thread_areas, 0087). The threads
-- Clef puts in an area a team follows are in its inbox, as those that show a technology it
-- follows are (src/follows.js). A team follows no person: that is a person's own follow.
CREATE TABLE team_follows_by (
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('area')),
  target TEXT NOT NULL,
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (team, kind, target)
);
CREATE INDEX team_follows_by_target ON team_follows_by (kind, target);
