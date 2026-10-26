-- Global MCP servers: built into opspile (src/agent/globals.js) rather than added per team or
-- customer, and off until the admin team or a team's managers turn them on, for an ops team
-- or for one channel. A channel's switch wins over its team's.
CREATE TABLE mcp_global_switches (
  server TEXT NOT NULL,               -- the global server: 'browser', 'github'
  scope TEXT NOT NULL CHECK (scope IN ('team', 'channel')),
  target TEXT NOT NULL,               -- a team slug, or a channel id
  enabled INTEGER NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (server, scope, target)
);

-- What the last check of a global server found (its tools, as mcp_servers.tools), so that an
-- agent does not start a browser, or mint a token, only to list them.
CREATE TABLE mcp_global_tools (
  server TEXT PRIMARY KEY,
  tools TEXT,
  instructions TEXT,
  checked_at TEXT,
  check_error TEXT
);

-- The GitHub App the global github server reads with, created from the knowledge-base editor
-- (GitHub's manifest flow) and installed on the repositories it may read. The newest row is
-- the one in use. Its private key and secrets are sealed with TOKEN_KEY.
CREATE TABLE github_apps (
  id INTEGER PRIMARY KEY,             -- GitHub's app id
  slug TEXT NOT NULL,
  name TEXT,
  owner TEXT,                         -- the account that owns the app
  html_url TEXT,
  client_id TEXT,
  private_key TEXT NOT NULL,          -- PKCS#8 PEM, sealed
  client_secret TEXT,                 -- sealed
  webhook_secret TEXT,                -- sealed
  created_by TEXT,
  created_at TEXT NOT NULL
);
