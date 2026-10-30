-- Colleagues a thread agent suggests pulling into a thread (src/experts.js): shown first in the
-- thread's expert finder, for a person to mention. User state, like drafts: a replay keeps them.
CREATE TABLE expert_suggestions (
  thread TEXT NOT NULL,               -- the inbox entry's key when it was suggested
  user_id TEXT NOT NULL,              -- the account on the thread's platform
  reason TEXT NOT NULL,               -- why, in the agent's words: shown as text
  by TEXT NOT NULL,                   -- opspile-agent/<model>
  at TEXT NOT NULL,
  PRIMARY KEY (thread, user_id)
);
