-- Bots that only post alerts (src/ourbots.js, an admin's say under Requests): a thread one of
-- them starts is an alert (`threads.kind = 'alert'`), in a channel whose rules make it a
-- conversation too, so it is counted, not shown as an unread conversation, and no agent, label or
-- vector is made for it. 1 alerts only, 0 or NULL not. Looking the account up again
-- (src/lookup.js, getIdentity) leaves it as it is.
ALTER TABLE identities ADD COLUMN alerts INTEGER;
