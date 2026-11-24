-- The admin team's requests are threads of its inbox (src/requestthreads.js), keyed
-- `request:<kind>:<id>`: a channel, a membership, a customer in the portal, a merge of customers,
-- a bot, an admin account, a conflict between technologies or between team rules. The requests
-- keep their own rows; these two tables keep what the threads add to them.
--
-- `request_log`: the thread's decision log, what the admin team writes in it (`note`) and what it
-- decided from it where the request has no row that says so (`decision`: a bot's, an account's, a
-- conflict's). Never changed or deleted.
CREATE TABLE request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request TEXT NOT NULL,
  type TEXT NOT NULL,          -- note | decision
  body TEXT NOT NULL,          -- markdown
  person INTEGER REFERENCES people(id) ON DELETE SET NULL,
  author_name TEXT,
  author_email TEXT,
  at TEXT NOT NULL
);
CREATE INDEX request_log_request ON request_log(request, at);

-- `request_threads`: when a request that has no time of its own (a conflict, a bot nobody said
-- whose it is, an account nobody linked) was first seen waiting, and when a conflict was last
-- seen, once it is gone (`closed_at`: settled, or its rules or definitions changed), with its
-- title then, so that its thread stays in the inbox with its log (STATE-MACHINES.md, "Request
-- thread").
CREATE TABLE request_threads (
  request TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
