-- OAuth for MCP clients (/mcp): self-registered clients, single-use codes and tokens.
-- Codes and tokens are stored as their SHA-256 only.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                 -- as the client named itself
  uri TEXT,
  redirect_uris TEXT NOT NULL,        -- JSON array
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,
  client TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,            -- PKCE S256
  scope TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- access | refresh
  client TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  scope TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_tokens_person ON oauth_tokens(person);
