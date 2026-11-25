-- Optional per host: the identity provider whose user tokens the host forwards instead of signing
-- its own assertions (docs/PORTAL-INTEGRATION.md, "User tokens"). JSON, operator-owned; the
-- tenant, subject and email then come from the provider, never from the host. A host uses one
-- mode: a host with a provider has no assertion keys, so no assertion of it can verify.
ALTER TABLE integration_hosts ADD COLUMN identity TEXT
  CHECK (identity IS NULL OR json_valid(identity));
CREATE TRIGGER integration_host_mode BEFORE INSERT ON integration_hosts
WHEN NEW.identity IS NOT NULL AND json_array_length(NEW.jwks, '$.keys') IS NOT 0
BEGIN SELECT RAISE(ABORT, 'a host with an identity provider has no assertion keys'); END;
CREATE TRIGGER integration_host_mode_change BEFORE UPDATE OF identity, jwks ON integration_hosts
WHEN NEW.identity IS NOT NULL AND json_array_length(NEW.jwks, '$.keys') IS NOT 0
BEGIN SELECT RAISE(ABORT, 'a host with an identity provider has no assertion keys'); END;
