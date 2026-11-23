-- The grant a global MCP server signs in with, when it is a person's (src/agent/fluffyjaws.js):
-- a member of the admin team connects it once in the knowledge-base editor, with opspile's own
-- OAuth client (authorization code with PKCE), and every agent that has the server then acts as
-- the person who signed in. One row per global server; FluffyJaws is the only one so far.
CREATE TABLE mcp_global_grants (
  server TEXT PRIMARY KEY,            -- the global server: 'fluffyjaws'
  -- Sealed with TOKEN_KEY, JSON: `{ access_token, refresh_token, scope, token_type }`.
  tokens TEXT,
  -- A sign-in under way, sealed (who started it, until when, the PKCE verifier, the knowledge
  -- base to go back to), and the SHA-256 of its `state`, which finds it when the browser is back.
  pending TEXT,
  pending_state TEXT,
  acts_as TEXT,                       -- whose identity the agents use: the sign-in's email or login
  acts_as_name TEXT,                  -- and name, as the identity provider says them
  connected_by TEXT,                  -- the member of the admin team who connected it
  connected_at TEXT,
  expires_at TEXT,                    -- the access token's expiry
  refreshed_at TEXT,                  -- the last time the tokens were refreshed
  refresh_lock TEXT,                  -- until when one agent refreshes them
  error TEXT                          -- why the grant stopped working
);
CREATE INDEX mcp_global_grants_state ON mcp_global_grants (pending_state);
