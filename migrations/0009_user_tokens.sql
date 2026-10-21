-- Posting as the user: one OAuth token per person and platform, encrypted with TOKEN_KEY.
CREATE TABLE user_tokens (
  person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,              -- slack | teams
  user_id TEXT NOT NULL,               -- the platform account the token belongs to
  access_token TEXT NOT NULL,          -- AES-GCM, base64url(iv || ciphertext)
  refresh_token TEXT,
  expires_at TEXT,                     -- null: does not expire
  scope TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person, platform)
);
