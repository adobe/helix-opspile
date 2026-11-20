-- The team wizard (src/teamwizard.js): the admin team's channels grouped by the prefix of their
-- names, each group a team it might make. A group the admin team does not want as a team is
-- dismissed here, with how many channels it had then: it is offered again once it has more.
CREATE TABLE team_prefix_dismissals (
  prefix TEXT PRIMARY KEY,
  channels INTEGER NOT NULL,
  dismissed_by TEXT,
  dismissed_at TEXT NOT NULL
);
