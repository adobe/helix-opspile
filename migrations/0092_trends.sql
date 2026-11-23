-- Trends (src/trends.js, the Topics page's Trends): topics found over the channel threads of the
-- last year, and each thread's topic, so the page can say which topics are trending, declining or
-- peaked. A trend map's topics stay for weeks (STALE_DAYS), so a topic's line means the same
-- thing from its first week to its last.
CREATE TABLE trend_maps (
  id INTEGER PRIMARY KEY,
  built_at TEXT NOT NULL,
  built_by TEXT NOT NULL,             -- the person's name, or `cron`
  threads INTEGER NOT NULL,           -- threads clustered (a sample of every month's)
  k INTEGER NOT NULL,                 -- topics
  topics TEXT NOT NULL,               -- JSON [{ id, label, theme, area, size }]
  model TEXT NOT NULL,                -- the embedding model of the vectors
  vectors TEXT NOT NULL               -- base64 float32: the mean, the k centroids, then a sample
                                      -- of the threads' vectors (raw), DIM each
);

-- A thread's topic in a trend map: the nearest centroid, or none (topic null) when it is near
-- none. `embedded` is the threads.embedded its vector was, so a thread whose vector changed is
-- assigned again; `vid` its CONTENT vector id, to find it from a vector query.
CREATE TABLE trend_threads (
  thread TEXT PRIMARY KEY,
  map INTEGER NOT NULL,
  topic INTEGER,
  sim REAL,
  embedded TEXT,
  vid TEXT NOT NULL
);
CREATE INDEX trend_threads_vid ON trend_threads(vid);
