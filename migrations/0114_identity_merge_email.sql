-- An embedded portal account's provider-verified mail address (portal migration 0009,
-- docs/PORTAL-INTEGRATION.md "One person, several profiles"): the accounts of one such address are
-- one person (src/accountpairs.js `sameAccounts`, the customers' overviews, the topic map), as
-- the accounts of one `email` are. It is a merge key and nothing else: never `email`, so it links
-- no person of D1, makes nobody staff by its domain (`isStaffDomain`), and names no partner.
ALTER TABLE identities ADD COLUMN merge_email TEXT;
-- When the portal last saw it verified (ISO; portal `users.verified_at`, at most a day old while
-- it is presented): an individual channel's agent joins an end user's accounts by it only while
-- recent (src/individual.js), as the portal does, so an address given to someone new after its
-- owner left stops joining them.
ALTER TABLE identities ADD COLUMN merge_at TEXT;
CREATE INDEX identities_merge_email ON identities(merge_email) WHERE merge_email IS NOT NULL;
