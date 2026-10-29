-- Orgs get a fourth type, internal: Adobe's own channels (tests, internal teams), which the
-- inbox groups apart from customers, partners and vendors. The inbox used to guess that from
-- who posted in the threads it had loaded; now the admin team says so. SQLite cannot change
-- a CHECK, so the table is made again.
CREATE TABLE orgs_new (
  slug TEXT PRIMARY KEY,
  name TEXT,                          -- display name; the slug when empty
  type TEXT NOT NULL DEFAULT 'customer' CHECK (type IN ('customer', 'partner', 'vendor', 'internal')),
  icon TEXT,                          -- a domain (its favicon) or an https:// image URL
  updated_at TEXT NOT NULL
);
INSERT INTO orgs_new (slug, name, type, icon, updated_at)
  SELECT slug, name, type, icon, updated_at FROM orgs;
DROP TABLE orgs;
ALTER TABLE orgs_new RENAME TO orgs;
