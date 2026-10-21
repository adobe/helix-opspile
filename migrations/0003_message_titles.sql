-- Thread titles fall back to the earliest known message when the root has not been
-- ingested (yet): a thread whose root predates ingestion is otherwise untitled.
ALTER TABLE messages ADD COLUMN title TEXT;
