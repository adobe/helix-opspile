-- The personal view (GET /api/inbox?view=personal) has the channels a person posted in: their
-- messages by person, with the channel in the index, so that it is never a scan of messages.
CREATE INDEX IF NOT EXISTS messages_person ON messages(person, source, channel_id);
