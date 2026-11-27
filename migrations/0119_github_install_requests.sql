-- The admin team is asked to install the opspile GitHub App (github_apps) on one of Adobe's
-- GitHub organizations (ADOBE_GITHUB_ORGS, a Worker var: never a customer's or a partner's) once
-- enough recent threads name its repositories and sites (`repo` and `site` facts) and no allowed
-- installation reads it (github_installations); src/githubrequests.js, a thread of the admin
-- team's inbox (`request:github:<id>`).
--
-- What the cron's sync found when it last counted: the threads (inbox entries) of the window that
-- name the organization, its repositories and sites (`repos`, JSON `[{ repo, threads }]`, the
-- most named first, and `repo_count` of them all), and the latest of those threads (`last_at`).
-- Open until an installation for the account is allowed (`installed`, by whoever allowed it),
-- the admin team dismisses it (`dismissed`: not asked again before `quiet_until`), or the sync
-- takes it back (`withdrawn`, with why in `reason`: the organization is no longer listed as
-- Adobe's, or no thread of the window names it any more). One open request per account.
CREATE TABLE github_install_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  threads INTEGER NOT NULL,
  repo_count INTEGER NOT NULL,
  repos TEXT NOT NULL DEFAULT '[]',
  last_at TEXT,
  counted_at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'installed', 'dismissed', 'withdrawn')),
  decided_by TEXT,
  decided_at TEXT,
  reason TEXT,
  quiet_until TEXT
);
CREATE UNIQUE INDEX github_install_requests_open ON github_install_requests(account)
  WHERE status = 'open';
CREATE INDEX github_install_requests_account ON github_install_requests(account, status);
