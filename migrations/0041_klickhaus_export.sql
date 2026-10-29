-- The klickhaus export (src/clickhouse.js): one row per message in ClickHouse.
-- How far each thread was exported: the thread row's `updated_at` the export read, and when
-- the export started. A re-file clears `exported_through`; the cron sweep exports what is behind.
ALTER TABLE threads ADD COLUMN exported_through TEXT;
ALTER TABLE threads ADD COLUMN exported_at TEXT;

-- What the export needs of a message that only pile 2 had: written by the normalizer, and read
-- from pile 2 once for messages indexed before.
ALTER TABLE messages ADD COLUMN author_kind TEXT;   -- person | bot | system
ALTER TABLE messages ADD COLUMN edited INTEGER;     -- 1 once edited
ALTER TABLE messages ADD COLUMN attachments INTEGER; -- files in the message
