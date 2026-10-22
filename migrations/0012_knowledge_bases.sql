-- Pile 3: the knowledge-base repos that exist in Artifacts (#12).
CREATE TABLE knowledge_bases (
  repo TEXT PRIMARY KEY,              -- kb-org-<slug> / kb-team-<slug>
  kind TEXT NOT NULL,                 -- org | team
  slug TEXT NOT NULL,
  remote TEXT,                        -- git remote of the Artifacts repo
  created_at TEXT NOT NULL
);
