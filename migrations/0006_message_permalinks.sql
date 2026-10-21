-- Each message's link back to Slack or Teams, so a thread can link to its root (or, while
-- the root is missing, its earliest known message).
ALTER TABLE messages ADD COLUMN permalink TEXT;
