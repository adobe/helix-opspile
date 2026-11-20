-- Duplicate customers (src/orgmerge.js). One org can end up under two slugs (a channel named
-- workfront-acmeco and one named aem-acme), and a merge files the one under the other: the rules'
-- org is looked up here after they are evaluated (src/rules.js `mergedOrg`), so what they file
-- under `slug` now and later is filed under `into_slug`. The row keeps what the merged org's
-- `orgs` row was, so undoing the merge brings it back.
CREATE TABLE org_merges (
  slug TEXT PRIMARY KEY,
  into_slug TEXT NOT NULL,
  name TEXT,
  type TEXT,
  icon TEXT,
  merged_by TEXT,
  merged_at TEXT NOT NULL
);
CREATE INDEX org_merges_into ON org_merges(into_slug);

-- Two orgs that may be one (a < b): Clef's probability that they are, from what it was shown
-- (`fingerprint`, a hash of it: asked again when that changes), and whether the admin team said
-- they are not (dismissed, until a request asks again).
CREATE TABLE org_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  fingerprint TEXT,
  p REAL,
  checked_at TEXT,
  dismissed_by TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (a, b)
);

-- Anyone who sees a customer may ask the admin team to merge it with another: open until the
-- admin team merges them (any way round) or declines, or whoever asked withdraws it.
CREATE TABLE org_merge_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  into_slug TEXT NOT NULL,
  note TEXT,
  requested_by TEXT NOT NULL,
  requested_name TEXT,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'declined', 'withdrawn')),
  decided_by TEXT,
  decided_at TEXT,
  reason TEXT
);
CREATE INDEX org_merge_requests_status ON org_merge_requests(status, requested_at);
