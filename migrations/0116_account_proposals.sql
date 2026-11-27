-- What a thread agent proposes about an account that is staff by itself and that nobody linked to
-- a person (src/accountlinks.js, the agent's `request_account_link`): that it is the Adobe person
-- `person`'s. A proposal links nothing: it is a one-click action in the account's thread of the
-- admin team's inbox, which the admin team confirms (`PUT /api/admin/accounts`, which deletes the
-- account's open proposals) or declines (`declined_at`, `declined_by`: kept, so the same person is
-- not proposed for the account again, nor suggested). `by_email` and `by_name`: the person in the
-- agent's sidebar it asked for; `by_email` NULL, the agent on its own (`by_name` how it is named).
-- `account` is the identity key (`<source>:<tenant>:<user id>`, as `messages.author_key`).
CREATE TABLE account_proposals (
  account TEXT NOT NULL,
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  thread TEXT,
  by_email TEXT,
  by_name TEXT,
  at TEXT NOT NULL,
  declined_at TEXT,
  declined_by TEXT,
  PRIMARY KEY (account, person)
);
