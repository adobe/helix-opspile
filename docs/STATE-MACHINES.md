# State machines

opspile has one status column, `channel_requests.status`. Everything else that has a lifecycle
keeps it in the shape of its data: a nullable timestamp, a watermark, whether a row exists, a lease,
a key in a Durable Object's storage, a flag in the page. Those are state machines all the same, and
this is the list of them, so that a change to one can start from what it is.

Each entry gives the states, where they live, and what keeps the transitions right.

## The rules they follow

Most bugs in these machines have been one of three kinds. Before changing a lifecycle, check it
against these.

1. **A retry must not skip what the first try did not finish.** A job's guard ("this was done") is
   written last, after everything it guards. If a guard has to be written first, what is left to do
   is written with it, as a column a sweep can find. See re-threading and re-filing.
2. **A failure that may pass is not a final state.** Storing the outcome of a failed attempt as
   though it were the answer ends the machine there. Keep it open, and let the queue or a sweep ask
   again. See backfills and injection verdicts.
3. **"Refused" and "do not know" are different states.** A lost answer says nothing about what
   happened. See the reply send.

And one for writes: **a write to shared state names what it started from**, as a version
(`drafts.updated_at`), a sealed value (`mcp_servers.oauth`) or a status (`WHERE status = 'open'`), so
that whoever comes second finds out instead of overwriting.

## Threads and messages

**Message file.** absent → live → edited → tombstone. `merge` in `src/channels.js`: a file only moves
to a newer `version`, and a tombstone is final, so a replay in any order comes out the same.

**Read watermark.** One moving position per person and thread (`watermarks`, `advanceWatermark` in
`src/threads.js`). The write is conditional on being newer, so it never moves back.

**Room read flush.** idle → pending → flushed (`read:*` and the alarm, `src/room.js`). The flush
deletes a key only if it still holds what was written: D1 lets other events in, and a newer read may
have arrived.

**Thread grouping.** undecided → new topic, or folded by burst, Clef, vector or skeleton
(`threads.logical_*`, `src/rethread.js`). `skeleton_hash` is written before the work that can fail,
and `rethreaded_at` after all of it. So a retry starts from the top, and hash without decision means
the job died, which `sweepRethreads` picks up. A root skipped on purpose (a system notice) has no
hash. One that is skipped after a job died on it (its file is gone, or an edit emptied it) gets
`rethreaded_at`, since asking again finds the same.

**Thread label.** unlabeled → current → stale (`labels.labeled_through`, `src/label.js`). Labeling
what was labeled already is a no-op. `sweepLabels` picks up recent threads with a person's message
after their label. `labeled_through` means that Clef read the thread, so nothing else writes it: a
thread whose files are missing is recorded in `dead_jobs`, and the sweep leaves it for a day.

**Label review.** applies to the current label → history only. A review holds while its
`labeled_through` matches the label's (`src/review.js`).

**Resolution.** Clef decides → resolved → reopened → Clef decides. Not stored: `resolution` in
`src/resolve.js` works it out from the staff ✅ on the root, the latest customer message and
`labeled_through`. A reopened thread stays open until Clef has read that message. `isResolved` is the
rule for everyone but the page, which has its own copy.

**Status pile.** critical, hot, you, waiting, silent, team, quiet. Not stored: `statusOf` in
`ui/inbox.js`, from the thread, the viewer and the clock. Since nothing announces that time has
passed, the page looks again every minute while it is on screen.

**Channel filing.** filed → moving → re-filed (`src/refile.js`). "Moving" is not stored: a job's
payload and `threads.path` say where it stands. The watermarks of what has to be redone are cleared
before the thread row moves, since a retry compares against that row.

**Channel request.** open → confirmed, declined or withdrawn (`src/requests.js`). The one real status
column, and `CHECK` keeps it to those four; a partial unique index allows one open request per channel
and team. Every close is `WHERE status = 'open'`. Confirming claims the request first, then assigns;
a failed assignment opens it again, unless the rule was saved by then.

## Drafts and replies

**Shared draft.** none → version N → used or discarded → undo window → agent told (`src/drafts.js`,
`src/agent/discard.js`). `updated_at` is the version, and a save or discard names the one it started
from. A save from a draft that is gone is a conflict too. The agent hears of a discard after 30
seconds, past the inbox's 8-second Undo, and not at all if the draft came back.

**Reply send.** sending → sent → delivered → settled, or failed → retried or discarded, or unknown →
retried or sent again (`state.sending`, `ui/inbox.js`; `src/postkeys.js`). The same key on every retry
makes a retry safe: `post_keys` goes claimed → answered, or is removed when the platform refused. A
claim with no answer means nobody knows, and then only the person can decide to send it again. A key
lasts a day, so after that Retry turns into Send again.

**Reply box.** empty, own text, holds the draft, diverged (`boxState` in `ui/inbox.js`, from
`{ text, from, base }`). Only a box that holds the draft unchanged follows it.

**Draft preview.** off → showing → off (`draftPreview`, `ui/inbox.js`). `syncDraftPreview` is the one
place that decides, from the pointer and the focus, and the box is always given back as it was.

**New-thread composer.** editing → posting → awaiting → opened, or gave up after 30 seconds
(`state.compose`, `state.awaiting`). Every navigation clears `awaiting`, so a thread that arrives late
does not take over the screen.

**Message edit.** viewing → editing → saving → shown until the platform echoes it (`state.editing`,
`state.edits`). A failed save opens the editor again with the text. The overlay ends when the edit
comes back, or after a minute.

## Agents

**Thread agent.** first contact → delivered → idle armed → wrapped up; off at any point (`mark` and
`idle` in storage, `src/agent/delivery.js`). The schedule is armed before the mark moves, because a
retry finds nothing unseen afterwards. Deliveries run one at a time.

**Agent turn.** working → done or failed. Worked out from the transcript (`src/agent/turn.js`). A turn
that stopped half way with no run pending counts as failed after 15 minutes.

**Agent polling.** idle → polling → due while hidden (`loadAgent`, `ui/inbox.js`). A failed request
asks again; after five in a row the spinner goes. A thread opened with no copy (a fresh page) is
asked ahead (`askAgentAhead`), with the inbox or the thread, and every render of it waits up to
800 ms for that answer, so the turn shows with the messages. Asks at the same time share one
request (`askAgent`); an answer asked ahead is kept until `loadAgent` takes it, for ten seconds.

**Injection verdict.** unchecked → passed or flagged (`verdict:<id>`, `src/agent/delivery.js`). A
failed check is not a verdict: it is not stored, the queue retries the delivery, and reading the
thread asks again.

**Agent uploads.** empty → mounted → expired (`uploads`, `uploads-expiry`). The schedule is armed
before the list is stored, so a failure tries again.

**Seed session.** none → pinned to a knowledge base (`seed-pin:*`, `src/agent/seed.js`). The pin is
written before the pointer, and before anything is submitted, so two seeds at once make two pinned
sessions and never an unpinned one.

**MCP tool catalog.** unknown → checked → stale or error (`src/agent/mcp.js`). A failed check keeps
the servers the agent had. A change of configuration, or an hour, asks again.

**MCP server in a channel.** follows the server → on or off on its own → follows again (a row in
`mcp_server_switches`, or none, over `mcp_servers.enabled`; `src/mcpadmin.js`). Not stored as a
state: `serversFor` works it out per channel, and `serverWithHeaders` asks again on every connect,
so a catalog from before a switch cannot reach a server that is off. Deleting the server deletes its
switches.

## Credentials

**MCP OAuth grant.** none → signing in → connected → rejected (`grantState` in
`src/agent/mcpoauth.js`, from the `oauth_*` columns). One refresh at a time, under the `oauth_lock`
lease, which gives back only its own lease. Disconnecting and signing in do not wait for it, so a
refresh writes only over the sealed grant it started from. One that lost revokes what it got, unless
the grant is still the same one.

**Personal token.** none → valid → expired → refreshed, or gone (`user_tokens`, `src/post.js`). A
token Microsoft no longer accepts on any scope ends the connection, so the page asks to connect
again. A failure that may pass leaves it.

**Opspile OAuth codes and tokens.** issued → used or expired (`src/oauth.js`). Single use is
`DELETE … RETURNING`, so two redemptions cannot both win. The cron removes what ran out.

**GitHub installation.** seen → allowed → revoked. A row in `github_installations` is the allowance,
and it is checked each time a client connects. An agent's open client can keep its token until that
expires, at most an hour.

**Sign-in.** signed in → signed out → popup → back (`ui/app.js`). A redirect on any `/api` fetch is
the signal. The watch holds on to its own window, since another tab can sign in first.

## Background

**Job pipeline.** delayed → retried → dead (`consume` in `src/normalizer.js`). Five retries, then a
record in `dead_jobs`, which `/diag/dead` lists and sends out again. A dead `refile` does not heal by
itself: a sweep would apply today's rules to every channel.

**Backfill.** requested → done, with the messages or an error that stays (`src/backfill.js`). An error
that may pass leaves it open, for the queue and then `sweepBackfills`, until the thread has been quiet
for a week.

**Derived-data sync.** behind → caught up, per pipeline (`vectorized_through`, `indexed_through`,
`exported_through`). A sweep compares each with the thread. An edit does not move `any_at`, so a dead
job for an edit is not swept; it is in `dead_jobs`.

**Lazy fill-ins.** NULL means "not done yet" (`threads.last_text`, `messages.author_kind`,
`knowledge_bases.entries`). Each has a batch on the cron. NULL must not also mean "nothing there", or
the same rows stay at the head of the batch.

**Teams subscription.** none → active → expired or replaced, then caught up (`src/subscription.js`).
No stored state at all: Graph's list is the record, and `ensureSubscription` reconciles against it,
which makes it safe to run from the cron and the lifecycle endpoint at once.

**Discord poller.** off → first poll → incremental, with a recheck every fifth poll
(`src/poller.js`). The alarm is set before the poll, so a poll that fails cannot stop it. Each guild
fails on its own.

**Slack auto-join.** unjoined → refused, tried again after a week → joined (`slack_joins`,
`src/autojoin.js`). Transient errors are not recorded, and a join removes the row.

**Channel member list.** unknown → complete, stale or failed (`members_at`, `members_error`). What
reads it says nothing when it cannot be sure: a failed listing is not an empty channel.

**Channel label.** unlabeled → labeled → stale (`channel_labels`, `src/suggest.js`). Due when the
channel has activity, the ops teams change, or the label is a week old.

**GitHub mirror.** absent → importing → ready → refreshing → ready, or given up after an hour
(`repo_mirrors`, `src/agent/repos.js`). Reads stay on the old mirror until the new one is readable. A
repository taken off `agent_repos` keeps its mirror.

**COGS day.** missing → rolled up → rolled up again while it is today or yesterday
(`cogs_usage`, `src/cogs/rollup.js`). Each source of a day is replaced whole, but only for the
services whose queries answered: a failed query keeps what it counted before, and is not "nothing
used". A day counts as rolled up for the backfill once a source has any row for it, so each source
writes a marker row (`volume/days`, `analytics_engine/queries`) even on a quiet day. Storage is
measured once a day, the first run of the day (`workers/subscription` is the marker).

**COGS hours.** missing → rolled up → rolled up again while its day is today or yesterday → deleted
after eight days (`cogs_hours`, `src/cogs/rollup.js`). The flow of `meter` and `account` by the
hour, replaced per day and source as the days are; a day counts as rolled up for the backfill (the
last seven) once it has an `account` row (`analytics_engine/queries`, at hour 0, is the marker).

**Agent token meter.** never metered → metered up to the ledger (`cogs:usage` in the agent's
storage, `modelUsage` in `src/cogs/meter.js`). The first reading only sets the start: what the ledger
held before is not counted on one day. Readings are one at a time, so a round is counted once; a
ledger that went back (a new session) counts from nothing.

## In the page

**Socket.** connecting → open → reconnecting → banner (`listen`, `ui/inbox.js`). A socket that comes
back has missed what its room said, so the inbox and the open thread reload.

**Background catch-up.** live ↔ collecting changes (`changed`, `reload`). A hidden tab notes what
changed and reloads when it is shown.

**Expert list.** shown → open → pick, reject or dismiss (`state.expertsOpen`, `expertEvent`). `shown`
is sent once per list per opening, and `dismiss` when the ▾ list is left with nobody picked.

**Thread list.** fresh → held in place → re-sorted (`state.list`). While `listKey` is the same, the
rows stay where they are.

**Search.** idle → loading → results or error (`state.search`). `seq` drops the answer to anything but
the latest question.

**Knowledge-base editor.** clean → editing → saving → saved, or conflict, unnamed or problem
(`fileState` in `ui/kb.js`). One save at a time, and a save names the blob it was written from.

**Notification permission.** unasked → asked → granted or denied (`Notification.permission` and
`opspile.notify.asked`). The browser's own state is the record, and the first visit asks once.
