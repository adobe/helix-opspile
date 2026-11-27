-- Tools a thread agent asks for in its sidebar (its `request_tool`, src/agent/toolrequest.js):
-- a switchable tool (src/agent/agenttools.js) or an MCP server (a team's or customer's in
-- mcp_servers, or a global one, src/agent/globals.js) that is off in its channel. Anyone who may
-- work the thread grants or denies it in the sidebar; a grant gives the thread's agent the tool
-- for 24 hours, in every turn, on top of the switches. `status` is the lifecycle
-- (docs/STATE-MACHINES.md): pending -> granted -> revoked, or pending -> denied. A pending one
-- past its `deadline` is expired, and a granted one past `expires_at` has ended: both read off
-- the clock, never written. Every transition names the status it starts from.
CREATE TABLE tool_requests (
  id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,               -- the inbox entry's key: the agent that asked, which gets it
  sidebar TEXT,                       -- the sidebar message the agent answered when it asked
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'server')),
  name TEXT NOT NULL,                 -- tool: its key (web_search); server: mcp_servers.id, or global:<server>
  title TEXT NOT NULL,                -- what it is called when it was asked for
  about TEXT,                         -- what it does, when it was asked for
  reason TEXT NOT NULL,               -- the agent's, for the person who decides
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'denied', 'revoked')),
  created_at TEXT NOT NULL,
  deadline TEXT NOT NULL,             -- until when a person may grant or deny it
  decided_by INTEGER,                 -- the person who granted or denied it
  decided_at TEXT,
  expires_at TEXT,                    -- granted: until when the agent has it
  revoked_by INTEGER,                 -- the person who ended a grant early
  revoked_at TEXT
);
CREATE INDEX tool_requests_thread ON tool_requests (thread, status);
