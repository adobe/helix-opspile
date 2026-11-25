-- A customer's people with two accounts that no mail address ties together (src/accountpairs.js):
-- named the same, with different mail addresses (the agency's and the customer's, a new job, a
-- second address). The admin team says whether they are one person (same = 1) or two people
-- (same = 0), in its inbox. The customers' overviews and the topic map count one person's
-- accounts as one, as they do accounts with one mail address. a < b, both identity keys.
CREATE TABLE account_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  same INTEGER NOT NULL,
  decided_by TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
