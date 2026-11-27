-- The logo a customer uploaded in the customer portal: its version there, with which the lobby's
-- events name it (src/portalrequests.js). The inbox shows it through the portal's Worker
-- (`GET /api/portal/logo/<domain>`), on the request and as the icon of a customer the inbox
-- had not met. NULL: none.
ALTER TABLE portal_requests ADD COLUMN logo TEXT;
