-- Full-text search (SEARCH, an AI Search instance): one item per message of a channel thread.

-- A hash of what the message's item was last uploaded with (its team and text), and the
-- item's id, for taking it away again; both null while it has none.
ALTER TABLE messages ADD COLUMN indexed TEXT;
ALTER TABLE messages ADD COLUMN search_item TEXT;

-- The threads.any_at the thread's items were brought up to date for (the cron's sweep
-- compares it); null until they are.
ALTER TABLE threads ADD COLUMN indexed_through TEXT;
