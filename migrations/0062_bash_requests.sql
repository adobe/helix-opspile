-- Commands a thread agent asks a person to run on its computer (the agent's `request_bash`,
-- src/bashrequests.js): the command, why, how long it may run, until when a person may run it,
-- and the variables the person fills in (names and what they are for; never a value: values go
-- from the page to the shell for the one run and are kept nowhere). `status` is the lifecycle
-- (docs/STATE-MACHINES.md): a person runs it (pending -> running -> done, timeout or failed) or
-- denies it, or its deadline passes (expired). Every transition names the status it starts from.
CREATE TABLE bash_requests (
  id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,               -- the inbox entry's key: the agent that asked, whose computer runs it
  command TEXT NOT NULL,
  reason TEXT NOT NULL,               -- the agent's, for the person who decides
  env TEXT NOT NULL DEFAULT '[]',     -- [{ name, description }]: what the person fills in
  timeout INTEGER NOT NULL,           -- seconds the command may run
  deadline TEXT NOT NULL,             -- until when a person may run it
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'timeout', 'failed', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  decided_by INTEGER,                 -- the person who ran or denied it
  decided_at TEXT,
  finished_at TEXT,                   -- when it ended, whichever way
  exit_code INTEGER,                  -- done: the command's
  error TEXT,                         -- failed: why
  told_at TEXT                        -- when the agent was told how it ended
);
CREATE INDEX bash_requests_thread ON bash_requests (thread, status);
