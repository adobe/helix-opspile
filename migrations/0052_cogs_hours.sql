-- COGS by the hour (src/cogs/rollup.js): the flow of `cogs_usage` (migration 0051) per UTC hour, for
-- the dashboard's chart of a short period (src/cogs/report.js). From the sources that know the
-- hour, `meter` and `account`; stock and `volume` stay daily. Kept for the last HOUR_DAYS days.
CREATE TABLE cogs_hours (
  day TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
  hour INTEGER NOT NULL,              -- 0–23, UTC
  source TEXT NOT NULL,               -- meter | account
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  org TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, hour, source, service, metric, detail, org, team)
) WITHOUT ROWID;
