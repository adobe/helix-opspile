-- The catalog: every team's knowledge base lists the products it supports under `products/`,
-- a concept per vendor, product, feature or category (src/catalog.js, docs/ARCHITECTURE.md
-- "Labels and facts"). The files are the source: each write of one, and the cron, compiles the
-- team's into tech_stack rows, which carry the file's path (`path`); a row without one was
-- written in D1 (before the catalog, or with save_tech) and stays as it is until a catalog file
-- lists its id in `moved_from`. A technology's id is its path under products/ without `.md`.
ALTER TABLE tech_stack ADD COLUMN path TEXT;      -- products/<…>.md it was compiled from
ALTER TABLE tech_stack ADD COLUMN kind TEXT;      -- Product | Feature | Category (compiled rows)
ALTER TABLE tech_stack ADD COLUMN vendor TEXT;    -- the vendor's name (compiled rows; none for a category)

-- The ids technologies had before (a file's `moved_from`), per team: the compile rewrites what
-- D1 stores under an old id (follows, extraction rules, thread_tech, channel_tech, the portal's
-- lobbies) when a move is new, and files (stack.md) are read through it.
CREATE TABLE tech_moves (
  team TEXT NOT NULL,
  old TEXT NOT NULL,
  tech TEXT NOT NULL,
  PRIMARY KEY (team, old)
);
CREATE INDEX tech_moves_old ON tech_moves (old);

-- The commit of the knowledge base the team's catalog rows were compiled from: the cron compiles
-- again when the head is another (a revert, a push from outside).
ALTER TABLE knowledge_bases ADD COLUMN catalog_commit TEXT;
