-- What a draft's claims rest on, for the person reviewing it: JSON [{ url, title, quote }].
-- Never part of the reply: only the inbox shows them.
ALTER TABLE drafts ADD COLUMN sources TEXT;
