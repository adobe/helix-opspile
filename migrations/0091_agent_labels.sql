-- What a thread's agent says of its thread (src/agentlabels.js), with the agent tools `resolve`
-- (resolve_thread) and `label` (label_thread) of src/agent/agenttools.js. One row per platform
-- thread and question, the latest the agent said; nothing is posted on the platform.
-- - `resolved` (value `yes`): counts as a staff ✅ on the root (src/resolve.js `resolutionFacts`),
--   from `at`, until a customer writes again; resolve_thread's `undo`, and the inbox's ✅ button
--   (`POST /api/resolve` with `undo`), delete it.
-- - `kind`: replaces Clef's until the agent says otherwise.
-- - `urgency` (0 to 3) and `next_actor`: replace Clef's until a person posts after `at`.
-- A person's label review of the current label (label_reviews) wins over all of them.
CREATE TABLE agent_labels (
  thread TEXT NOT NULL,
  question TEXT NOT NULL,             -- resolved | kind | urgency | next_actor
  value TEXT NOT NULL,
  reason TEXT,                        -- the agent's, in a sentence
  at TEXT NOT NULL,
  PRIMARY KEY (thread, question)
);

-- Both tools are on by default: on for every ops team there is, as for every new one
-- (`newTeams`). A team's managers turn them off, for the team or one channel, on its page.
INSERT OR IGNORE INTO agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at)
  SELECT 'resolve', 'team', slug, 1, 'migration 0091', '2026-11-20T00:00:00Z' FROM teams;
INSERT OR IGNORE INTO agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at)
  SELECT 'label', 'team', slug, 1, 'migration 0091', '2026-11-20T00:00:00Z' FROM teams;
