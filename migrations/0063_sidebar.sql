-- The sidebar (src/sidebar.js): a person on the team talks to a thread's agent in the inbox, and
-- it answers there. Nothing of it is posted to the platform: these rows are the conversation, next
-- to the agent's transcript. A person's message is written when it is sent; the agent's answer
-- when its turn ends (`reply_to` names the message it answers, and its id is that message's with
-- `:answer`, so a turn kept twice writes one answer; a failed turn writes its failure, which a later
-- attempt replaces).
CREATE TABLE sidebar_messages (
  id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,               -- the inbox entry's key: whose agent it talks to
  role TEXT NOT NULL CHECK (role IN ('person', 'agent')),
  person INTEGER,                     -- who wrote it; on the agent's answer, whom it answers
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('done', 'failed')),
  reply_to TEXT,                      -- the agent's: the person's message it answers
  at TEXT NOT NULL
);
CREATE INDEX sidebar_messages_thread ON sidebar_messages (thread, at);
