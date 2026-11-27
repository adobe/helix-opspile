-- Operator-owned enrollment. Hosts hold private keys; only their public JWKS lives here.
CREATE TABLE integration_hosts (
  id TEXT PRIMARY KEY NOT NULL,
  service_id TEXT UNIQUE NOT NULL,
  issuer TEXT NOT NULL,
  jwks TEXT NOT NULL,
  scopes TEXT NOT NULL, -- JSON array, opt in per operation
  topics TEXT NOT NULL DEFAULT '[]'
);

-- Reserve an opaque channel ID at enrollment so the inbox can file it BEFORE admitting users.
-- The actual lobby, channel and its inbox event are created lazily, never on a GET.
CREATE TABLE integration_customers (
  channel TEXT PRIMARY KEY NOT NULL DEFAULT ('c' || lower(hex(randomblob(6))))
    CHECK (length(channel) = 13 AND channel GLOB 'c*' AND channel NOT GLOB '*[^a-z0-9]*'),
  host TEXT NOT NULL REFERENCES integration_hosts(id),
  tenant TEXT NOT NULL,
  customer TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  pruned_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host, tenant), UNIQUE (host, customer)
);
-- Never repoint an enrolled customer's history. Disable and enroll a new mapping instead.
CREATE TRIGGER integration_fixed_customer BEFORE UPDATE OF channel, host, tenant, customer
ON integration_customers BEGIN SELECT RAISE(ABORT, 'immutable customer mapping'); END;
CREATE TRIGGER integration_reserve BEFORE INSERT ON integration_customers
WHEN EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel)
  OR EXISTS (SELECT 1 FROM lobbies WHERE domain = NEW.channel || '.embed.invalid')
BEGIN SELECT RAISE(ABORT, 'channel in use'); END;

-- Only these actors can be enrolled. The plain INSERT into users cannot claim an existing
-- account. Optional email aliases are unique *here*, not in the global email-keyed user list.
CREATE TABLE integration_actors (
  channel TEXT NOT NULL REFERENCES integration_customers(channel),
  actor TEXT NOT NULL DEFAULT ('p' || lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  verified_email TEXT CHECK (verified_email = lower(trim(verified_email))),
  PRIMARY KEY (channel, actor), UNIQUE (channel, verified_email)
);
CREATE TRIGGER integration_actor AFTER INSERT ON integration_actors BEGIN
  INSERT INTO users(id, name, kind, created_at) VALUES (NEW.actor, NEW.name, 'customer',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TABLE integration_members (
  channel TEXT NOT NULL, subject TEXT NOT NULL, actor TEXT NOT NULL UNIQUE,
  cursor_key TEXT NOT NULL DEFAULT (lower(hex(randomblob(32)))),
  active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (channel, subject),
  FOREIGN KEY (channel, actor) REFERENCES integration_actors(channel, actor)
);
CREATE TRIGGER integration_fixed_member BEFORE UPDATE OF channel, subject, actor ON integration_members
BEGIN SELECT RAISE(ABORT, 'immutable member mapping'); END;
CREATE TABLE integration_nonces (
  host TEXT NOT NULL, channel TEXT NOT NULL, actor TEXT NOT NULL,
  jti TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (host, jti)
);
CREATE INDEX integration_nonces_at ON integration_nonces(used_at);
CREATE INDEX integration_nonces_host ON integration_nonces(host, used_at);
CREATE INDEX integration_nonces_channel ON integration_nonces(channel, used_at);
CREATE INDEX integration_nonces_actor ON integration_nonces(actor, used_at);
CREATE TABLE integration_receipts (
  channel TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
  digest TEXT NOT NULL, message TEXT NOT NULL, channel_name TEXT NOT NULL,
  PRIMARY KEY (channel, actor, operation, key)
);

-- Public invalidations, not the internal delivery queue. Triggers include staff mutations via
-- PortalPlatform in the same transaction; a resend of an inbox event changes no public data.
CREATE TABLE integration_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, root TEXT NOT NULL,
  reason TEXT NOT NULL, viewer TEXT, at INTEGER NOT NULL DEFAULT (unixepoch()),
  event_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
);
CREATE INDEX integration_changes_channel ON integration_changes(channel, seq);
CREATE INDEX integration_changes_at ON integration_changes(at);
CREATE TRIGGER integration_pruned AFTER DELETE ON integration_changes BEGIN
  UPDATE integration_customers SET pruned_seq = max(pruned_seq, OLD.seq) WHERE channel = OLD.channel;
END;

CREATE UNIQUE INDEX integration_single_channel ON channels(lobby) WHERE lobby GLOB '*.embed.invalid';
CREATE TRIGGER integration_channel AFTER INSERT ON channels WHEN NEW.lobby GLOB '*.embed.invalid'
BEGIN
  SELECT CASE WHEN NEW.lobby != NEW.id || '.embed.invalid' OR NOT EXISTS
    (SELECT 1 FROM integration_customers WHERE channel = NEW.id)
    THEN RAISE(ABORT, 'unregistered managed channel') END;
  INSERT INTO events(body, at) VALUES (json_object('type','channel','domain',NEW.lobby,
    'channel',json_object('id',NEW.id,'name',NEW.name)), NEW.created_at);
END;
CREATE TRIGGER integration_reserved_id BEFORE INSERT ON channels
WHEN NEW.lobby NOT GLOB '*.embed.invalid' AND EXISTS
  (SELECT 1 FROM integration_customers WHERE channel = NEW.id)
BEGIN SELECT RAISE(ABORT, 'reserved channel id'); END;

ALTER TABLE messages ADD COLUMN position INTEGER;
CREATE TRIGGER integration_post AFTER INSERT ON messages
WHEN EXISTS (SELECT 1 FROM integration_customers WHERE channel = NEW.channel)
BEGIN
  INSERT INTO integration_changes(channel, root, reason) VALUES (NEW.channel, NEW.root,
    CASE WHEN NEW.id = NEW.root THEN 'created' ELSE 'reply' END);
  UPDATE messages SET position = last_insert_rowid() WHERE id = NEW.id;
END;
CREATE TRIGGER integration_edit AFTER UPDATE OF rev ON messages
WHEN EXISTS (SELECT 1 FROM integration_customers WHERE channel = NEW.channel)
BEGIN
  INSERT INTO integration_changes(channel, root, reason) VALUES (NEW.channel, NEW.root,
    CASE WHEN NEW.deleted_at IS NULL THEN 'edited' ELSE 'deleted' END);
END;
CREATE VIEW integration_roots AS SELECT m.id, m.channel FROM messages m
  JOIN integration_customers c ON m.channel = c.channel WHERE m.id = m.root;
CREATE TRIGGER integration_resolve AFTER INSERT ON reactions
WHEN NEW.emoji IN ('✅','✔️') AND (SELECT kind FROM users WHERE id = NEW.user) = 'staff'
BEGIN
  INSERT INTO integration_changes(channel, root, reason)
    SELECT channel, id, 'resolution' FROM integration_roots WHERE id = NEW.message;
END;
CREATE TRIGGER integration_unresolve AFTER DELETE ON reactions
WHEN OLD.emoji IN ('✅','✔️') AND (SELECT kind FROM users WHERE id = OLD.user) = 'staff'
BEGIN
  INSERT INTO integration_changes(channel, root, reason)
    SELECT channel, id, 'resolution' FROM integration_roots WHERE id = OLD.message;
END;

-- Commit order, not a millisecond timestamp: marking a visible message cannot acknowledge a
-- later message committed in the same millisecond. Portal messages are tombstoned, not removed.
CREATE TABLE integration_reads (
  channel TEXT NOT NULL, actor TEXT NOT NULL, root TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (channel, actor, root)
);
CREATE TRIGGER integration_read_insert AFTER INSERT ON integration_reads BEGIN
  INSERT INTO integration_changes(channel, root, reason, viewer)
    VALUES (NEW.channel, NEW.root, 'read', NEW.actor);
END;
CREATE TRIGGER integration_read_update AFTER UPDATE OF position ON integration_reads BEGIN
  INSERT INTO integration_changes(channel, root, reason, viewer)
    VALUES (NEW.channel, NEW.root, 'read', NEW.actor);
END;
