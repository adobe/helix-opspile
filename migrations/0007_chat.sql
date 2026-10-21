-- What the inbox needs to look like a chat: avatars, who wrote each message, reactions.

-- Avatar URL of an identity: the Slack profile image, else a Gravatar URL for the email
-- (which may not exist; the UI falls back to initials).
ALTER TABLE identities ADD COLUMN avatar TEXT;

-- The author's identity (`<source>:<tenant>:<user id>`), to find their avatar and email.
ALTER TABLE messages ADD COLUMN author_key TEXT;

-- Emoji reactions per message. Slack reports them as events (and on backfilled messages),
-- Teams on the message itself; `user_key` is the reactor's identity.
CREATE TABLE reactions (
  message TEXT NOT NULL,              -- <source>:<tenant>:<channel>:<id>
  thread TEXT NOT NULL,
  emoji TEXT NOT NULL,                -- Slack name (thumbsup) or Teams type (like) or a character
  user_key TEXT NOT NULL,
  at TEXT,
  PRIMARY KEY (message, emoji, user_key)
);
CREATE INDEX reactions_thread ON reactions(thread);
