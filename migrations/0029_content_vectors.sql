-- Message and thread vectors (CONTENT, Vectorize): what each was last embedded from.

-- A hash of the text the message's vector was made from; null when it has none (a bot, a
-- deleted message, nothing to embed).
ALTER TABLE messages ADD COLUMN embedded TEXT;

-- The threads.any_at the thread's vector was made for (the cron's sweep compares it), and a
-- hash of the text it was made from; both null until it has one.
ALTER TABLE threads ADD COLUMN vectorized_through TEXT;
ALTER TABLE threads ADD COLUMN embedded TEXT;
