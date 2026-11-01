-- One row per reply sent from the inbox with a key (src/postkeys.js): a retry of the same reply
-- finds it, instead of posting it again. `answer` is null until the platform answered, and holds
-- only ids, never the text. The cron deletes rows after a day.
CREATE TABLE post_keys (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  answer TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (person, key)
);
CREATE INDEX post_keys_at ON post_keys(at);
