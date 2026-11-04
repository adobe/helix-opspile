-- A channel's own switch for an MCP server of its team or customer (`mcp_servers`, migration
-- 0023): it wins over the server's `enabled`, which every channel without one follows. Kept by
-- the knowledge-base editor, as the global servers' channel switches are (mcp_global_switches).
CREATE TABLE mcp_server_switches (
  server_id INTEGER NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  channel TEXT NOT NULL,              -- a channel id
  enabled INTEGER NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (server_id, channel)
);
CREATE INDEX mcp_server_switches_channel ON mcp_server_switches (channel);
