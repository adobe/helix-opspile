-- Thread agents by default, per ops team: on, every channel of the team that nobody switched
-- in the knowledge-base editor (agent_channels) has an agent, new channels too. Set by the
-- admin team or the team's managers; `changed_by` is the person's name, `changed_at` an ISO time.
CREATE TABLE agent_teams (
  team TEXT PRIMARY KEY,              -- a team slug
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by TEXT,
  changed_at TEXT NOT NULL
);
