-- Pile 4 (second part): the thread index and read state.

-- One row per platform thread. Derived from `messages`, so it can be rebuilt.
CREATE TABLE threads (
  thread TEXT PRIMARY KEY,            -- slack:<ent>:<channel>:<root> / teams:<tenant>:<team>:<channel>:<root>
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  org TEXT NOT NULL,
  team TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel',
  channel_name TEXT,
  title TEXT,                         -- subject or first line of the root message
  path TEXT NOT NULL,                 -- pile-2 folder of the thread
  root_at TEXT,
  last_at TEXT,                       -- last message by a person (bots and system do not count)
  last_id TEXT,
  last_author TEXT,
  last_staff INTEGER,                 -- 1 if a staff member spoke last, 0 if a customer
  any_at TEXT,                        -- last message of any kind (for alert channels)
  messages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX threads_team ON threads(team, last_at DESC);
CREATE INDEX threads_org ON threads(org, last_at DESC);

-- One row per pile-2 message file, to find a message's thread (reactions) and to derive
-- the thread row in any order.
CREATE TABLE messages (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread TEXT NOT NULL,
  at TEXT NOT NULL,
  author TEXT,
  person INTEGER,                     -- the author, if they are a known person
  staff INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 0, -- 1 for people, 0 for bots and system messages
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, tenant, channel_id, id)
);
CREATE INDEX messages_thread ON messages(thread, at);

-- Read state: person P has read thread T up to message time `read_at`.
CREATE TABLE watermarks (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  thread TEXT NOT NULL,
  read_at TEXT NOT NULL,
  via TEXT NOT NULL,                  -- post | react | open
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person, thread)
);
CREATE INDEX watermarks_thread ON watermarks(thread);
