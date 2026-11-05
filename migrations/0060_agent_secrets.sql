-- Secrets of the thread agents' computers (the `computer` tool), per ops team (`scope` 'team')
-- and per customer, partner or vendor (`scope` 'org'), `slug` naming which: API keys and tokens
-- the agents use from their shell without ever holding them. The shell has `$NAME`, a
-- placeholder; the Worker's SecretGateway, which every request of the shell goes through,
-- puts the value in its place, only in HTTPS requests to `hosts` (src/agent/secrets.js).
-- Maintained in the knowledge-base editor, in the Computer tool, by whoever edits the team's or
-- the customer's knowledge base. A team's secret wins over the customer's of the same name.
CREATE TABLE agent_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('team', 'org')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,                 -- the shell's variable: [A-Z][A-Z0-9_]*
  value TEXT NOT NULL,                -- sealed with TOKEN_KEY; never shown again
  hosts TEXT NOT NULL,                -- the hosts it is sent to, comma-separated: a.example.com, *.example.com
  description TEXT,                   -- what it is for; the agents are told
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, slug, name)
);
CREATE INDEX agent_secrets_target ON agent_secrets (scope, slug);
