-- Team managers: members of a team who may manage its members and edit its knowledge base,
-- in the admin pages, without being in the admin team. A self-managed team makes every
-- member a manager, now and when they join; turning it off keeps the roles as they are.
ALTER TABLE team_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('member', 'manager'));
ALTER TABLE teams ADD COLUMN self_managed INTEGER NOT NULL DEFAULT 0;
