-- Public Slack channels the app could not join (src/autojoin.js): Slack's error and when it
-- was tried, so the cron does not spend every run on the same refusals
-- (`app_cannot_join_channel`, `too_many_members`). Tried again after a week.
CREATE TABLE slack_joins (
  channel_id TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  tried_at TEXT NOT NULL
);
