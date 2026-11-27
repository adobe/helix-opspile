-- Trends (src/trends.js), on the Topics page beside the map: every thread's topic, week by week.
-- A topic map keeps the space it found its topics in (src/topicmap.js): base64 float32s, DIM
-- each, the mean taken away, the centre of each of its `k` topics, then a sample of the threads'
-- own vectors, to tell how alike a phrase is to a thread by chance.
ALTER TABLE topic_maps ADD COLUMN vectors TEXT;

-- A thread's topic in a topic map: its own, for the map's threads, else the nearest centre's, or
-- none (topic null) when it is near none. `embedded` is the threads.embedded its vector was, so a
-- thread whose vector changed is assigned again; `vid` its CONTENT vector id, to find it from a
-- vector query.
CREATE TABLE trend_threads (
  thread TEXT PRIMARY KEY,
  map INTEGER NOT NULL,
  topic INTEGER,
  sim REAL,
  embedded TEXT,
  vid TEXT NOT NULL
);
CREATE INDEX trend_threads_vid ON trend_threads(vid);
