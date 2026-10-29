-- How many entries (files other than index.md, log.md and systemprompt.md) each knowledge
-- base has, for the editor's list: counted after every write, and by the cron for the ones
-- not counted yet (NULL).
ALTER TABLE knowledge_bases ADD COLUMN entries INTEGER;
