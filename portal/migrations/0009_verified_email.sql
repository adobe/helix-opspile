-- The address the identity provider (or the host's signed assertion) verified for an embedded
-- account (docs/PORTAL-INTEGRATION.md, "One person, several profiles"): what an integration
-- actor's events tell the inbox, which counts the accounts of one such address as one person.
-- It is a merge key only. It is never the account's `email` (which an integration actor has none
-- of, so nothing signs in with it), authorizes nothing (enrollment and its alias binding stay
-- `integration_actors.verified_email`), and makes nobody staff in the inbox, whatever its domain.
-- Written on an admitted call that presents one, verified, and kept until another is.
-- `verified_at` (Unix seconds) is when it was last presented (written again at most daily): two
-- profiles are one person only while both verify it, so an address that went to someone else
-- after its owner left stops joining them (src/portal/integration-auth.js `MERGE_DAYS`).
ALTER TABLE users ADD COLUMN verified_email TEXT
  CHECK (verified_email IS NULL OR verified_email = lower(trim(verified_email)));
ALTER TABLE users ADD COLUMN verified_at INTEGER;
CREATE INDEX users_verified_email ON users(verified_email) WHERE verified_email IS NOT NULL;
