-- What a thread is about (src/label.js TOPICS): the topics Clef is sure of, as JSON
-- `{ "<topic>": <probability> }`, null when none is. Set by every relabel.
ALTER TABLE labels ADD COLUMN topics TEXT;

-- Titles the model wrote when it found nothing to name ("None", "No title available", …):
-- none, so the inbox shows the thread's first words (src/label.js isTitle).
UPDATE labels SET title = NULL
  WHERE lower(trim(title)) IN ('none', 'null', 'n/a', 'untitled', 'inquiry', 'general inquiry')
    OR lower(title) LIKE 'no title%' OR lower(title) LIKE 'no specific topic%'
    OR lower(title) LIKE 'no specific information%' OR lower(title) LIKE 'no topic%'
    OR lower(title) LIKE 'no information%' OR lower(title) LIKE 'invalid title%';
