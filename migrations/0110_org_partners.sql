-- Which customers each partner works for (src/orgpartners.js). A pair of a customer and a
-- partner (an org of type `partner`) that may work together: its signals as last found (`signals`,
-- JSON `[{ kind, weight, n, text }]`, and `score`, their weights added), Clef's probability that
-- the partner works for the customer from what it was shown (`fingerprint`, a hash of it: asked
-- again when that changes), and the admin team's decision, confirmed or dismissed (one at a time).
-- A row nobody decided goes once the pair is no candidate any more; a decided one stays.
-- `merged_from`: the row's decision is a merged org's, copied to the org it went into by the merge
-- (src/orgmerge.js `mergeOrgs`), the merged org's own row kept. `merged_new` is 1 when the merge
-- added the row, 0 when it wrote the decision on a row the org kept had (a candidate nobody
-- decided). Undoing the merge deletes the rows it added and clears the decision it wrote on the
-- others, which keep their signals and Clef's verdict. A decision by hand clears both.
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
  merged_new INTEGER,
  PRIMARY KEY (customer, partner)
);
-- The customers a partner works for (`customersOf`); `partnersOf` reads the primary key.
CREATE INDEX org_partners_partner ON org_partners(partner);
