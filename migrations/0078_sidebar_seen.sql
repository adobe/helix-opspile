-- Whether the person a sidebar answer is for has seen it (src/sidebar.js): the inbox marks a
-- thread with the agent's answers its asker has not seen yet, in purple, so a question asked in
-- the sidebar and left is not forgotten. Set once the conversation is shown to them (the panel
-- beside the thread, or unfolded in it), and cleared when a failed answer is replaced, which is
-- a new answer. The answers kept so far count as seen: they were shown, or are past.
ALTER TABLE sidebar_messages ADD COLUMN seen_at TEXT;
UPDATE sidebar_messages SET seen_at = at WHERE role = 'agent';
CREATE INDEX sidebar_messages_unseen ON sidebar_messages (person, thread)
  WHERE role = 'agent' AND seen_at IS NULL;
