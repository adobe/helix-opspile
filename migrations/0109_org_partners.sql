-- Which customers each partner works for (src/orgpartners.js). A pair of a customer and a
-- partner (an org of type `partner`) that may work together: its signals as last found (`signals`,
-- JSON `[{ kind, weight, n, text }]`, and `score`, their weights added), Clef's probability that
-- the partner works for the customer from what it was shown (`fingerprint`, a hash of it: asked
-- again when that changes), and the admin team's decision, confirmed or dismissed (one at a time).
-- A row nobody decided goes once the pair is no candidate any more; a decided one stays.
-- `merged_from`: the row is a merged org's decision, copied to the org it went into by the merge
-- (src/orgmerge.js `mergeOrgs`); undoing the merge deletes it, the merged org's own row is kept.
CREATE TABLE org_partners (
  customer TEXT NOT NULL,
  partner TEXT NOT NULL,
  score REAL,
  signals TEXT,
  signals_at TEXT,
  fingerprint TEXT,
  p REAL,
  checked_at TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  dismissed_by TEXT,
  dismissed_at TEXT,
  merged_from TEXT,
  PRIMARY KEY (customer, partner)
);
-- The customers a partner works for (`customersOf`); `partnersOf` reads the primary key.
CREATE INDEX org_partners_partner ON org_partners(partner);
