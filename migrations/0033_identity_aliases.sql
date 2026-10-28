-- The other names a person's account goes by, which people type after @ to mention them: the
-- Slack login (`name`) and display name, the Discord username and global name. A JSON array
-- of strings, filled in by the user lookup (src/lookup.js); NULL until the account is looked
-- up again. The mail address, already in `email`, counts too (src/mention-match.js).
ALTER TABLE identities ADD COLUMN aliases TEXT;
