-- The latest message's text, as one line of plain text, so the inbox's rows can show it
-- without reading the thread (ui/inbox.js). `messages.preview` is each message's (null until
-- the normalizer or the cron's sweep wrote it, '' for a message with no text);
-- `threads.last_text` is the preview of the message `last_id` names, derived like the other
-- `last_*` columns.
ALTER TABLE messages ADD COLUMN preview TEXT;
ALTER TABLE threads ADD COLUMN last_text TEXT;
