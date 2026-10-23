-- Thread agents per channel: on or off, as the admin team or a manager of the team that owns
-- the channel set it in the knowledge-base editor. A channel without a row follows the
-- AGENT_CHANNELS var. `changed_by` is the person's name, `changed_at` an ISO time.
CREATE TABLE agent_channels (
  channel_id TEXT PRIMARY KEY,        -- Slack or Teams channel id
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by TEXT,
  changed_at TEXT NOT NULL
);

-- Which team owns a channel: the team of its latest thread.
CREATE INDEX IF NOT EXISTS threads_channel ON threads(channel_id, last_at DESC);
