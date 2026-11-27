-- A question an admin asks a colleague from one of the admin team's requests (src/requestthreads.js
-- "Ask a colleague"): the same row as a thread agent's question (migration 0104), whose `thread`
-- is the request's key (`request:<kind>:<id>`) and whose answer goes into the request's decision
-- log (`request_log`) instead of to an agent. Who asked, for the asked person's thread; null for
-- an agent's.
ALTER TABLE questions ADD COLUMN asked_by TEXT;
ALTER TABLE questions ADD COLUMN asked_by_name TEXT;
