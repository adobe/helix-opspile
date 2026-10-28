-- Messages a person posted as the opspile app (POST /api/post/app): theirs to edit from the
-- inbox. User state, like drafts: rebuilding the index from pile 2 keeps it.
CREATE TABLE app_posts (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  id TEXT NOT NULL,                   -- the platform's message id
  thread TEXT NOT NULL,               -- the platform thread it was posted in
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  PRIMARY KEY (source, tenant, channel_id, id)
);
CREATE INDEX app_posts_thread ON app_posts(thread, person);
