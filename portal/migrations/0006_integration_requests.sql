-- Access requests of user-token hosts (docs/PORTAL-INTEGRATION.md, "Access requests"): a verified
-- caller of a host with an identity provider who is not enrolled is recorded here, one row per
-- (host, tenant, subject), for the inbox's admin team to approve or decline. Never a token: only
-- what the provider said of the person, and the decision.
CREATE TABLE integration_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL REFERENCES integration_hosts(id),
  tenant TEXT NOT NULL,
  subject TEXT NOT NULL,
  name TEXT,                                -- the provider's display name
  email TEXT CHECK (email = lower(trim(email))), -- only an address the provider verified
  org_name TEXT,                            -- the provider's name of the tenant, when readable
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  requested_at INTEGER NOT NULL,            -- Unix seconds, when it (last) became pending
  seen_at INTEGER NOT NULL,                 -- the latest refresh, at most every 15 minutes
  attempts INTEGER NOT NULL DEFAULT 1,
  decided_at INTEGER,
  decided_by TEXT,                          -- the mail address of who decided, in the inbox
  decided_name TEXT,
  reason TEXT,                              -- why it was declined, for the person
  channel TEXT,                             -- where it was approved (or reserved) into
  actor TEXT,                               -- the actor it was enrolled as
  UNIQUE (host, tenant, subject)
);
CREATE INDEX integration_requests_status ON integration_requests(status, requested_at);
CREATE INDEX integration_requests_host ON integration_requests(host, status, requested_at);

-- What a host calls its channels: `<product>-<customer>` (SLICC's is `agents`). Optional.
ALTER TABLE integration_hosts ADD COLUMN product TEXT
  CHECK (product IS NULL OR (length(product) BETWEEN 1 AND 30 AND product GLOB '[a-z0-9]*'
    AND product NOT GLOB '*[^a-z0-9-]*'));

-- Who approved a mapping made from a request, and when a mapping was first enabled: a mapping
-- approved but never enabled (its routing failed half-way) may be finished by approving again;
-- one an operator made by hand, or suspended after it was enabled, may not.
ALTER TABLE integration_customers ADD COLUMN approved_by TEXT;
ALTER TABLE integration_customers ADD COLUMN approved_at INTEGER;
ALTER TABLE integration_customers ADD COLUMN enabled_at INTEGER;
UPDATE integration_customers SET enabled_at = unixepoch() WHERE enabled = 1;
CREATE TRIGGER integration_enabled AFTER UPDATE OF enabled ON integration_customers
WHEN NEW.enabled = 1 AND NEW.enabled_at IS NULL
BEGIN UPDATE integration_customers SET enabled_at = unixepoch() WHERE channel = NEW.channel; END;
CREATE TRIGGER integration_enabled_insert AFTER INSERT ON integration_customers
WHEN NEW.enabled = 1 AND NEW.enabled_at IS NULL
BEGIN UPDATE integration_customers SET enabled_at = unixepoch() WHERE channel = NEW.channel; END;

-- Who approved a member (null: enrolled by hand).
ALTER TABLE integration_members ADD COLUMN approved_by TEXT;
ALTER TABLE integration_members ADD COLUMN approved_at INTEGER;
