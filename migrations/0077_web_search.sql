-- The thread agents' web_search tool (src/agent/agenttools.js, src/agent/websearch.js) is on by
-- default: on for every ops team there is, as it is for every new one (`newTeams`). A team's
-- managers turn it off, for the team or one channel, in the knowledge-base editor.
INSERT OR IGNORE INTO agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at)
  SELECT 'web_search', 'team', slug, 1, 'migration 0077', '2026-11-18T00:00:00Z' FROM teams;
