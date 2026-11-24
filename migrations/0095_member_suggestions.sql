-- Suggested members (src/membersuggest.js): the people a team's page suggests adding, from who
-- works its threads, is in its channels and works its topics. A suggestion a team's manager does
-- not want is dismissed here, and so is someone taken off the team (`why` = 'removed'): neither is
-- suggested to the team again until someone says so on its page.
CREATE TABLE member_suggestion_dismissals (
  team TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  why TEXT NOT NULL DEFAULT 'dismissed' CHECK (why IN ('dismissed', 'removed')),
  dismissed_by TEXT,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (team, email)
);
