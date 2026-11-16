-- A team's inbox, group by group (src/api.js `inbox`): the threads filed under the team, by
-- their entry (`COALESCE(logical_thread, thread)`), with all the inbox reads of them, so that
-- counting an entry of thousands of alerts reads only this index, in order, and sorts nothing.
CREATE INDEX threads_inbox ON threads(team, COALESCE(logical_thread, thread),
  COALESCE(last_at, any_at), messages, kind, last_at, thread, logical_thread, any_at);
