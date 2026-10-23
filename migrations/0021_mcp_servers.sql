-- MCP servers the thread agents may use, through code mode: per ops team (`scope` 'team') and
-- per customer, partner or vendor (`scope` 'org'), `slug` naming which. Maintained in the admin
-- pages: the admin team for every team and org, team managers for their teams. An agent gets
-- the enabled servers of its thread's team and org.
CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('team', 'org')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,                 -- scripts call its tools as tools.mcp__<name>__<tool>
  url TEXT NOT NULL,                  -- https:// Streamable HTTP endpoint
  description TEXT,                   -- what it is for; the agents are told
  headers TEXT,                       -- request headers (credentials): JSON sealed with TOKEN_KEY
  header_names TEXT,                  -- their names, comma-separated; the values are never shown
  allow TEXT,                         -- tool names the agents may call, comma-separated; empty: all
  enabled INTEGER NOT NULL DEFAULT 1,
  tools TEXT,                         -- the tools the last check found: JSON [{ name, description }]
  checked_at TEXT,
  check_error TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, slug, name)
);
CREATE INDEX mcp_servers_target ON mcp_servers (scope, slug);
