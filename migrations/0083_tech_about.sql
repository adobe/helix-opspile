-- What a thread is about, among the technologies it shows (src/label.js `aboutOf`): after Clef
-- answers which technologies the customer uses, a second call asks, of those it answered yes,
-- whether the thread is about each. `labels.about` is `{ id: probability }` at or above TECH_MIN;
-- `thread_tech.about` the same per row (NULL: not about it, or labeled before this). "Uses" stays
-- what follows, filters and the stack read; "about" is for the Topics page and the expert finder.
ALTER TABLE labels ADD COLUMN about TEXT;
ALTER TABLE thread_tech ADD COLUMN about REAL;
