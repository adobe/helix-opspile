-- What thread agents watch (src/agent/watches.js, watch_related): another thread of the inbox, or a
-- GitHub issue or pull request, whose changes wake the watching agent with an update. `watcher` is
-- the watching agent's inbox entry key; `target` an inbox entry key (`kind` 'thread') or
-- `<owner>/<repo>#<number>` (`kind` 'github'). `seen` is how far the agent was told: the latest
-- message's time of the watched thread, or the GitHub item's `updated_at`; `state` (GitHub) what
-- it was then, as JSON. A watch ends when the agent unwatches it or at `expires_at`.
CREATE TABLE agent_watches (
  id TEXT PRIMARY KEY,
  watcher TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'github')),
  target TEXT NOT NULL,
  url TEXT NOT NULL,
  why TEXT NOT NULL,
  installation INTEGER,            -- github: the opspile GitHub App's installation it reads with
  seen TEXT,
  state TEXT,
  set_at TEXT NOT NULL,
  set_in TEXT NOT NULL DEFAULT 'thread',  -- 'sidebar': a person asked for it there
  checked_at TEXT,                 -- github: when it was last polled
  poll_after TEXT,                 -- github: when it is polled next (slower when quiet or limited)
  etag TEXT,                       -- github: the item's ETag, for a conditional request
  changed_at TEXT,                 -- github: when its updated_at last moved
  failures INTEGER NOT NULL DEFAULT 0, -- github: polls that failed in a row
  expires_at TEXT NOT NULL
);
CREATE INDEX agent_watches_target ON agent_watches(target);
CREATE INDEX agent_watches_watcher ON agent_watches(watcher);
CREATE INDEX agent_watches_poll ON agent_watches(kind, poll_after);
