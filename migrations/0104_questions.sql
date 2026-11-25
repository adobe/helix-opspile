-- Questions a thread agent asks one person on its thread's teams (`ask_teammate`,
-- src/agent/question.js; the rows are src/questions.js): what neither the knowledge bases nor the
-- thread say, for a runbook, a reply or a fact, with its best guess at each. The person sees one
-- as a thread of their inbox, as the admin team sees its requests (src/requestthreads.js, kind
-- `question`), and answers it, passes it on, or says they do not know; the agent is told, as an
-- input of its own. One open question per thread and person; a question nobody answered by its
-- `deadline` reads as expired off the clock; it is written so only when the agent asks the same
-- person again, so the open one makes room.
CREATE TABLE questions (
  id TEXT PRIMARY KEY,                -- twelve hex digits, as the agent names it
  thread TEXT NOT NULL,               -- the inbox entry whose agent asked
  team TEXT NOT NULL,                 -- the team the entry is filed under then
  title TEXT,                         -- the entry's title then
  email TEXT NOT NULL,                -- whom it asks, lowercase
  name TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('runbook', 'reply', 'fact')),
  why TEXT NOT NULL,                  -- what the agent needs it for
  items TEXT NOT NULL,                -- [{ text, guess?, choices? }], one to three
  sidebar TEXT,                       -- the sidebar message the agent answered when it asked
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'passed', 'unknown', 'expired')),
  asked_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  answers TEXT,                       -- [{ pick?, text? }], one per item
  note TEXT,                          -- what they added; passed: why, and whom to ask
  passed_to TEXT,                     -- passed: who knows, as they wrote it
  decided_at TEXT,
  told_at TEXT                        -- the agent was told
);
CREATE UNIQUE INDEX questions_open ON questions(thread, email) WHERE status = 'open';
CREATE INDEX questions_email ON questions(email, asked_at);
CREATE INDEX questions_thread ON questions(thread, asked_at);
