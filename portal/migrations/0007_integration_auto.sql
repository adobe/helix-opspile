-- Auto-approval for onboarded organizations (docs/PORTAL-INTEGRATION.md, "Auto-approval"). The
-- admin team marks a channel of a user-token host as auto-approving: a verified caller whose
-- organization (its own tenant, or an extra org ID listed here), or whose provider-verified mail
-- domain (listed here, exactly), lands in it is enrolled on their first call. Opt-in per channel.
ALTER TABLE integration_customers ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integration_customers ADD COLUMN auto_by TEXT;   -- who turned it on (or off), last
ALTER TABLE integration_customers ADD COLUMN auto_at INTEGER;

-- What else lands in a channel: another tenant (`tenant`, an org ID) or a mail domain (`domain`).
-- One channel per host for each, and never another channel's own tenant.
CREATE TABLE integration_catches (
  host TEXT NOT NULL REFERENCES integration_hosts(id),
  channel TEXT NOT NULL REFERENCES integration_customers(channel),
  kind TEXT NOT NULL CHECK (kind IN ('tenant', 'domain')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 3 AND 253),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (host, kind, value)
);
CREATE INDEX integration_catches_channel ON integration_catches(channel);
CREATE TRIGGER integration_catch_host BEFORE INSERT ON integration_catches
WHEN NEW.host IS NOT (SELECT host FROM integration_customers WHERE channel = NEW.channel)
  OR (NEW.kind = 'domain' AND (NEW.value != lower(NEW.value) OR NEW.value NOT GLOB '*.*'))
BEGIN SELECT RAISE(ABORT, 'a catch is of its channel''s host, and a domain is lowercase'); END;
CREATE TRIGGER integration_catch_tenant BEFORE INSERT ON integration_catches
WHEN NEW.kind = 'tenant' AND EXISTS (SELECT 1 FROM integration_customers
  WHERE host = NEW.host AND tenant = NEW.value)
BEGIN SELECT RAISE(ABORT, 'tenant mapped already'); END;
CREATE TRIGGER integration_tenant_caught BEFORE INSERT ON integration_customers
WHEN EXISTS (SELECT 1 FROM integration_catches WHERE host = NEW.host AND kind = 'tenant'
  AND value = NEW.tenant)
BEGIN SELECT RAISE(ABORT, 'tenant caught by another channel'); END;

-- How a member was matched (null: their tenant is the channel's; `org:<id>` an extra org ID;
-- `domain:<d>` a caught mail domain, bound to that verified address as an alias), and whether
-- nobody decided it but the channel's auto-approval (`approved_by` is who set the rule then).
ALTER TABLE integration_members ADD COLUMN via TEXT;
ALTER TABLE integration_members ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
CREATE INDEX integration_members_subject ON integration_members(subject);
CREATE INDEX integration_members_auto ON integration_members(channel, approved_at) WHERE auto = 1;
-- A host with an identity provider resolves a member by subject (the provider's user ID), so a
-- subject is a member of at most one of its channels. Assertion hosts keep (tenant, subject).
CREATE TRIGGER integration_member_host BEFORE INSERT ON integration_members
WHEN EXISTS (SELECT 1 FROM integration_members m
  JOIN integration_customers c ON c.channel = m.channel
  JOIN integration_customers n ON n.channel = NEW.channel AND n.host = c.host
  JOIN integration_hosts h ON h.id = n.host
  WHERE m.subject = NEW.subject AND h.identity IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'subject enrolled on this host already'); END;
