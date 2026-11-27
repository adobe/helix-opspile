-- Whom "shared" means on a channel of the integration (docs/PORTAL-INTEGRATION.md, `GET /threads`
-- `audienceName`): the customer's display name, for the host to say who can read the channel. The
-- provider's name of the channel's own tenant, recorded when a request of that tenant is approved
-- (`org_name`, from `/ims/organizations/v6`), unless the admin team set one (`audience_name`, who
-- and when). Never the channel's `<product>-<customer>` name, never the tenant ID.
ALTER TABLE integration_customers ADD COLUMN org_name TEXT;
ALTER TABLE integration_customers ADD COLUMN audience_name TEXT
  CHECK (audience_name IS NULL OR length(trim(audience_name)) BETWEEN 1 AND 120);
ALTER TABLE integration_customers ADD COLUMN audience_name_by TEXT;
ALTER TABLE integration_customers ADD COLUMN audience_name_at INTEGER;

-- What the access requests recorded of each channel's own tenant, the latest first.
UPDATE integration_customers SET org_name = (SELECT r.org_name FROM integration_requests r
    WHERE r.host = integration_customers.host AND r.tenant = integration_customers.tenant
      AND r.org_name IS NOT NULL AND trim(r.org_name) != '' ORDER BY r.seen_at DESC, r.id DESC LIMIT 1)
  WHERE org_name IS NULL;
