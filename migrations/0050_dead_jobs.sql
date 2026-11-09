-- Queue jobs that used up their retries (src/deadjobs.js), for /diag/dead to show and send out
-- again. `body` is the job as it was queued: ids and keys, never message text.
CREATE TABLE dead_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,                  -- what the log calls it: `label:<thread>`, a raw key, …
  body TEXT NOT NULL,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX dead_jobs_at ON dead_jobs(at);
