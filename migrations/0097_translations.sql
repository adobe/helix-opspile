-- The language a thread is written in, as Clef reads it (src/translate.js LANGUAGES: an ISO 639-1
-- code, or `other`), and how sure it is; NULL on a label from before (src/label.js).
ALTER TABLE labels ADD COLUMN language TEXT;
ALTER TABLE labels ADD COLUMN language_p REAL;

-- The inbox's translations of messages (src/translate.js): one row per message and language it
-- was translated into. `source` is a hash of the body it translated, so an edit is translated
-- again; `body` NULL means the model found it in that language already. A cache: the cron deletes
-- rows older than 90 days, and a page that asks again has them made again.
CREATE TABLE translations (
  message TEXT NOT NULL,              -- <platform thread>|<message id>
  lang TEXT NOT NULL,                 -- what it was translated into
  source TEXT NOT NULL,
  body TEXT,
  model TEXT NOT NULL,
  at TEXT NOT NULL,                   -- when it was made
  PRIMARY KEY (message, lang)
);
CREATE INDEX translations_at ON translations(at);
