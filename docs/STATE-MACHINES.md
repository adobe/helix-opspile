# State machines

opspile has two status columns, `channel_requests.status` and `bash_requests.status`. Everything
else that has a lifecycle keeps it in the shape of its data: a nullable timestamp, a watermark, whether a row exists, a lease,
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
have arrived. Until then the inbox has the thread unread, so the page that sent a read holds it for
30 seconds (`readsSent`, `keepReads` in `ui/inbox.js`): a reload meanwhile shows the thread read
unless something came in after the read.

**Thread grouping.** undecided → new topic, or folded by burst, reply, Clef, vector or skeleton → (a
conversation's root folded by Clef that gets a person's reply in its own platform thread) split
(`threads.logical_*`, `src/rethread.js`). `skeleton_hash` is written before the work that can fail,
and `rethreaded_at` after all of it. So a retry starts from the top, and hash without decision means
the job died, which `sweepRethreads` picks up. A root skipped on purpose (a system notice) has no
hash. One that is skipped after a job died on it (its file is gone, or an edit emptied it) gets
`rethreaded_at`, since asking again finds the same. Split is final: `logical_via = 'split'`,
`logical_thread` cleared and `rethreaded_at` moved to the split (for the export sweep), and neither
a forced re-threading nor a burst pulls it in again. The split is conditional on the group the root
is in (`WHERE logical_thread = ?`), so it only undoes the fold it saw. A fold as an addressed reply
(`logical_via = 'reply'`: the root @-mentions somebody of the conversation, minutes after its latest
message) is never split either, like a burst member's: the conversation went on in that platform
thread, so the replies there are the group's. Routed is final the other way:
a folded root whose platform thread got one of its group's replies (the entry's latest, `target` in
`src/post.js`) gets `routed_at`, set once (`routed_at IS NULL`) and before the post goes out, so the
reply cannot arrive first and split it. It is never cleared, also not when the post fails: a root
kept in its group is no harm, and a lost answer may have been posted. Neither `dethread` nor a
forced re-threading moves it, nor does a split take it along in a burst. A deleted root takes no
one in (no burst joins it), but a group whose first root is deleted later keeps its key: the inbox
reads its entry from the members that are still there (`latestMember`, `fold` in `src/api.js`).

**Thread label.** unlabeled → current → stale (`labels.labeled_through`, `src/label.js`). Labeling
what was labeled already is a no-op. `sweepLabels` picks up recent threads with a person's message
after their label. `labeled_through` means that Clef read the thread, so nothing else writes it: a
thread whose files are missing is recorded in `dead_jobs`, and the sweep leaves it for a day.
A label written before migration 0059 has no `tech` (null, not `{}`): the thread view then goes by
`channel_tech.thread` until the thread is labeled again.

**Label review.** applies to the current label → history only. A review holds while its
`labeled_through` matches the label's (`src/review.js`).

**Resolution.** Clef decides → resolved → reopened → Clef decides. Not stored: `resolution` in
`src/resolve.js` works it out from the staff ✅ on the root, the latest customer message and
`labeled_through`. A reopened thread stays open until Clef has read that message. `isResolved` is the
rule for everyone but the page, which has its own copy.

**Status pile.** critical, hot, you, waiting, silent, team, quiet. Not stored: `statusOf` in
`ui/inbox.js`, from the thread, the viewer and the clock (for normal and low urgency, a clock
that stops on weekends: `waitedFor`). Since nothing announces that time has
passed, the page looks again every minute while it is on screen.

**Channel filing.** filed → moving → re-filed (`src/refile.js`). "Moving" is not stored: a job's
payload and `threads.path` say where it stands. The watermarks of what has to be redone are cleared
before the thread row moves, since a retry compares against that row. Two things start a move: a
rule change in the admin pages (`plan`, `enqueueMoves`), and a change in what the rules read of one
channel (`followChange`): its name, its Teams team's name or its Slack Connect teams, from a Slack
rename event, a Teams notice of a rename (which looks the channel up again) or a lookup that finds
them changed (a day after the last, also from the cron). That one queues jobs only when the rules
classify the channel differently than before, before the channel's row is written (the row is
the guard: a failure to queue fails the job with the old row, and its retry finds the change
again; the jobs wait 30 seconds, so they read the new row), and before the message that came
with the change is filed: that message points its thread's row at the new folder, so a job moves both the folder it
was queued with and the row's. A rename event older than the channel's row (`fetched_at`: out of
order, or a replay of pile 1) changes nothing, and the write says so again, so of two handled at
once the later wins. A job from `followChange` carries the classification it moved from (`was`):
a thread a newer message already re-filed in its row still gets its derived data redone.

**Channel request.** open → confirmed, declined or withdrawn (`src/requests.js`). The one real status
column, and `CHECK` keeps it to those four; a partial unique index allows one open request per channel
and team. Every close is `WHERE status = 'open'`. Confirming claims the request first, then assigns;
a failed assignment opens it again, unless the rule was saved by then.

## Drafts and replies

**Shared draft.** none → version N → used or discarded → undo window → agent told (`src/drafts.js`,
`src/agent/discard.js`). `updated_at` is the version, and a save or discard names the one it started
from. A save from a draft that is gone is a conflict too. The agent hears of a discard after 30
seconds, past the inbox's 8-second Undo, and not at all if the draft came back. Each step is an
event in `draft_events` (`src/draftevents.js`): saved, then sent (`how`: me, app, agent) or
discarded (by a person, or by the agent: withdrawn). Undo is a save of the same text, with no
draft, by the person who discarded it, within a minute (`UNDO_SECONDS`): it deletes the discard's
event and the draft goes on with its `created_at` and `origin`, as if it had not been discarded.
`origin` (who saved the first version) stays through every version and every move into a group;
`origin_body` follows only that person's saves.

**Reply send.** sending → sent → delivered → settled, or failed → retried or discarded, or unknown →
retried or sent again (`state.sending`, `ui/inbox.js`; `src/postkeys.js`). The same key on every retry
makes a retry safe: `post_keys` goes claimed → answered, or is removed when the platform refused. A
claim with no answer means nobody knows, and then only the person can decide to send it again. A key
lasts a day, so after that Retry turns into Send again. A reply as the bot (`sendAsApp`) shows the same
way, looking like the bot's replies, from sending to sent; one that did not go out leaves the thread
and the draft line says why. Once sent it waits up to three minutes to come back, not one.

**Reaction made here.** asked → taken → settled, or refused (`state.reacting`, `ui/inbox.js`). It
shows on the message at once. It goes once the thread's reactions agree after the platform took it,
when the platform refused it, or after a minute. A second click on the same emoji replaces it.

**Reply box.** empty, own text, holds the draft, diverged (`boxState` in `ui/inbox.js`, from
`{ text, from, base }`). Only a box that holds the draft unchanged follows it.

**Draft line.** closed → open → closed (`draftOpen`, `ui/inbox.js`): **View draft**, a click, shows
all of the draft on its line, rendered; a mouse resting on the line for `HOVER_DELAY_MS` opens it
too (`draftPeek` names the thread it opened), and leaving closes only what it opened. Hide draft and
Escape close either; a new line not under the pointer, or another thread's, drops the pointer's. The
open line grows upwards from the pane's bottom edge, so it stays under the pointer. The reply box
only ever holds what you typed or took in: a source shown beside the draft leaves it alone (it used
to show the draft too, a second copy next to an opened line).

**New-thread composer.** editing → posting → awaiting → opened, or still awaited after five minutes
(`state.compose`, `state.awaiting`, `started`). From posting on, the pane shows the thread as it will
look (`renderStarted`), with a reply box whose replies wait for the platform's id of the thread
(`started.ready`), then go out as any reply does; a failed post goes back to editing, with the
text and those replies. The team's room saying the
thread is here opens it at once; the page also asks, less often each time. Every navigation clears
`awaiting`, so a thread that arrives late does not take over the screen.

**Message edit.** viewing → editing → saving → shown until the platform echoes it (`state.editing`,
`state.edits`). A failed save opens the editor again with the text. The overlay ends when the edit
comes back, or after a minute.

## Agents

**Thread agent.** first contact → delivered → idle armed → wrapped up; off at any point (`mark` and
`idle` in storage, `src/agent/delivery.js`). The schedule is armed before the mark moves, because a
retry finds nothing unseen afterwards. Deliveries run one at a time.

**Agent turn.** working → done or failed. Worked out from the transcript (`src/agent/turn.js`). A turn
that stopped half way with no run pending counts as failed after 15 minutes. A finished one is kept
in D1 (`agent_turns`, one row per entry, `src/agent/kept.js`) for `GET /api/thread`: written a moment
after the answer, or by `status()` when it differs from the last one kept (in the agent's storage,
`kept-turn`). An older turn never replaces a newer one; no turn (a reset) deletes the row. A turn in
progress is never kept. A turn that answers a sidebar message is kept as its answer instead
(`sidebar_messages`, below), and the row stays the turn before it.

**Agent polling.** idle → polling → due while hidden (`loadAgent`, `ui/inbox.js`). A failed request
asks again; after five in a row the spinner goes.

**Injection verdict.** unchecked → passed or flagged (`verdict:<id>`, `src/agent/delivery.js`). A
failed check is not a verdict: it is not stored, the queue retries the delivery, and reading the
thread asks again.

**Agent uploads.** empty → mounted → expired (`uploads`, `uploads-expiry`). The schedule is armed
before the list is stored, so a failure tries again.

**Computer shell.** just-bash ⇄ slicc-kernel, and with the kernel one image or another
(`agent_tool_options`, the team's `runtime` and `image`; `runtime` and `image` in the agent's
storage, the ones its Workspace was made for; `src/agent/kernel.js`). A team without a row, or
with a value this deployment does not know (written by a later one, read after a rollback), has
just-bash, and `base`. The agent compares them before each delivery (`syncTools`), as it does its
tools: a change ends the kernel if one runs, drops the Workspace, and is stored before the next
command makes a new one, over the same files. An image the bucket does not have is still the
team's choice: the kernel does not boot, the command fails saying why, and nothing falls back. A command still running in the old shell is ended. The
kernel's own root stays in the agent's SQLite when the team goes back (`slicc_*`, the image and
`/tmp`): nothing reads it until the team chooses the kernel again.

**Kernel image.** Not a state of the agent: a kernel mounts its team's image from the bucket at
every boot, read-only, and keeps nothing of it (`src/agent/image.js`). What has an order is the
bucket (`scripts/computer-images.mjs`): blobs are written first, then the layers that name them,
then the manifests that name the layers, then the index, so nothing ever names what is not there;
and layers and blobs are named by their content and never deleted, so a kernel that booted on an
older manifest goes on reading its layers after an upload. A running kernel keeps the image it
booted with until it boots again.

**Command request.** pending → running → done, timeout or failed; pending → denied or expired
(`bash_requests.status`, `src/bashrequests.js`, `src/agent/bashrequest.js`). The agent asks
(`request_bash`), and a person runs or denies it; `CHECK` keeps the status to those seven, and every
transition is `WHERE status = …`, so of two clicks, or a click at the deadline, one wins and the
other is told who did. The deadline's schedule is armed before the request is stored (a deadline
with no request does nothing), and a request past its deadline reads as expired before the schedule
has written it, so it cannot be run in between. A run is claimed in the agent's own object, after
its watchdog is armed: the values a person filled in live only in that object's memory, so a run
whose object restarted is one nobody is running, which the watchdog (the timeout and 30 seconds
later) settles as failed. It never runs again by itself: a command may not be safe to repeat. A
nonzero exit is `done`, not failed: the command ran. Exit code 124 is `timeout` only when the run
took its whole timeout: the shell says it stopped a run no other way, and a command can exit with
124 by itself. The kernel's shell says it with the signal that ended bash (143, or 137), under the
same condition. `told_at` is written last, after the agent was
told how the request ended; one that ended untold (the agent's storage failed) is told at its
deadline, without what the command printed, which is kept nowhere.

**Sidebar message.** asked → answered (or failed → answered) (`sidebar_messages`, `src/sidebar.js`,
`src/agent/sidebar.js`). The person's row is written before the agent is told, and deleted when the
agent did not take it, so an answer is only ever kept for a message the thread has (the insert
selects it). The answer's id is the message's with `:answer`: a turn kept twice writes one answer, a
failed one is replaced by the next attempt's, and a finished one by nothing. It is never dated
before its message. Whether a turn is the sidebar's is not stored: it is read from the turn's input
(`turnSidebar`), at every `post_message`, `add_reaction` and `request_membership`, which refuse
while it is, and when the transcript cannot be read. A delivery follows a pending sidebar message
instead of steering into it (`whenBusy`), so no other input becomes its turn's; one that did anyway
ends it as failed (`sidebarTurns`). Answers are kept from every sidebar turn of the transcript, each
once per state and text (`sidebar-kept` in the agent's storage, written after them, and only when it changed), so a turn
queued right behind one does not hide it.

**Sidebar mode.** off → on → off (`side.key`, `ui/inbox.js`): one thread at a time, left by ✕ Exit,
Esc, or opening another thread. What was typed in the sidebar box stays per thread in the tab, and
a message the inbox did not take goes back into it.

**Seed session.** none → pinned to a knowledge base (`seed-pin:*`, `src/agent/seed.js`). The pin is
written before the pointer, and before anything is submitted, so two seeds at once make two pinned
sessions and never an unpinned one.

**Agent experiment arm.** before → in an arm → after (`src/experiments.js`). Not stored: worked
out from the clock and the agent's name at every model request (the retention it asks for) and at
every metering (the tag on its tokens), so a deploy or an eviction cannot leave an agent in the
wrong arm. The tokens metered first after the window opens or closes may include a round from just
before it, counted with the arm of the moment.

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

**Computer secret.** none → set → changed → deleted (a row in `agent_secrets`,
`src/secretadmin.js`). Not stored anywhere else: the shell has only a placeholder, and the gateway
(`forward` in `src/agent/secrets.js`) reads the row on every request that names it, by the agent's
team and customer as they are then, so a change, a deletion or a moved thread counts from the next
request. Changing it without a value keeps the sealed one.

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

**Topic map.** none → built → a week old → built again (`topic_maps`, `src/topicmap.js`). No state in
between: the cron or Rebuild builds one in a single request, a row when it is done, and the newest
five are kept. A build that fails (too few threads, no index) writes nothing and leaves the last map
on the page; two at once both write a row, and the newer is shown.

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
reads it says nothing when it cannot be sure: a failed listing is not an empty channel. Stale after
a week; for a mention suggestion that matches nobody (`src/post.js` `mentionable`), after 30
seconds, so someone just added is found. Whoever moves `members_at` lists it: one listing at a
time.

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
measured once a day, the first run of the day (`workers/subscription` is the marker); the Access
seats separately, by the first run of the day that read them (any `zero_trust` row is the marker),
so a failed read is tried again on the next run.

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

**Thread list.** fresh → held in place → re-sorted (`state.list`). While `listKey` is the same, the
rows stay where they are.

**Search.** idle → loading → results or error (`state.search`). `seq` drops the answer to anything but
the latest question.

**Knowledge-base editor.** clean → editing → saving → saved, or conflict, unnamed or problem
(`fileState` in `ui/kb.js`). One save at a time, and a save names the blob it was written from.

**Knowledge-base prefetch.** not here → in flight → text, or not here again (`blobs` in
`ui/kb.js`). Kept by blob hash, so a text is never stale for its hash; the listing (`state.files`)
says which hash a path has, and is the watermark: a save relists (unless another save started while
it was read), and so does showing the tab again after `RELIST_MS`. A failed batch leaves its hashes
not here, and opening one reads it by its path.

**Code highlighter.** not loaded → loading → loaded, or failed → loading again (`highlighter` in
`ui/inbox.js`). The first code block rendered starts the import; until it has loaded, code is plain
text, and loaded is part of the key of what is rendered, so the list and the open thread render
again with it. A failed import is not final: a code block a minute later tries again.

**Command fields.** empty → typed → sent, or remembered → filled in (`bashTyped`, `vault` in
`ui/inbox.js`). What is typed into a request's fields stays with the request in the tab, so a card
drawn again keeps it, and goes with Run. Remembered values are read once a page, the first time a
card has a field: a value that no longer decrypts (its key is gone) is not there. While the room
says a request changed and the thread is fetched again, the cards stay as they are: the open
thread keeps its cached requests until the fetch replaces them, so a click shows on its card at
once.

**Drawer (phones).** closed → open → closed (`linesDrawer.key`, the thread whose drawer is open,
`ui/inbox.js`). The tab opens it; ✕, a tap beside the sheet, Escape, taking the draft into the
reply box, sending it, and nothing left in it close it, and another thread's drawer is never
open. What the tab says is worked out from the thread's requests and the draft its line shows
(`lineDraft`: not one on its way), each time either line is drawn. While the thread is fetched
again the drawer stays as it is, open or closed. Only the stylesheet knows whether it is a
drawer at all: on a wider screen `linesDrawer.key` changes nothing that shows, and a screen that
grows past the phone's breakpoint closes it. Open, the sheet is a modal dialog: Tab goes round in
it.

**Earlier commands.** latest only ↔ all that ended (`bashEarlier`, by thread, `ui/inbox.js`). Of
the requests that ended within the hour only the latest shows, until its button shows the rest;
it stays so for the thread in the tab. Those that wait or run always show.

**Notification permission.** unasked → asked → granted or denied (`Notification.permission` and
`opspile.notify.asked`). The browser's own state is the record, and the first visit asks once.

**Notification sound.** silent → unlocked → loaded or tone (`audio` and `chime` in `ui/inbox.js`). A
page plays sound only after a click or key press in it, so the first one creates the audio and
fetches `/notify.mp3`; a reload starts silent again. A sound that does not load plays a short tone.
On unless `opspile.notify.sound` is `off`, per device; one tab plays it (the `opspile:chime` lock).
