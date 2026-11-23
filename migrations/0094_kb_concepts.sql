-- The concepts of every knowledge base, for the inbox's search (src/kbsearch.js): one row per
-- markdown entry (not index.md, log.md or systemprompt.md), with its frontmatter's type, title,
-- description, tags and aliases and its body (the first 8 KB), which GET /api/search matches
-- the query's words in. `hash` is the file's blob hash, so a sync reads only what changed;
-- `embedded` the hash of the text its CONTENT vector (`type: kb`) was made from, NULL until
-- one is.
CREATE TABLE kb_concepts (
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  type TEXT,
  title TEXT,
  description TEXT,
  tags TEXT,
  aliases TEXT,
  body TEXT,
  embedded TEXT,
  PRIMARY KEY (repo, path)
);
CREATE INDEX kb_concepts_unembedded ON kb_concepts(repo) WHERE embedded IS NULL;

-- The commit the knowledge base's kb_concepts rows were last read from in full (the cron), or
-- '' for one that had no commit then; NULL: not read yet, or a write's update failed. Every
-- write updates the rows of the files it changed, and leaves the watermark as it was.
ALTER TABLE knowledge_bases ADD COLUMN search_commit TEXT;
