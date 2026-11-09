-- One account a person, for a thread (src/accounts.js): of someone's accounts in one workspace
-- or tenant, the one in the thread's channel, of its own workspace, a full member, that posted
-- lately and the most is the one the inbox lists, suggests and mentions.

-- Whether a platform account is a guest where it is: on Slack a multi- or single-channel guest
-- (`is_restricted`, `is_ultra_restricted`), on Teams a Graph `userType` of Guest. NULL on
-- Discord, and until the account is looked up again (src/lookup.js).
ALTER TABLE identities ADD COLUMN guest INTEGER;

-- Each account's messages by time, and the channels it is listed in: which of a person's
-- accounts posted lately and how much, and is in the most channels, without scanning either.
CREATE INDEX IF NOT EXISTS messages_author ON messages(author_key, at);
CREATE INDEX IF NOT EXISTS channel_members_user ON channel_members(source, tenant, user_id);
