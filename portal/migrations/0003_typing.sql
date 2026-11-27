-- Who is writing in a thread right now (docs/ARCHITECTURE.md, "Listening and the next answer"):
-- the Adobe people the inbox says are writing a reply there. A row counts for a few seconds
-- after `at`, is written again while they go on, and goes when their message arrives; old rows
-- are deleted with the next one written.
CREATE TABLE typing (
  root TEXT NOT NULL,                 -- the thread
  user TEXT NOT NULL REFERENCES users(id),
  at TEXT NOT NULL,
  PRIMARY KEY (root, user)
);
