-- Partner domains are found now (src/partners.js): the usual mail domains of the people who
-- post in each partner org's threads. The rows of this table are the admin team's overrides
-- over what is found: a domain added by hand, a found one renamed or given to another partner
-- org (`org`, whose display name it shows without a `name`), and one that is not a partner's
-- (`excluded`, which its subdomains are not either, unless one of them has a row of its own).
ALTER TABLE partner_domains ADD COLUMN org TEXT;
ALTER TABLE partner_domains ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partner_domains ADD COLUMN updated_by TEXT;
ALTER TABLE partner_domains ADD COLUMN updated_at TEXT;
