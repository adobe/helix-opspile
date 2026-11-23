-- The expert finder's model of mentions (src/mention-model.js): the odds that someone mentioned
-- in a thread they are not in answers there within a week, and how long they take. Fit by the
-- cron once the newest is a day old (src/mentionmodels.js); the finder uses the newest, and the
-- newest few are kept. Numbers by person and channel id only, nothing anyone wrote.
CREATE TABLE mention_models (
  id INTEGER PRIMARY KEY,
  built_at TEXT NOT NULL,
  mentions INTEGER NOT NULL,          -- mentions it learnt from
  answered INTEGER NOT NULL,          -- of them, answered within a week
  model TEXT NOT NULL                 -- JSON: src/mention-model.js fitMentions
);
CREATE INDEX mention_models_built ON mention_models(built_at);
