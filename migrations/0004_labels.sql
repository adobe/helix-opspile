-- Backfill requests, thread labels and extracted facts.

-- One row per thread whose history was requested (a reply arrived before its root).
-- The row makes the request idempotent; delete it to fetch the thread again.
CREATE TABLE backfills (
  thread TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  done_at TEXT,
  messages INTEGER,
  error TEXT
);

-- Clef decisions per thread, recomputed when the thread has new activity.
CREATE TABLE labels (
  thread TEXT PRIMARY KEY,
  next_actor TEXT,                    -- us | customer | vendor | nobody
  next_actor_p REAL,
  kind TEXT,                          -- incident | security | question | request | alert | other
  kind_p REAL,
  urgency REAL,                       -- 0 (low) … 3 (critical), probability-weighted
  resolved_p REAL,                    -- probability the thread is resolved
  labeled_through TEXT NOT NULL,      -- threads.any_at the labels were computed for
  model TEXT NOT NULL,
  labeled_at TEXT NOT NULL
);

-- Facts per thread: structured tokens found by rules, and loose facts from Clairic
-- above a confidence threshold. Replaced as a whole on every relabel of a source.
CREATE TABLE facts (
  thread TEXT NOT NULL,
  source TEXT NOT NULL,               -- rule | clairic
  field TEXT NOT NULL,                -- cve, url, ticket, site, repo, problem, deadline, …
  value TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY (thread, source, field, value)
);
CREATE INDEX facts_field ON facts(field, value);

-- People mentioned in a message: by platform mention (Slack <@U…>, Teams <at>) or by
-- their full name in the text. A mention newer than the person's watermark asks for
-- their attention.
CREATE TABLE mentions (
  thread TEXT NOT NULL,
  message TEXT NOT NULL,              -- <source>:<tenant>:<channel>:<id>
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  via TEXT NOT NULL,                  -- id | name
  PRIMARY KEY (thread, message, person)
);
CREATE INDEX mentions_person ON mentions(person, at);
