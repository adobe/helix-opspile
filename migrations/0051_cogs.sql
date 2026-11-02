-- COGS (src/cogs/): what each day used of the services opspile pays for, per customer (`org`,
-- '' when shared), team, service, metric and detail (a model, a bucket), from three sources:
-- `meter` (what the Worker counted), `account` (Cloudflare's analytics of opspile's resources)
-- and `d1` (messages and threads, and what only D1 knows is kept). Quantities, never content.
-- The cron rolls up each day again until it is over (src/cogs/rollup.js).
CREATE TABLE cogs_usage (
  day TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
  source TEXT NOT NULL,               -- meter | account | d1
  service TEXT NOT NULL,              -- src/cogs/prices.js, or `volume`
  metric TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  org TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, source, service, metric, detail, org, team)
) WITHOUT ROWID;

-- What each agent keeps in its Durable Object's SQLite, as it last said (at most once a day).
CREATE TABLE cogs_objects (
  name TEXT PRIMARY KEY,              -- the agent's name: an inbox entry's key, or kb:<team>:<org>
  org TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL,
  at TEXT NOT NULL
);

-- The day's messages and new threads, for the rollup.
CREATE INDEX messages_at ON messages(at);
CREATE INDEX threads_root_at ON threads(root_at);
