-- Who sees a customer portal channel's threads, as the inbox heard it from the portal (portal
-- migration 0008, docs/PORTAL-INTEGRATION.md "Individual channels"): `individual`, each customer
-- only their own, or `shared`. The portal enforces it; the inbox keeps it for its thread agents,
-- which in an individual channel learn into the end user's own knowledge base (`kb-person-*`) and
-- read only that person's threads (src/individual.js). No row is shared, as every channel was.
-- `seq` is the portal event it is from: an older one changes nothing, so a replay of pile 1, or
-- two events out of order, end where the latest says.
CREATE TABLE channel_audiences (
  source TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('shared', 'individual')),
  seq INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  PRIMARY KEY (source, tenant, channel_id)
);
