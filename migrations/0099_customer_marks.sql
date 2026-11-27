-- A person's marks on the customers of their personal view (src/standing.js), one row per
-- person and customer, kept as the latest of each (STATE-MACHINES.md, "Customer marks"):
-- - `unstarred_at`: taken out of their regulars (the star in the customer column). Their
--   messages there before it no longer count toward their regulars.
-- - `muted_at`: muted. Before it, their messages and the mentions of them there no longer put
--   its channels in their personal view, nor do what they follow put its threads there: a channel
--   comes back once they post or are mentioned in it again, a followed thread once it has activity
--   again. Their messages before it no longer count toward their regulars either.
-- Neither changes what they may see or work: that stays src/shares.js's.
CREATE TABLE customer_marks (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  org TEXT NOT NULL,
  unstarred_at TEXT,
  muted_at TEXT,
  PRIMARY KEY (person, org)
);
