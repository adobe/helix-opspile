-- The host tenant's own admin accounts on Teams (src/lookup.js, isHostAdmin): members, not guests,
-- of the tenant that hosts the teams, whose user name begins `owner_`. They are Adobe's, but
-- their mail domain is the tenant's own, in no STAFF_DOMAINS, so they showed on the customer's
-- side, under their initials. The lookup says they are staff from now on (`identities.staff`);
-- these are the ones it saw before, and the messages and threads they wrote.
UPDATE identities SET staff = 1
  WHERE source = 'teams' AND kind = 'person' AND guest = 0 AND email LIKE 'owner\_%' ESCAPE '\'
    AND staff IS NOT 1;
UPDATE messages SET staff = 1
  WHERE staff = 0 AND author_key IN (SELECT source || ':' || tenant || ':' || user_id
    FROM identities WHERE source = 'teams' AND kind = 'person' AND guest = 0
      AND email LIKE 'owner\_%' ESCAPE '\');
UPDATE threads SET last_staff = (SELECT staff FROM messages WHERE thread = threads.thread
    AND counted = 1 AND deleted = 0 ORDER BY at DESC LIMIT 1)
  WHERE thread IN (SELECT DISTINCT thread FROM messages WHERE author_key IN (
    SELECT source || ':' || tenant || ':' || user_id FROM identities
    WHERE source = 'teams' AND kind = 'person' AND guest = 0
      AND email LIKE 'owner\_%' ESCAPE '\'));

-- Whose such an account is (src/accountlinks.js): the admin team links an account that is
-- staff by itself and that no mail address links to a person (`identities.person`) to the
-- Adobe person who uses it, by their mail address, so it shows as them, not as its initials.
-- Looking the account up again (src/lookup.js, getIdentity) keeps the link. Who linked it last
-- (their mail address) and when; NULL: the person, if any, is the mail address's.
ALTER TABLE identities ADD COLUMN linked_by TEXT;
ALTER TABLE identities ADD COLUMN linked_at TEXT;
