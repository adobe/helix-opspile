-- Topic maps (src/topicmap.js): the channel threads clustered by their CONTENT vectors into
-- topics, each named by a language model, with the Adobe people who posted in them, the
-- customers they are for and Clef's topics (labels.topics). Built by the cron once a week and
-- by the admin team on the Topics page; the page shows the latest. The newest few are kept.
CREATE TABLE topic_maps (
  id INTEGER PRIMARY KEY,
  built_at TEXT NOT NULL,
  built_by TEXT NOT NULL,             -- the person's name, or `cron`
  threads INTEGER NOT NULL,           -- threads clustered
  k INTEGER NOT NULL,                 -- topics
  map TEXT NOT NULL                   -- JSON: src/topicmap.js buildTopicMap
);
CREATE INDEX topic_maps_built ON topic_maps(built_at);
