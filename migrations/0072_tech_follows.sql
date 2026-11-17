-- Following technologies (src/follows.js): a team, or one person, follows a technology of the tech
-- stack (`tech_stack.tech`), and the threads that show it are in the team's inbox, or in the
-- person's personal view, whichever team their channel is filed under. What a thread shows is its
-- own label's (`labels.tech`, migration 0059), not its channel's: the channels stay filed where the
-- rules and the shares put them.

-- What each thread shows, one row per technology: `labels.tech` (only what Clef is sure of, at
-- TECH_MIN or above, and what the rules detected) by index. Derived: written with the label, and
-- rebuilt from it here.
CREATE TABLE thread_tech (
  thread TEXT NOT NULL,
  tech TEXT NOT NULL,
  p REAL NOT NULL,
  PRIMARY KEY (thread, tech)
);
CREATE INDEX thread_tech_tech ON thread_tech(tech, thread);
INSERT OR IGNORE INTO thread_tech (thread, tech, p)
  SELECT l.thread, j.key, j.value FROM labels l, json_each(l.tech) j
  WHERE l.tech IS NOT NULL AND json_valid(l.tech) AND json_type(l.tech) = 'object'
    AND typeof(j.value) IN ('integer', 'real');

-- The technologies a team follows: its managers (and the admin team) pick them on its page.
-- Configuration, like the shares (`channel_teams`).
CREATE TABLE team_follows (
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  tech TEXT NOT NULL,
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (team, tech)
);
CREATE INDEX team_follows_tech ON team_follows(tech);

-- The technologies a person follows, for their personal view: from a thread's tech stack, or
-- their menu.
CREATE TABLE person_follows (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tech TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (person, tech)
);
CREATE INDEX person_follows_tech ON person_follows(tech);
