-- The installations of the opspile GitHub App (github_apps) that the admin team allowed. The
-- app is public, so anyone can install it on their repositories; agents read only those of
-- an allowed installation.
CREATE TABLE github_installations (
  id INTEGER PRIMARY KEY,             -- GitHub's installation id
  app_id INTEGER NOT NULL,
  account TEXT,                       -- the account it is installed on, when it was allowed
  approved_by TEXT,
  approved_at TEXT NOT NULL
);
