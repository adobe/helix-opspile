-- Orgs (#18): what an org slug from the rules is called, its icon, and what it is to us.
-- Data like the rules, maintained by the admin team in the admin UI. An org without a row
-- is a customer named by its slug, with the favicon of its usual mail domain.
CREATE TABLE orgs (
  slug TEXT PRIMARY KEY,
  name TEXT,                          -- display name; the slug when empty
  type TEXT NOT NULL DEFAULT 'customer' CHECK (type IN ('customer', 'partner', 'vendor')),
  icon TEXT,                          -- a domain (its favicon) or an https:// image URL
  updated_at TEXT NOT NULL
);

-- Rules made in the admin UI say who made them and when.
ALTER TABLE rules ADD COLUMN updated_by TEXT;
ALTER TABLE rules ADD COLUMN updated_at TEXT;
