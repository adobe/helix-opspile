-- The knowledge base's sidebar (src/kbchat.js): on a team's or a customer's page, a person who may
-- looks at its knowledge base talks to its knowledge-base agent (`kb:<team>:` for a team's,
-- `kb::<org>` for a customer's), which looks things up in the knowledge bases and in every thread
-- of the inbox and changes the knowledge base for who may write it. Each conversation is a person's own
-- (`chat`, a session of the agent pinned to that knowledge base), and they start a new one when
-- they like; these rows are what the page shows of it, next to the agent's transcript. A person's
-- message is written when it is sent, the agent's answer when its turn ends (its id is the
-- message's with `:answer`, so a turn kept twice writes one answer; a failed turn writes its
-- failure, which a later attempt replaces), as `sidebar_messages` does for a thread's.
CREATE TABLE kb_chat_messages (
  id TEXT PRIMARY KEY,                -- sb_<uuid>; the agent's answer `sb_<uuid>:answer`
  repo TEXT NOT NULL,                 -- the knowledge base (knowledge_bases.repo)
  chat TEXT NOT NULL,                 -- the conversation, kc_<uuid>
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, -- whose conversation it is
  role TEXT NOT NULL CHECK (role IN ('person', 'agent')),
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('done', 'failed')),
  reply_to TEXT,                      -- the agent's: the person's message it answers
  at TEXT NOT NULL
);
CREATE INDEX kb_chat_messages_person ON kb_chat_messages (repo, person, at);
CREATE INDEX kb_chat_messages_chat ON kb_chat_messages (chat, at);

-- A command the knowledge-base agent asked to have run in one of those conversations
-- (request_bash): its `thread` is the agent's name (`kb:<team>:`, `kb::<org>`), and `chat` the
-- conversation, whose person decides it on the page and whose session hears how it ended.
ALTER TABLE bash_requests ADD COLUMN chat TEXT;
CREATE INDEX bash_requests_chat ON bash_requests (chat) WHERE chat IS NOT NULL;
