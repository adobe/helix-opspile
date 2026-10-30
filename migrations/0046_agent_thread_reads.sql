-- Threads that thread agents read with read_any_thread (the any_thread tool), whatever their
-- channel: the agent's transcript can be reset, and this has to outlive it. One row per agent
-- and thread, when it first read it.
CREATE TABLE agent_thread_reads (
  agent_thread TEXT NOT NULL,         -- the agent: the key of its inbox entry
  thread TEXT NOT NULL,               -- the inbox entry it read
  at TEXT NOT NULL,
  PRIMARY KEY (agent_thread, thread)
);
CREATE INDEX agent_thread_reads_thread ON agent_thread_reads(thread);
