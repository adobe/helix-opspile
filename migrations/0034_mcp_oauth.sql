-- MCP servers that sign in with OAuth (`auth` 'oauth') instead of sending request headers: a
-- person who manages the server connects it once in the knowledge-base editor (authorization
-- code with PKCE, the client registered at the server on its own or given), and the agents
-- use that grant, refreshed as it expires (src/agent/mcpoauth.js). The agents act as whoever
-- connected it, with what that person may do at the server.
ALTER TABLE mcp_servers ADD COLUMN auth TEXT NOT NULL DEFAULT 'headers';
-- Sealed with TOKEN_KEY, JSON: `{ config, server, client, tokens }`, the client id, secret and
-- scope staff gave (`config`), the authorization server found, the registered client, the tokens.
ALTER TABLE mcp_servers ADD COLUMN oauth TEXT;
-- A sign-in under way, sealed (who started it, until when, the PKCE verifier), and the SHA-256
-- of its `state`, which finds the server when the browser comes back.
ALTER TABLE mcp_servers ADD COLUMN oauth_pending TEXT;
ALTER TABLE mcp_servers ADD COLUMN oauth_state TEXT;
ALTER TABLE mcp_servers ADD COLUMN oauth_by TEXT;           -- who connected it; the agents act as them
ALTER TABLE mcp_servers ADD COLUMN oauth_at TEXT;           -- when
ALTER TABLE mcp_servers ADD COLUMN oauth_expires_at TEXT;   -- the access token's expiry, if it said
ALTER TABLE mcp_servers ADD COLUMN oauth_refreshed_at TEXT; -- the last time the tokens were refreshed
ALTER TABLE mcp_servers ADD COLUMN oauth_lock TEXT;         -- until when one agent refreshes them
ALTER TABLE mcp_servers ADD COLUMN oauth_error TEXT;        -- why the grant stopped working
CREATE INDEX mcp_servers_oauth_state ON mcp_servers (oauth_state);
