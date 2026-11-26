-- Partner links over time, and the requests that decide them (src/orgpartners.js,
-- src/partnerrequests.js).
--
-- A pair's span as the threads show it: the first and last post of the partner's people in the
-- customer's threads (`first_at`, `last_at`, written by every sync; the inbox's history is a
-- floor). And the admin team's dates: `since` (from when the partner works for the customer, given
-- on confirming; else `first_at` is shown) and `until` (a former partner: it worked for the
-- customer until then, `ended_by` and `ended_at` saying who said so, and when). A confirmed pair
-- with `until` is a former partner; confirming it again clears `until`. A dismissed one never was.
ALTER TABLE org_partners ADD COLUMN first_at TEXT;
ALTER TABLE org_partners ADD COLUMN last_at TEXT;
ALTER TABLE org_partners ADD COLUMN since TEXT;
ALTER TABLE org_partners ADD COLUMN until TEXT;
ALTER TABLE org_partners ADD COLUMN ended_by TEXT;
ALTER TABLE org_partners ADD COLUMN ended_at TEXT;

-- A request to decide a pair, a thread of the admin team's inbox (`request:partner:<id>`): that
-- the partner works for the customer (`link`, from `since`), or no longer does (`end`, until
-- `until`). Asked by a person (`requested_by` their address), a thread's agent (`agent`, on its
-- own or for the person in its sidebar, whose address it is then; `thread` the thread it read it
-- in), or Clef (`clef`: a likely pair nobody decided, a confirmed one whose people stopped
-- posting, with the `fingerprint` of what it found, so that a declined one is not asked again on
-- the same evidence). Open until the admin team decides the pair (`confirmed`, `ended`,
-- `dismissed`), declines the request (`declined`, the pair left as it is), or whoever asked takes it
-- back (`withdrawn`; Clef too, once the pair is no longer likely). One open request per pair and
-- action.
CREATE TABLE org_partner_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  partner TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('link', 'end')),
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
CREATE UNIQUE INDEX org_partner_requests_open ON org_partner_requests(customer, partner, action)
  WHERE status = 'open';
CREATE INDEX org_partner_requests_status ON org_partner_requests(status, requested_at);
