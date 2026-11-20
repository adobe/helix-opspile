-- What a person follows besides technologies (person_follows): a customer (`org`, an org slug),
-- a person (`person`, a people.id: the threads they post in) or an area (`area`, an area id:
-- the threads Clef puts in it). Their threads are in the person's personal view, whichever team
-- their channel is filed under (src/follows.js), as a followed technology's are; and they count
-- only while the person is on an ops team.
CREATE TABLE person_follows_by (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('org', 'person', 'area')),
  target TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (person, kind, target)
);
CREATE INDEX person_follows_by_target ON person_follows_by (kind, target);

-- What a thread is about, by index, as thread_tech is for what it shows: one row per area
-- (labels.topics), written with the label. For the threads of a followed area.
CREATE TABLE thread_areas (
  thread TEXT NOT NULL,
  area TEXT NOT NULL,
  p REAL NOT NULL,
  PRIMARY KEY (thread, area)
);
CREATE INDEX thread_areas_area ON thread_areas (area);
INSERT OR IGNORE INTO thread_areas (thread, area, p)
  SELECT l.thread, j.key, j.value FROM labels l, json_each(l.topics) j
  WHERE l.topics IS NOT NULL AND json_valid(l.topics);
