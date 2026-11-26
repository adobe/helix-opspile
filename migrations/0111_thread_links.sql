-- Threads linked across a partner and its customers (src/threadlinks.js).
--
-- `thread_orgs`: the orgs an inbox entry (its key, `COALESCE(logical_thread, thread)`) is linked
-- with. Role `about`: the customer a partner's thread is about, picked among the customers the
-- partner works for (src/orgpartners.js `customersOf`) from the thread's facts, its text and Clef,
-- with the probability and what said so (`via`, comma-separated: facts, channel, text, clef).
-- Role `partner`: a partner whose people post in a customer's thread (`via` posters, `p` 1). Each
-- link job writes what it finds and deletes the rows it no longer finds; a row somebody dismissed
-- (`dismissed_at`) stays, and keeps the org off the thread until it is undone.
CREATE TABLE thread_orgs (
  thread TEXT NOT NULL,
  org TEXT NOT NULL,
  role TEXT NOT NULL,
  p REAL NOT NULL,
  via TEXT NOT NULL,
  found_at TEXT NOT NULL,
  dismissed_by TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (thread, org, role)
);
-- A customer's threads by the partners' threads about it (the search's customer filter).
CREATE INDEX thread_orgs_org ON thread_orgs(org, role);

-- "Possibly the same issue": two inbox entries in the channels of linked orgs (a partner and a
-- customer it works for), `a` < `b`, whose thread vectors are alike (`score`, cosine), with
-- Clef's probability that they are about the same issue (`p`, null where it was not asked), and
-- whether the facts of both name the same GitHub or aem.live owner, one only a few orgs' threads
-- name (`owner`, 1).
-- Kept once found; dismissed by a person, never shown again until it is undone.
CREATE TABLE thread_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  score REAL NOT NULL,
  p REAL,
  owner INTEGER NOT NULL DEFAULT 0,
  found_at TEXT NOT NULL,
  checked_at TEXT,
  dismissed_by TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (a, b)
);
CREATE INDEX thread_links_b ON thread_links(b);
