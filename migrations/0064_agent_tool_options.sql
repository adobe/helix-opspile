-- Options of the thread agents' switchable tools (src/agent/agenttools.js), per ops team. So far
-- one, of the Computer tool: `runtime`, the shell its agents get (src/agent/kernel.js),
-- 'just-bash' or 'slicc-kernel'. A team without a row has the default, just-bash.
CREATE TABLE agent_tool_options (
  tool TEXT NOT NULL,
  team TEXT NOT NULL,                 -- a team slug
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (tool, team, name)
);
