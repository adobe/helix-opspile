-- A person's inbox settings, kept with them rather than in one browser (src/settings.js): whether
-- mentions of them notify them, and the views ("bells") whose new messages do. One JSON object
-- per person; what is not in it has its default.
CREATE TABLE person_settings (
  person INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,             -- JSON: { mentions: boolean, bells: [{ view, sel, not }] }
  updated_at TEXT NOT NULL
);
