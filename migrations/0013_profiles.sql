-- Profile cards: what the inbox shows when you hover over a person.

-- The job title (Slack profile title, Graph jobTitle) and, on Teams, the company name of a
-- platform account. Filled in when the identity is next looked up (they are cached a day).
ALTER TABLE identities ADD COLUMN title TEXT;
ALTER TABLE identities ADD COLUMN company TEXT;

-- Mail domains of partners (agencies, system integrators): people from these domains are
-- shown as partners rather than customers. Subdomains count too. Data, never committed.
CREATE TABLE partner_domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT                           -- the partner's name, shown on the card
);
