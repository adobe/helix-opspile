-- Scripts a thread agent asks a person to run as themselves (the agent's `request_codemode`,
-- src/agent/scriptrequest.js), next to the commands of its `request_bash`, in the same record
-- (src/bashrequests.js) and with the same lifecycle (docs/STATE-MACHINES.md, "Command request"):
-- `kind` tells them apart, `command` holds the script, and `tools` the inbox's tools it may call
-- as the person who runs it (src/scripttools.js). A script has no variables: `env` stays '[]'.
-- `sidebar`, of either kind, is the sidebar message the agent answered when it asked (as a tool
-- request's, migration 0074): the inbox shows the request in that conversation, under the answer.
ALTER TABLE bash_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'bash'
  CHECK (kind IN ('bash', 'codemode'));
ALTER TABLE bash_requests ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';  -- ["search_threads", …]
ALTER TABLE bash_requests ADD COLUMN sidebar TEXT;                       -- sb_…, or NULL
