-- Whom someone said is not the right person for a thread (`reject` in expert_events,
-- src/expertevents.js): read on every GET /api/experts, and kept when the cron prunes the rest.
CREATE INDEX expert_events_reject ON expert_events(person, thread) WHERE action = 'reject';
