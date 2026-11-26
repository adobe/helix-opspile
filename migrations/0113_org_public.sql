-- Orgs get a fifth type, public: channels anyone may join (a community's Discord server, an
-- event's or a course's Slack channel), whose people are of many orgs, or of none, and Adobe's.
-- A public org is where they meet, never one side of a thread: not a customer, a partner's
-- customer, a duplicate of one, nor whose usual mail domain anybody's is. Its threads are
-- linked with the customers and partners whose people post in them (`thread_orgs`, roles
-- `customer` and `partner`, src/threadlinks.js). SQLite cannot change a CHECK, so the table is
-- made again, as in 0039.
CREATE TABLE orgs_new (
  slug TEXT PRIMARY KEY,
  name TEXT,                          -- display name; the slug when empty
  type TEXT NOT NULL DEFAULT 'customer'
    CHECK (type IN ('customer', 'partner', 'vendor', 'internal', 'public')),
  icon TEXT,                          -- a domain (its favicon) or an https:// image URL
  updated_at TEXT NOT NULL
);
INSERT INTO orgs_new (slug, name, type, icon, updated_at)
  SELECT slug, name, type, icon, updated_at FROM orgs;
DROP TABLE orgs;
ALTER TABLE orgs_new RENAME TO orgs;
