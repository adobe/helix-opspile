# State machines

opspile has four status columns, `channel_requests.status`, `bash_requests.status`,
`tool_requests.status` and `portal_requests.status` (and the customer portal, in its own database, `lobbies.status`). Everything
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
to a newer `version` (or, at the same version, to what a higher `FORMAT` writes differently: its
body or `dropped`), and a tombstone is final, so a replay in any order comes out the same.

**Read watermark.** One moving position per person and thread (`watermarks`, `advanceWatermark` in
`src/threads.js`). The write is conditional on being newer, so it never moves back.

**Room read flush.** idle → pending → flushed (`read:*` and the alarm, `src/room.js`). The flush
deletes a key only if it still holds what was written: D1 lets other events in, and a newer read may
have arrived. The room announces a read twice: `read` when it is pending, `reads` once it is
flushed. Until then the inbox has the thread unread, so the other pages reload on `reads`, not on
`read` (`heardRead` in `ui/inbox.js`), and the page that sent a read holds it for 30 seconds
(`readsSent`, `keepReads`): a reload meanwhile shows the thread read unless something came in after
the read.

**Thread grouping.** undecided → new topic, or folded by burst, reply, Clef, vector or skeleton → (a
conversation's root folded by Clef that gets a person's reply in its own platform thread) splitting
→ split (`threads.logical_*` and `split_from`, `src/rethread.js`). `skeleton_hash` is written
before the work that can fail, and `rethreaded_at` after all of it. So a retry starts from the top, and hash without decision means
the job died, which `sweepRethreads` picks up. A root skipped on purpose (a system notice) has no
hash. One that is skipped after a job died on it (its file is gone, or an edit emptied it) gets
`rethreaded_at`, since asking again finds the same. Split is final: `logical_via = 'split'`,
`logical_thread` cleared and `rethreaded_at` moved to the split (for the export sweep), and neither
a forced re-threading nor a burst pulls it in again. The split is conditional on the group the root
is in (`WHERE logical_thread = ?`), so it only undoes the fold it saw. Since that write is its guard
and comes first, it writes what is left with it: `split_from`, the group it left. While that is set,
the split is unfinished (its root file, the burst roots that go along, the open inboxes), and the
reply's retry, a later reply, or re-threading (which `sweepRethreads` sends out for it an hour
after `rethreaded_at`) finishes it; each step can be done again, a burst root that moved already is
moved again, and `split_from` is cleared last. A fold as an addressed reply
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
A label written before migration 0059 has no `tech` (null, not `{}`): the thread view then shows no
technologies until the thread is labeled again (`POST /api/admin/relabel`).

**What a thread shows, by index.** `thread_tech` (migration 0072, `src/follows.js`) is derived from
`labels.tech`: one row per technology, written in the same `db.batch` as the label (all of the
thread's rows deleted, then what the label shows inserted), so the two never disagree, and the
migration fills it from the labels there were. A label without `tech` has no rows, as above. It is
what following a technology reads (below); a relabel that changes it says what it gained and lost,
and the label job tells the rooms of the teams that follow those (`announceFollowed` in
`src/normalizer.js`), best effort, as every room's.

**Following a technology.** not followed → followed → not followed: a row in `team_follows` or
`person_follows` (migration 0072), nothing else. Configuration, like the shares: whose inbox has a
thread is worked out from it, its thread's `thread_tech` and its group each time
(`followingTeams`, `followersOf`), never stored, so a relabel, a re-threading or a follow taken back
moves the thread in or out of the inboxes at once, and nothing has to be undone. A person's row
counts only while they are on an ops team (`COUNTED_PERSON_FOLLOWS`); leaving every team keeps the
row and ends its effect. A relabel's room event names the technologies it gained or lost (`tech`), so
a person whose thread no longer shows what they follow still hears of it, and their inbox lets it go.

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

**A follow rule's share.** wanted → shared → gone (`channel_teams` rows with `added_by`
`rule:<id>`; `src/followrules.js`). Not stored as a state: `syncFollowRules` works out what the
follow rules want from the rules and `channels` and writes the difference, after every rule change
(`applyRules` in `src/admin.js`, once the rules are saved) and on the cron, which also catches a
channel seen or renamed since and a sync that failed. It only adds where no row is (a share by hand
of the same channel and team stays a share by hand) and only deletes `WHERE added_by = 'rule:<id>'`,
so it never takes away a share by hand. A channel filed under the rule's team is not shared with it.
`DELETE /api/admin/share` refuses a rule's share: the cron would add it again.

**Rule conflict.** open → settled or kept → open again (`src/ruleconflicts.js`). Computed from the
team rules and the channels on every read, never stored; a settled one is gone because the rules
changed, or because a manual assignment now decides each of its channels. A kept one is a row of `rule_conflict_keeps` (migration 0086) with the conflict's
`fingerprint` (its rules and the channels both match): it is hidden while the fingerprint holds, and
open again once a rule or a channel of it changes. Settling names what it started from: the
fingerprint the page showed, or 409.

**Channel request.** open → confirmed, declined or withdrawn (`src/requests.js`). The one real status
column, and `CHECK` keeps it to those four; a partial unique index allows one open request per channel
and team. Every close is `WHERE status = 'open'`. Confirming claims the request first, then assigns;
a failed assignment opens it again, unless the rule was saved by then. `move` (migration 0071) is fixed when the
request is made: a move request confirms as a move whoever holds the channel, the others move it
only out of the admin team and share it otherwise.

**Adobe's bot.** undecided → Adobe's ⇄ not Adobe's (`identities.ours`: NULL, 1, 0; `src/ourbots.js`).
Only the admin page writes it, never back to NULL, and the identity's refresh (`getIdentity`) leaves
it out of its upsert. The bot's messages are not rewritten: a message's frontmatter keeps the side it
was written with, and the thread view follows the flag over it once it is decided (`botAuthor` in
`src/api.js`); `messages.staff` is set to match on every change.

**A bot's name and picture.** the platform's ⇄ an admin's (`identities.display_name`,
`display_avatar`: NULL or set; `src/ourbots.js`). Only the admin page writes them, and the
identity's refresh leaves them out of its upsert. Setting or clearing the name rewrites
`messages.author` of the bot's messages (and `threads.last_author` where it was the bot's old
name); their frontmatter keeps the name they were written with, which `botAuthor` replaces in
the thread view.

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
`origin_body` follows only that person's saves, and an Undo too: a discard by somebody else of a
draft that is not its `origin_body` keeps that in `draft_undo` until the Undo takes it or its
minute is over (pruned at the next discard and by the cron).

**Offer to let the agent post.** not asked → asked → switched on, or declined (`src/postoffer.js`,
`offerPosting` in `ui/inbox.js`). Nothing is stored for it but its end: it is worked out on every
send of a draft whose `origin` is the agent, from the person's `sent` events in the channel
(`OFFER_AFTER`, three), whether they may switch **Post messages** there, and the switches. Asked is
a note in the inbox that stays until it is answered; a yes is the channel's switch on, which ends it
for everyone, a no is the channel in the person's `postingDeclined` (`person_settings`), for them
only. A note that goes any other way (the next note replaces it, the page is left) is no answer: the
next of the agent's drafts they send asks again. Any switch row for the channel, on or off, ends it
too: the channel was decided on.

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
`{ text, from, base }`). Only a box that holds the draft unchanged follows it. A part of the
draft taken in (Edit selection, Add selection to reply) is the draft diverged, cut down to that
part: it names the version, so a reply with it uses the draft up, as a part sent from the line
does.

**Draft line.** closed → open → closed (`draftOpen`, `ui/inbox.js`): **View draft**, a click, shows
all of the draft on its line, rendered; a mouse resting on the line for `HOVER_DELAY_MS` opens it
too (`draftPeek` names the thread it opened), and leaving closes only what it opened, unless text
is selected in it: then it stays open, as View draft leaves it, so the selection is there to copy.
While the pointer's is open its button is Keep draft open, which makes it View draft's (`draftPeek`
cleared): it stays open wherever the pointer goes, the sidebar too. Hide draft and
Escape close either; a new line not under the pointer, or another thread's, drops the pointer's. The
open line grows upwards from the pane's bottom edge, so it stays under the pointer. The state changes
at once; only the line's height follows, growing or shrinking (`resizeDraft`), and a re-render while
it moves goes on from where it is. The reply box
only ever holds what you typed or took in: a source shown beside the draft leaves it alone (it used
to show the draft too, a second copy next to an opened line).

**Reply box's rows.** hidden → growing → shown → folding → hidden (`foldRow`, `ui/inbox.js`; the
row's `__fold` holds its running animations): the tray of files, the draft line and the command
cards. A change within the open thread grows or folds a row, and a later change takes over from
where it is; a row that comes with the thread (a new element, its `__html` unset) is there at once,
as it is with reduced motion and in the phone's drawer. A folding row still holds what it held,
inert, and is emptied once it is hidden; a page in the background, which draws no frames, gets
there a moment after the animation would have ended (`settled`).

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

**Agent wake-up.** set → due → told, or dropped (`wakeups` in the agent's storage,
`src/agent/wakeups.js`). One the agent set with `wakeup_after` is due at its time; one set with
`wakeup_after_idle` is armed again from every later message, by `armIdle` when the wrap-up is,
before the mark moves, and a schedule whose `mark` is not the wake-up's is stale and does nothing.
Due, it leaves the list before the agent is told, so it wakes it once; an agent turned off since
drops it unsaid. At most five wait.

**Agent turn.** working → done or failed. Worked out from the transcript (`src/agent/turn.js`). A turn
that stopped half way with no run pending counts as failed after 15 minutes. A finished one is kept
in D1 (`agent_turns`, one row per entry, `src/agent/kept.js`) for `GET /api/thread`: written a moment
after the answer, or by `status()` when it differs from the last one kept (in the agent's storage,
`kept-turn`). An older turn never replaces a newer one; no turn (a reset) deletes the row. A turn in
progress is never kept there. A turn that answers a sidebar message is kept as its answer instead
(`sidebar_messages`, below), and the row stays the turn before it. A compaction that summarized the latest
turn's input leaves no turn in the transcript: that is not a reset, and the kept turn stays
(`cut` from `latestTurn`, `keepTurn` in `src/agent/agent.js`).

**Agent live turn.** absent → kept, then replaced by every newer reading (`agent_live`, one row per
entry, `keepLive` in `src/agent/kept.js`): the latest turn as `latestTurn` reads it, in any state,
sidebar turns included, `null` before the first. The agent writes it a moment after it accepts work
(`harness.submit`), after each round of tools, after an answer or a failed request, and from
`status()`; only when it changed since the last one kept (`live-turn` in the agent's storage), and a
working one again a third of the stuck time after the last, so a long turn stays fresh. `at` is when
the transcript was read, and the write is conditional on it being newer, so readings that cross keep
the latest. `GET /api/agent` answers from the row, without the agent's object. It asks the agent
instead when there is no row (an agent that has not worked since migration 0070) or the row has said
`working` for 15 minutes without being written again (its object stopped half way): the agent's
answer, `failed` once the transcript says so, is kept again then. A row is never deleted; a thread
whose channel's agent is turned off is answered `enabled: false` before it is read.

**Expert suggestion.** suggested → withdrawn, or fulfilled (`expert_suggestions`, `suggestExpert`
in `src/experts.js`). Withdrawing deletes the row; suggesting the person again replaces it, with
the new reason. Fulfilled is not stored: the person is in the thread (a message or a mention of
theirs), so the row stays but the header and `list_experts` leave it out, and it no longer counts
toward the three a thread may have. Both go by the person, whichever of their accounts was named.

**Renderer kernel.** none → booting → booted (src/graphviz/worker.js, one per isolate of the
renderer Worker). The first layout boots it; a failed boot leaves none, and the next layout
tries again. A layout that runs past its ten seconds ends the kernel, back to none: whatever it
was stuck in goes with it.

**Stack drawing.** none → drawn → drawn again (`stack.md` of a customer's knowledge base,
`src/stack.js`). Whether the file exists is the state; its `generated` stamp says who drew it last
and when. The first drawing is a create (refused when one appeared meanwhile); every later one
names the `base` it was drawn from, so an agent never draws over a colleague's or a person's newer
one unseen. A write that cannot be drawn is refused, so `drawn` always parses. Deleting the file
in the editor goes back to none; the inbox then draws nothing. `org_stacks` follows every write
of the file (its parts, or `[]`); one missing is filled in by the cron. The inbox keeps an
answer of `GET /api/kb/stack` for a minute (`stackOf`, `ui/inbox.js`).

**Agent polling.** idle → polling → due while hidden (`loadAgent`, `ui/inbox.js`). A failed request
asks again; after five in a row the spinner goes.

**Injection verdict.** unchecked → passed or flagged (`verdict:<id>`, `src/agent/delivery.js`). A
failed check is not a verdict: it is not stored, the queue retries the delivery, and reading the
thread asks again.

**Agent uploads.** empty → mounted → expired (`uploads`, `uploads-expiry`). The schedule is armed
before the list is stored, so a failure tries again.

**Computer image.** one image ⇄ another (`agent_tool_options`, the team's `image`; `image` in
the agent's storage, the one its Workspace was made for; `src/agent/kernel.js`). A team without
a row, or with a value no image can have, has `base`. The agent compares them before each
delivery (`syncTools`), as it does its tools: a change ends the kernel if one runs, drops the
Workspace, and is stored before the next command makes a new one, over the same files. A command
still running in the old kernel is ended. An image the bucket does not have is still the team's
choice: the kernel does not boot, the command fails saying why, and nothing falls back. The
kernel's own root stays in the agent's SQLite from one image to the next (`slicc_*`: `/root`,
`/etc`, `/tmp`). The shell itself was a choice too, just-bash ⇄ slicc-kernel (`runtime`), until
just-bash was removed: migration 0076 deleted the teams' rows, and an agent's stored `runtime` is
read by nothing.

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

**Tool request.** pending → granted → revoked; pending → denied (`tool_requests.status`,
`src/toolrequests.js`, `src/agent/toolrequest.js`, `decideTool` in `src/agent/stub.js`). The agent
asks (`request_tool`) only while it answers a sidebar message, whose id the request keeps, and a
person who may work the thread decides; `CHECK` keeps the status to those four, and every
transition is `WHERE status = …` with its clock (`deadline` for a decision, `expires_at` for an
end), so of two clicks one wins and the other is told who did. Two states are read off the clock
and never written: a pending request past its `deadline` (24 hours) is `expired`, a grant past its
`expires_at` (24 hours after it was granted) has `ended`; both let the agent ask again, and nothing
wakes up for them. A grant is not installed by the decision: the agent reads its grants with its
switches (`toolsFor`, `serversFor`, `serverWithHeaders`) before each input, and the person's
sidebar message that says it was granted is one, so the agent has it from the turn that answers
it. An ending is noticed the same way, at the next input (`revoke` also asks the agent to read
them at once); a turn running across an ending keeps the tool until it ends. Granted or denied
says so as a sidebar message of the person's; when the agent cannot be told, the message is
deleted and the decision stands.

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

**Sidebar answer seen.** unseen → seen, and unseen again when a failed answer is replaced
(`sidebar_messages.seen_at`, migration 0078, `seeSidebar` in `src/sidebar.js`). Only the person it
answers (`person` on the agent's row) has it unseen, and only they mark it, by id: the inbox does
when the answer shows to them (the panel beside the thread, or its conversation unfolded in it),
on screen and not viewing as someone else (`seeSide`, `ui/inbox.js`). The write is conditional
(`seen_at IS NULL`), so an answer that came after what was shown stays unseen, and the replace of
a failed one clears it, since that is a new answer. The page hides what it marked at once
(`sideSeen`), whatever a reload in between brings, and gives it back if the write failed; the
answers kept before the migration count as seen. Unseen answers are the list's purple badge
(`sideNew`), and keep the thread in unread only.

**Sidebar mode.** off → on → off (`side.key`, `ui/inbox.js`): one thread at a time, left by ✕,
Esc, or opening another thread. What was typed in the sidebar box stays per thread in the tab, and
a message the inbox did not take goes back into it. Where it shows is not a state of its own: it
is worked out from the content area's width (`side.wide`, `syncSideRoom`), whenever the
thread's column changes its width; not from the thread's own, which the panel changes. With room, the mode is the panel beside the thread
(`sidePaneled`), which someone who may not talk to the agent can open too, to read; without, it is
the thread's reply box turned into the sidebar's (`sideInline`), only for who may talk to it. The
panel is the open thread's: it goes whenever `side.key` is not the open thread (`syncReading`).
The panel's motion is not a state either: as you enter or leave the sidebar (`side.motion`, only
while that render runs) it moves from gone (`sideMotion.p` 0) to open (1) or back, out of the
line that was picked (`side.joined`, kept until the panel is gone) where that line is in sight,
else sliding in from the edge; otherwise, and with reduced motion, it is there or gone at once.
Gone is only when the motion back ends (`goneSidePanel`): a render while it goes does not cut it
short, and entering again turns it around.

**Seed session.** none → pinned to a knowledge base (`seed-pin:*`, `src/agent/seed.js`). The pin is
written before the pointer, and before anything is submitted, so two seeds at once make two pinned
sessions and never an unpinned one.

**Dream.** due → started → taken → ended (done, unanswered or timeout) (`kb_dreams`, `src/dreams.js`;
the session in the knowledge-base agent, `src/agent/dream.js`). The row is written before the agent
is asked, in one statement with the check that there is no open dream for the customer and none
started since its latest message, so a quiet spell dreams once. Then the agent is asked
(`submitted_at`); a refusal keeps the error and leaves the row open, and every cron run asks an
unsubmitted row again, the same dream (its session and operation, `dream-session:<id>` and
`dream:<id>`, accepted once). A taken row is asked where it stands; settled, it ends with the
knowledge base's entries. A row open for three hours ends as `timeout`, whatever the agent still
does. The session's pin (`seed-pin:<session>`) and what it is (`dream-of:<session>`) are written
before its pointer, as a seed's.

**Agent experiment arm.** before → in an arm → after (`src/experiments.js`). Not stored: worked
out from the clock and the agent's name at every model request (the retention and model it asks
for) and at every metering (the tag on its tokens), so a deploy or an eviction cannot leave an agent
in the wrong arm. The tokens metered first after the window opens or closes may include a round from
just before it, counted with the arm of the moment. That is the cache experiment's.

**Model experiment pin.** undecided → pinned to an arm, or to none (`arm:model` in the agent's
storage, `src/agent/arms.js`), for good. Decided once, when Pi first opens: an agent with nothing
delivered or metered (`mark`, `cogs:usage`) inside the window gets its thread's arm, any other
none. Kept in storage first, then written to D1 (`agent_arms`), then marked `recorded`: a failed
write is tried again at the next open, and the pin is never decided twice, so a thread never
changes model. A draft counts for the arm of its thread's pin.

**Idle compaction.** none → armed → compacted, or skipped (`compact-idle` in the agent's storage,
`src/agent/idlecompact.js`; the compaction experiment's `idle` arm only). Every turn that ends
cancels the wait and arms a new one 65 minutes out, the schedule's payload naming the token kept
with it, so an older schedule finds another token and does nothing. Due, the key is deleted before
anything else, so it compacts at most once per idle stretch; then it skips an agent out of the arm
or with work pending (that work's end arms it again) and a context under 100k tokens. The summary is
pi-durable's, placed at once: the transcript (`harness.messages()`, the trace) starts at it after,
and older entries stay in pi's storage.

**Arm model unusable.** usable → unusable for ten minutes → usable (`unusable` in
`src/agent/model.js`, per isolate). A request the arm's model refuses before any answer (`unusableModel`)
goes to AGENT_MODEL instead, and the arm's model is not asked again until the time is up. Not
stored, so a new isolate asks again; other failures are the request's, retried as any.

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

**FluffyJaws grant.** none → signing in → connected → rejected → signing in → connected
(`grantState` in `src/agent/fluffyjaws.js`, from the row of `mcp_global_grants`). The same rules as
the MCP OAuth grant: one refresh at a time under `refresh_lock`, a refresh writes only over the
sealed tokens it started from, and one that lost revokes what it got unless the grant is the same.
Connecting again revokes the grant before once the new one is kept; disconnecting deletes the row.

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

**Catalog compile.** files → compiled → behind → compiled again (src/catalog.js, src/catalogsync.js).
A team's `products/` is the source; its `tech_stack` rows (`path` set) and `tech_moves` are replaced
together in one batch, with `knowledge_bases.catalog_commit` the watermark, written in the same batch.
A write compiles from what it pushed; a compile that fails (a catalog file the cron could not read
counts: it is no file deleted) leaves the rows and the watermark as they were, so the cron, which compiles every team whose head is not the watermark, takes it again. A move
(`moved_from`) rewrites what D1 keeps under the old id only when it is new against the team's moves
before, so compiling twice rewrites nothing; an old id that is still a file somewhere is only mapped.

**Technology conflicts.** open → kept → open again (src/techconflicts.js). Computed from
`tech_stack` on every read, so settling one by changing the definitions closes it with no state of
its own. Kept is the only stored state: a row in `tech_conflict_keeps` with the fingerprint of the
definitions it was kept with; once one of them changes, the fingerprint no longer matches and it is
open again. A merge deletes the files of the technology that goes before the other lists it in
`moved_from`, so the compile sees a new move (src/catalog.js) and rewrites D1.

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

**Channel archive.** live → archived → restored, i.e. live (`channels.archived_at`, `src/lookup.js`
`getChannel`). Only a lookup writes it, from what the platform says now (Slack `is_archived`, Teams
`isArchived` of the channel or its team), so a replay cannot set it back; `archived_at` is when a
lookup first saw it, not when it happened. What asks: a notice of an archive or a restore (Slack's
`channel_archive` and `channel_unarchive` messages, Teams' team notices) looks the channel up at
once; a message from after `archived_at` does too, since an archived channel gets none; and
`sweepChannels` (`src/channelsweep.js`) looks up every channel not looked up for a week, 25 a cron
run, writing `checked_at` after each try, answered or not, so one the platform no longer shows
does not stay at the head. A Teams team seen archived archives all its channels' rows; one seen
restored does not restore them (a channel can be archived on its own), their own lookups do. The
admin pages and Clef leave archived channels out.

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

## The customer portal

The portal is a Worker of its own with its own database (`portal/migrations`, `src/portal/`); the
inbox keeps what it heard of it. Each side's state is its own, and the events between them are the
only thing both see.

**Lobby.** `draft` → `requested` → `open`, or → `declined` → `requested` again (`lobbies.status`
in the portal, `src/portal/store.js`). The first of a mail domain to sign in founds it (the insert
decides who: `ON CONFLICT DO NOTHING`); asking is conditional on `draft` or `declined`, declining on
`requested`, so each happens once. Opening a channel makes it `open` from any state, and it stays
open: more channels change nothing. Nothing is told of a `draft`.

**Lobby member.** absent → invited → joined (`members.joined_at`). Only a member invites, only an
address of the lobby's domain; an invitation nobody used can be taken back, a member who signed in
stays. Someone of the domain who is neither is told whom to ask, and reads nothing.

**Portal request.** absent → `open` → `opened`, or → `declined` → `open` again
(`portal_requests.status` in the inbox, `src/portalrequests.js`). The row follows the lobby: every
`lobby` event is a snapshot with its number in the portal's outbox (`seq`), and the row takes one
only when it is newer (`WHERE excluded.seq > portal_requests.seq`), so a replay of pile 1, or two
events out of order, end where the latest says. The inbox's own decisions are written before the
portal is asked: a decline is conditional on `open` (whoever comes second gets 409), and is taken
back when the portal did not take it (`reopenDeclined`), unless the portal says the lobby is not
waiting any more. Opening is not claimed: the portal makes a channel per call, so a second call
makes a second channel, which the request allows on purpose (a lobby may get more than one), and
the page does not send it again by itself. If filing the new channel fails after the portal made
it, the answer says so and names it: it is in the inbox under the admin team (the rule of last
resort), to be assigned on a team's page.

**Portal message.** absent → posted → edited (any number of times) → deleted (`messages.rev`,
`edited_at`, `deleted_at` in the portal). `rev` counts the changes and is the version of the
message's file in pile 2 (`normalizePortal`), so a file only moves to a later change whatever
order the events arrive in, also for two changes in one millisecond; a deletion is the last one.
Telling of a thread again (`resend`, for a backfill) sends each message as it is, with the `rev`
it has: nothing moves.

**Portal file.** uploaded → attached → deleted with its message; or uploaded → deleted after a day
(`files.message`, `src/portal/files.js`). A file is uploaded before the message that carries it, by
whoever writes it, and is nobody's until then: only its uploader's message takes it, in the batch
that writes the message, and only once (`WHERE message IS NULL`). One that no message took (the
composer was left, the file removed from it) is an orphan the cron deletes after a day, the row
conditional on it still being one. A deleted message loses its files after its tombstone is
written, so a failure between the two leaves files no thread shows, not a message without the
files it says it has.

**Picture and logo.** none → uploaded → replaced or removed (`users.avatar_key`,
`lobbies.logo_key`). Each upload is a new object under a new key, which the row then names, and
the one before is deleted: an address with the old version (`?v=`) answers with the new picture,
which is what a cached page wants. The inbox learns of a picture with its owner's next message
(`author.picture`), of a logo with the lobby's next event; a picture taken away is their Gravatar
again from their next message on.

**Portal event.** written → delivered → deleted after a week (`events.delivered_at`,
`src/portal/events.js`). An event is written in the same batch as the change it tells of, so
there is no change without its event; a lobby's is written after the change, and is a snapshot,
so a lost one is made up for by the next. Delivery is at least once: two deliveries at once may
send the same events, and one that failed is sent again by the cron (`attempts`, `error`); the
inbox keys each by its `seq`, so both are one object in pile 1. An unbound portal delivers
nothing and keeps everything.

**Writing in a portal thread.** absent → writing → absent (`typing.at` in the portal,
`src/portal/store.js`). The inbox says that someone types a reply every four seconds while they
do (`POST /api/typing`), and each word writes the row's `at` again; a row counts for eight seconds
after it (`TYPING_MS`), so someone who stops is gone without anything saying so, and a lost word
is made up for by the next. Their message deletes the row in the batch that writes it; rows ten
times older than that are deleted with the next one written. Nothing of it is an event: the
inbox's pile 1 never hears who typed.

**Adobe's side of a thread.** asked → kept for ten seconds → asked again (`statuses` in
`src/portal/api.js`, per isolate). What the inbox says of a thread (how many listen, the typical
wait, whether the agent works, whether a draft waits) is the present, read from the inbox's own
tables when asked and stored nowhere; an inbox that does not answer leaves the page without
it, and with what the portal knows itself (who writes, the thread's `stamp`). The **wait model**
behind the estimate is absent → fitted → stale → fitted again, per isolate of the inbox
(`src/portalstatus.js`): fit from the last 180 days by the first status asked, one read however
many ask at once; an hour old it is stale, still answered with, and fitted again behind that
answer. A fit that fails leaves the one there is. No wait at all is no estimate.

**Portal technologies.** the built-in list → the inbox's, an hour old at most (`tech`, `meta.tech_at`
in the portal, `src/portal/tech.js`). An empty or failed answer leaves the list as it is: "the
inbox said nothing" is not "there are none". A lobby's picks are checked against the list when
they are saved, not after, so one the inbox no longer offers stays picked, and shows in the
request by its id.

## In the page

**Socket.** connecting → open → reconnecting → banner (`listen`, `ui/inbox.js`). A socket that comes
back has missed what its room said, so the inbox and the open thread reload.

**Background catch-up.** live ↔ collecting changes (`changed`, `reload`). A hidden tab notes what
changed and reloads when it is shown.

**Thread list.** fresh → held in place → re-sorted (`state.list`). While `listKey` is the same, the
rows stay where they are. Unread only lets go of the read threads it holds once the inbox has been
away (tab hidden or window not focused) for `AWAY_MS` (`forgetRead`, `away`): never the open thread,
and not after a shorter look elsewhere.

**Customer column.** placed → held → let go (`state.column`, `columnPlace` and `forgetColumn` in
`ui/inbox.js`). The simple personal view's customers go by their place: the highest they have had
(unread mentions of you, then unread, then the rest) since the inbox was last away. Something new
moves a customer up at once; reading it moves it down only once the inbox has been away for
`AWAY_MS`, as the thread list does, but never the open thread's customer. Its badge and bold are
what it has now. Another view, the expert view, viewing as someone and a reload start afresh;
excluding a customer puts it at the end at once and drops its place.

**List row.** shown → leaving → kept aside, or shown again (`.leaving` and `__leave` on the row's
node, `leaveRow` in `ui/inbox.js`). While the list is the same (`state.list`), a row on screen whose
thread the list no longer shows folds away before it is removed; until then it is inert, out of
`state.order` and not counted as seen, and it stays in `state.rowNodes` as any hidden row does, so a
thread that shows again takes its node back (`stopLeave`). A new list, a search, a hidden page or
reduced motion removes it at once.

**Thread pane (phones).** the thread → leaving → "Pick a thread.", or the thread again (`inert` on
`#pane`, `paneLeave`, `emptyPane` in `ui/inbox.js`). Under 700px, closing the open thread (‹, Back, another
view) slides the pane away; until its slide ends it shows what it showed, inert, and is emptied
once it is out, or once the slide is cut short (the screen grown past the phone's). Nothing renders into it meanwhile: what renders the thread renders the open one
(`state.open`), and there is none. Opening something before then (`syncReading`) takes the pane
over, and `paneLeave` tells the slide that ended it is not the latest. No slide (reduced motion,
`main.instant`, a wider screen): emptied at once.

**Favicon.** loading → shown, or failed → its stand-in → loading again (`favImg`, `favFailed`,
`keepFavicons` and `wireFavicons` in `ui/inbox.js`). Drawn again, a favicon keeps the image it had
(the same address, one per domain from `GET /api/favicon`), so a click does not fetch or flash it.
One that does not load (an error event, or found complete without an image when its place is
drawn again, as one that failed out of the page) gives way to the stand-in its place has (an
initial, an empty slot, nothing), and every favicon of its address is drawn as that stand-in for
`FAV_RETRY_MS`: a failure may pass (the Worker answers a Google that failed with a 502 for a minute,
src/favicons.js), so it is not final, and the next drawing after that asks again.

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
it. Opening and closing are motion only (the stylesheet's transitions): the state is the class
at once, so focus, Escape and the next tap never wait for the sheet. A drawer drawn again while
open (its composer replaced) is `still`, open without rising again, until it closes.

**Earlier commands.** latest only ↔ all that ended (`bashEarlier`, by thread, `ui/inbox.js`). Of
the requests that ended within the hour only the latest shows, until its button shows the rest;
it stays so for the thread in the tab. Those that wait or run always show.

**Notification permission.** unasked → asked → granted or denied (`Notification.permission` and
`opspile.notify.asked`). The browser's own state is the record, and the first visit asks once.
While the tour is offered it waits: it asks once the tour is over, or on the next load.

**The tour.** unoffered → offered → toured (`toured` in `person_settings`, src/settings.js; false
until set). The first load of the inbox with `toured` false offers the tour (ui/tour.js) in a
toast, after the inbox is on screen; Show me around or No thanks sets it true, on the server, so
no device offers it again. A load whose toast is taken (an account just connected) does not
offer it: the next one does. Your menu's Show me around, and `/inbox?tour`, start it whatever
`toured` says. Not offered while viewing as someone else.

**Notification welcome.** unsent → sent, for a tab and for the installed app on this device
(`opspile.notify.welcomed` in `ui/inbox.js`, a list of `tab` and `app`). Once the browser allows
notifications (and one of mentions, your threads or a bell is on), the first load in each sends
"Notifications are on" with a toast asking whether it popped up; the installed app shares the
tab's permission and storage, so it never asks but is welcomed once on its own. The browser
allowing them just now (default → granted) sends it again; so does clearing the key. The menu's
test notification counts as the welcome. Not while viewing as someone else.

**Notification sound.** silent → unlocked → loaded or tone (`audio` and `chime` in `ui/inbox.js`). A
page plays sound only after a click or key press in it, so the first one creates the audio and
fetches `/notify.mp3`; a reload starts silent again. A sound that does not load plays a short tone.
Off unless `opspile.notify.sound` is `on`, per device (the menu's "Play a sound"; whoever never
chose hears none); one tab plays it (the `opspile:chime` lock).
