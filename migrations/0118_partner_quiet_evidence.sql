-- Quiet partners, and the evidence a partner request carries (src/orgpartners.js,
-- src/partnerrequests.js).
--
-- A pair whose partner's people posted nothing in the customer's threads for 90 days while the
-- customer's went on is quiet (`quiet_since`: the last sign of them, written by every sync; null
-- when it is not quiet). Quiet is not ended: Clef files an `end` request only when it also judges,
-- from the partner's last posts and the customer's recent threads, that the partnership ended
-- (`ended_p`, with the `ended_fingerprint` of what it was shown and when, `ended_checked_at`). A
-- thread's agent that sees the two still working together records it (`seen_at`, `seen_by`),
-- which counts as a sign of them: the pair is not quiet until it is quiet again after that.
ALTER TABLE org_partners ADD COLUMN quiet_since TEXT;
ALTER TABLE org_partners ADD COLUMN seen_at TEXT;
ALTER TABLE org_partners ADD COLUMN seen_by TEXT;
ALTER TABLE org_partners ADD COLUMN ended_p REAL;
ALTER TABLE org_partners ADD COLUMN ended_fingerprint TEXT;
ALTER TABLE org_partners ADD COLUMN ended_checked_at TEXT;

-- A request may also ask the admin team to look at a pair that seems wrong or uncertain
-- (`review`), beside `link` and `end`. SQLite cannot change a CHECK, so the table is made again,
-- as in 0113.
CREATE TABLE org_partner_requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  partner TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('link', 'end', 'review')),
  since TEXT,
  until TEXT,
  note TEXT,
  thread TEXT,
  fingerprint TEXT,
  requested_by TEXT NOT NULL,
  requested_name TEXT,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'ended', 'dismissed', 'declined', 'withdrawn')),
  decided_by TEXT,
  decided_at TEXT,
  reason TEXT
);
INSERT INTO org_partner_requests_new (id, customer, partner, action, since, until, note, thread,
    fingerprint, requested_by, requested_name, requested_at, status, decided_by, decided_at, reason)
  SELECT id, customer, partner, action, since, until, note, thread, fingerprint, requested_by,
    requested_name, requested_at, status, decided_by, decided_at, reason FROM org_partner_requests;
DROP TABLE org_partner_requests;
ALTER TABLE org_partner_requests_new RENAME TO org_partner_requests;
CREATE UNIQUE INDEX org_partner_requests_open ON org_partner_requests(customer, partner, action)
  WHERE status = 'open';
CREATE INDEX org_partner_requests_status ON org_partner_requests(status, requested_at);

-- What says so: each item a thread or a message of one (`thread`, its key; `message`, its id in
-- the thread, or null for the thread as a whole; `link`, where people open it), with why, in the
-- words of whoever added it (`why`), and who (`added_by`: an address, `agent` or `clef`;
-- `added_name`). Of a request (`request`), or of the pair alone (`request` null: an agent's that
-- the two still work together, which withdraws Clef's open `end` and makes the pair not quiet).
CREATE TABLE org_partner_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  partner TEXT NOT NULL,
  request INTEGER,
  kind TEXT NOT NULL DEFAULT 'evidence' CHECK (kind IN ('evidence', 'active')),
  thread TEXT,
  message TEXT,
  link TEXT,
  why TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_name TEXT,
  added_at TEXT NOT NULL
);
CREATE INDEX org_partner_evidence_request ON org_partner_evidence(request);
CREATE INDEX org_partner_evidence_pair ON org_partner_evidence(customer, partner, added_at);
