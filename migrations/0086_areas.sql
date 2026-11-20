-- Areas: what a thread is about, as people author them (src/areas.js). Each is a file at
-- areas/<id>.md of a team's knowledge base, compiled here with the team's catalog (src/catalog.js,
-- knowledge_bases.catalog_commit). Clef asks the union of every team's, each id once; a thread
-- keeps those it answers at TOPIC_MIN or above, by id (labels.topics). Until any is written, the
-- list the inbox started with (src/label.js TOPICS) is asked.
CREATE TABLE areas (
  team TEXT NOT NULL,
  id TEXT NOT NULL,                   -- the file's name: authoring, cdn, …
  name TEXT NOT NULL,                 -- what the inbox shows (the file's title)
  what TEXT NOT NULL,                 -- what Clef is asked (its description)
  enabled INTEGER NOT NULL DEFAULT 1,
  path TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT,
  PRIMARY KEY (team, id)
);
