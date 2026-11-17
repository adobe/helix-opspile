-- The customer portal's own database (src/portal/, docs/ARCHITECTURE.md "Customer portal"): the
-- portal is a platform, as Slack is, and this is its record. The inbox reads it through the
-- events below, never this database.

-- Everyone who writes here: customers by their work mail address, the Adobe people who answer
-- from the inbox (`staff`), and the inbox's app (`bot`, without a mail address). The id is a
-- hash of the address (src/portal/ids.js), so the inbox can name its own people.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  domain TEXT,                              -- the mail domain
  kind TEXT NOT NULL DEFAULT 'customer',    -- customer | staff | bot
  created_at TEXT NOT NULL
);

-- A lobby: one customer, by its mail domain. Its people pick what they use of Adobe's and ask
-- for a channel (`requested`); the inbox's admins open one (`open`) or decline (`declined`).
CREATE TABLE lobbies (
  domain TEXT PRIMARY KEY,
  company TEXT,                             -- what they call themselves
  tech TEXT NOT NULL DEFAULT '[]',          -- JSON array of technology ids (`tech`)
  note TEXT,                                -- what they need, in their words
  status TEXT NOT NULL DEFAULT 'draft',     -- draft | requested | open | declined
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  requested_by TEXT,
  requested_at TEXT,
  decided_at TEXT,
  reason TEXT,                              -- why it was declined
  updated_at TEXT NOT NULL
);

-- Who is in a lobby: its founder (the first of the domain to sign in) and whoever a member
-- invited, from the same domain. `joined_at` is their first sign-in.
CREATE TABLE members (
  lobby TEXT NOT NULL REFERENCES lobbies(domain) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id),
  invited_by TEXT,
  invited_at TEXT NOT NULL,
  joined_at TEXT,
  PRIMARY KEY (lobby, user)
);
CREATE INDEX members_user ON members(user);

-- A lobby's channels (most have one): every member of the lobby is in all of them.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  lobby TEXT NOT NULL REFERENCES lobbies(domain) ON DELETE CASCADE,
  name TEXT NOT NULL,
  topic TEXT,
  created_by TEXT,                          -- the mail address of who opened it, in the inbox
  created_at TEXT NOT NULL
);
CREATE INDEX channels_lobby ON channels(lobby);

-- Messages, as markdown. A thread is its first message (`root = id`) and the replies to it.
-- `rev` counts a message's changes (an edit, its deletion): the inbox takes the higher one.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  root TEXT NOT NULL,
  author TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_thread ON messages(channel, root, id);

CREATE TABLE reactions (
  message TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (message, user, emoji)
);

-- How far each customer has read each thread.
CREATE TABLE reads (
  user TEXT NOT NULL,
  root TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (user, root)
);

-- The outbox: what happened here, for the inbox, in order. An event is written with what it
-- tells of, then delivered (`delivered_at`); one that could not be is tried again by the cron.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX events_pending ON events(seq) WHERE delivered_at IS NULL;

-- The technologies a lobby picks from: the inbox's tech stack, as it last told (`meta`,
-- `tech_at`).
CREATE TABLE tech (
  tech TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  product TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
