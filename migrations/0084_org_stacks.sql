-- Each customer's stack as its knowledge base's stack.md draws it (src/orgstacks.js): the parts
-- that are not people, `[{ name, tech, layer }]`, for the inbox's list by customer, which shows
-- the key part of each layer beside the customer. Written on every write of stack.md; the cron
-- fills in the knowledge bases that have no row yet. `[]`: no drawing, or one with no parts.
-- The customer-level stack comes from the drawing only: channel_tech (Clef's answers kept per
-- channel) is read no more, and goes in a later migration.
CREATE TABLE org_stacks (
  org TEXT PRIMARY KEY,
  parts TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
