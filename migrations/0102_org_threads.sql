-- The agent tool `org_threads` (src/agent/agenttools.js): a thread's agent reads the other
-- channels of its thread's customer (the org the thread is filed under), never another org's.
-- On by default: on for every ops team there is, as for every new one (`newTeams`). A team's
-- managers turn it off, for the team or one channel, on its page.
INSERT OR IGNORE INTO agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at)
  SELECT 'org_threads', 'team', slug, 1, 'migration 0102', '2026-11-25T00:00:00Z' FROM teams;
