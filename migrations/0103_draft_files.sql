-- The files that go with a draft (src/draftfiles.js): JSON [{ id, name, type, size }], images
-- only, such as a screenshot an agent took on its computer. Their bytes are in the FILES bucket,
-- `drafts/<id>`, which deletes them after 30 days (its lifecycle rule). Sent with the draft, as
-- a reply's files; never shown to the customer otherwise.
ALTER TABLE drafts ADD COLUMN files TEXT;

-- The files of a draft a person discarded, on the discard's event, so that an Undo brings them
-- back with the text (`undoneDiscard`, src/draftevents.js). NULL for one without.
ALTER TABLE draft_events ADD COLUMN files TEXT;
