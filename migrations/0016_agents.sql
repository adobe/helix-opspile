-- Thread agents: what they may read besides the knowledge bases. (Their drafts are saved as
-- the person `agent@opspile.invalid`, which the Worker creates when it first needs it.)

-- GitHub repositories an agent may read. `scope` is 'all' (every agent), 'team' or 'org'
-- (agents of threads of that ops team or customer, `slug`). Data like the rules: add rows by
-- hand. Only this public repository is listed here.
CREATE TABLE agent_repos (
  scope TEXT NOT NULL CHECK (scope IN ('all', 'team', 'org')),
  slug TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,                  -- https://github.com/<owner>/<name>
  note TEXT,
  PRIMARY KEY (scope, slug, url)
);
INSERT INTO agent_repos (scope, slug, url, note)
  VALUES ('all', '', 'https://github.com/adobe/helix-opspile', 'opspile itself');

-- The Artifacts mirror of each listed GitHub repository, refreshed by the cron: `repo` is
-- the mirror agents read, `pending` a newer import that is promoted once it is readable.
CREATE TABLE repo_mirrors (
  url TEXT PRIMARY KEY,
  repo TEXT,
  pending TEXT,
  pending_at TEXT,
  mirrored_at TEXT
);

