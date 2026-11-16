-- A group's members by their latest activity (src/api.js `inbox`): the inbox reads each entry's
-- five latest members from here, instead of ranking every thread of the inbox. It starts with
-- `logical_thread`, so it serves what `threads_logical` did.
CREATE INDEX threads_group_latest ON threads(logical_thread, COALESCE(last_at, any_at));
DROP INDEX threads_logical;
