-- Label reviews by admin team members: calibration data for Clef, and a correction that
-- overrides the model's answer until the thread changes and is relabeled.
CREATE TABLE label_reviews (
  id INTEGER PRIMARY KEY,
  thread TEXT NOT NULL,
  question TEXT NOT NULL,             -- next_actor | kind | urgency | resolved
  model_value TEXT,                   -- what Clef said
  model_p REAL,                       -- its probability or confidence
  value TEXT NOT NULL,                -- what the reviewer says is right
  agrees INTEGER NOT NULL,            -- 1 if value equals model_value
  labeled_through TEXT NOT NULL,      -- the label version that was reviewed
  reviewer INTEGER NOT NULL REFERENCES people(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX label_reviews_thread ON label_reviews(thread, question, created_at);
CREATE INDEX label_reviews_question ON label_reviews(question, agrees);
