-- Tools of the thread agents that are off until the admin team or a team's managers turn them
-- on, for an ops team or for one channel (src/agent/agenttools.js), as the global MCP servers
-- are (mcp_global_switches): a channel's switch wins over its team's.
--   post_message: the agent posts in its thread itself, as the opspile app, not only drafts.
--   computer: the agent's bash tool, a shell on Cloudflare Computer with files per thread.
CREATE TABLE agent_tool_switches (
  tool TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('team', 'channel')),
  target TEXT NOT NULL,               -- a team slug, or a channel id
  enabled INTEGER NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (tool, scope, target)
);
