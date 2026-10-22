# helix-opspile

An inbox for opsophiles: one place for an ops team to work through every Slack and Microsoft
Teams channel it is responsible for, with per-person and per-team read state.

Status: **piles 1, 2 and 4 live, with a first inbox.** Signed Slack events are stored in R2 and queued for
normalization; Teams: a cron keeps one tenant-wide Graph subscription alive, and its notifications and the messages they name are stored the same way. A queue consumer turns every raw object into one markdown file per message (pile 2), filed by the channel rules in D1. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
design and the open issues for what comes next.

## Ingest Worker

One Cloudflare Worker, deployed as `helix-opspile-prod` and `helix-opspile-stage`.

| Route | Purpose |
| --- | --- |
| `POST /slack/events` | Slack Events API request URL. Rejects requests without a valid signature (401). Answers `url_verification`; stores every event callback in pile 1 (without Slack's verification `token`) before acknowledging it, and answers 500 if that fails so Slack retries. |
| `POST /teams/notify` | Microsoft Graph change-notification URL. Echoes `validationToken`. Drops notifications whose `clientState` is not `GRAPH_CLIENT_STATE`, stores the rest in pile 1, answers 202, then fetches and stores the message. |
| `POST /teams/lifecycle` | Graph lifecycle-notification URL. Stores lifecycle notifications the same way, then renews (`reauthorizationRequired`) or recreates (`subscriptionRemoved`) the subscription. `missed` is only logged until the catch-up (#8). |
| `GET /inbox` | The inbox UI (one static page), behind Cloudflare Access. |
| `GET /api/me`, `/api/inbox?team=`, `/api/thread?thread=` | The signed-in person, a team's threads with read state, one thread's messages from pile 2. Behind Access; the Worker also verifies the Access JWT and ties the email to a person in D1. |
| `GET /api/review/queue`, `GET /api/review/stats`, `POST /api/review` | Label review for members of the `admin` team: unreviewed labels (least confident first), Clef's agreement per question, and a correction for one question of one label. |
| `POST /api/post` | Reply in a thread **as the signed-in person**, through their own Slack or Microsoft account. `409` with `connect` when they have not connected it yet. Only staff, only in their teams. `mentions` (account ids) turn each `@Name` of those accounts into a real Slack (`<@U…>`) or Teams (`<at>`) mention, so the person is notified. |
| `GET /api/mentionable?thread=&q=` | Who can be mentioned in a reply: accounts already in D1 for the thread's platform and workspace whose name (any word) starts with `q`; people in the thread first, then staff. |
| `GET /api/auth/{slack,teams}/start`, `…/callback`, `DELETE /api/auth/{slack,teams}` | Connect or disconnect a person's Slack (user scope `chat:write`) or Microsoft account (delegated `ChannelMessage.Send`, `offline_access`, `User.Read`). The account must be the person's own (same person in D1, or same email). Tokens are stored encrypted with `TOKEN_KEY`. |
| `GET /api/media?u=` | Images attached to messages (Slack files, Teams hosted contents), fetched with the platform's credentials; nothing else is fetched. |
| `GET /api/people`, header `x-opspile-as: <person id>` | Admins: the people in the ops teams, and any API call as one of them (read-only: no reads, replies, reviews or connections). |
| `POST /api/read`, `GET /api/live?team=` | Mark a thread read; the team's live WebSocket (read events and new activity), served by the team's Durable Object. |
| `GET /diag/teams` | Self-test of the Microsoft side, guarded by the `x-opspile-diag` header. Returns the token's granted roles and the number of visible teams; `?sub=1` also creates and immediately deletes a `/teams/getAllMessages` probe subscription; `?ensure=1` runs the cron's renewal now. Never returns a token. |
| queue `helix-opspile-normalize` | Also carries thread backfill requests and label jobs (see ARCHITECTURE). Pile 1 → pile 2: reads the raw object, looks up the channel and author (cached in D1), applies the rules, and writes `channels/<org>/<team>/<source>-<channelId>/<rootId>/<messageId>.md`. Five retries, then `helix-opspile-normalize-dlq`. |
| cron `*/20 * * * *` | Creates missing team knowledge bases (pile 3). Keeps exactly one `/teams/getAllMessages` subscription (`created,updated,deleted`, no resource data) pointed at `/teams/notify`: renews it to 55 minutes, deletes duplicates, creates it if missing. Graph's subscription list is the record; nothing else is stored. |

### Bindings

Nothing below is committed; set it on the Worker.

| Name | Kind | What |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | secret | Bot token of the opspile Slack app |
| `SLACK_SIGNING_SECRET` | secret | Signing secret of the opspile Slack app |
| `MS_CLIENT_SECRET` | secret | Client secret of the opspile Entra app registration |
| `DIAG_TOKEN` | secret | Random value required in `x-opspile-diag` for `/diag/*` |
| `GRAPH_CLIENT_STATE` | secret | Random value our Graph subscriptions carry as `clientState`; notifications without it are dropped |
| `SLACK_CLIENT_SECRET` | secret | Client secret of the opspile Slack app (people connecting their Slack account) |
| `TOKEN_KEY` | secret | 32 random bytes (base64url): encrypts people's OAuth tokens and signs OAuth state |
| `MS_CLIENT_ID` | var | Application (client) id of the Entra app |
| `SLACK_CLIENT_ID` | var | Client id of the opspile Slack app |
| `MS_TENANT_ID` | var | Directory (tenant) id |
| `PUBLIC_ORIGIN` | var | This Worker's `https://` origin; Graph sends notifications there |
| `STAFF_DOMAINS` | var | Comma-separated mail domains whose people count as staff |
| `ACCESS_TEAM_DOMAIN` | var | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | var | Audience tag of the Access application in front of `/inbox` and `/api` |
| `ROOMS` | Durable Object | `TeamRoom`, one per ops team: live read state |
| `RAW` | R2 bucket | Pile 1: `helix-opspile-raw` (`-stage` for stage) |
| `CHANNELS` | R2 bucket | Pile 2: `helix-opspile-channels` (`-stage`) |
| `DB` | D1 | `helix-opspile` (`-stage`): teams, people, identities, channels, rules, threads, messages, watermarks, mentions, backfills, labels, facts |
| `AI` | Workers AI | Clef (thread labels, re-threading) and Clairic (facts), `bge-base-en-v1.5` embeddings |
| `VECTORS` | Vectorize | `helix-opspile-roots` (`-stage`): one vector per root message. Create it by hand: 768 dimensions, cosine, metadata indexes `channel` (string) and `at` (number) |
| `ARTIFACTS` | Artifacts | Pile 3: namespace `helix-opspile` (`-stage`), one repo per org (`kb-org-<slug>`) and per team (`kb-team-<slug>`), created when a channel is discovered and by the cron for every team |
| `NORMALIZE` | queue | Keys of new pile-1 objects for #6: `helix-opspile-normalize` (`-stage`) |

`cf deploy` creates the buckets and queues when they are missing. The D1 schema is in
`migrations/`; apply it with `cf d1 migrations apply <database id>` **before** the first
deploy, and load teams, people and rules (data, never committed) with `cf d1 query`.

### Inbox and Access

`/inbox` and `/api` are one Cloudflare Access application (one-time PIN by email). Its
policy allows the members of the ops teams; when you add someone to a team in D1, add their
email to the policy too. The Worker trusts only a verified `Cf-Access-Jwt-Assertion` whose
email is a person in D1, and shows them the threads of their own teams.

### Rules and replay

Rows in the `rules` table map a channel to an ops team, an org and a kind: for each target,
the matching rule with the lowest `priority` wins. `field` is `channel_id`, `name`,
`group_name` (the Teams team) or `connected` (Slack Connect team ids); `pattern` is a
case-insensitive regular expression and `value` may use `$1`. For example
`org | name | ^aem-(.+)$ | $1` files `aem-acme` under the org `acme`.

Pile 2 is derived, so it can always be rebuilt from pile 1:

```sh
node scripts/replay.mjs --dry-run           # count what would be replayed
node scripts/replay.mjs --prefix slack/     # replay part of pile 1
node scripts/replay.mjs --clear             # after changing rules: empty pile 2, replay all
node scripts/replay.mjs --rethread          # redo re-threading for every root (after a replay)
node scripts/replay.mjs --relabel           # label every thread again (titles, Clef, tech stack)
```

The Entra app needs these Microsoft Graph **application** permissions, with admin consent:
`Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `User.Read.All`.
For replies it also needs the **delegated** permissions `ChannelMessage.Send`, `offline_access`
and `User.Read`, and the web redirect URI `<origin>/api/auth/teams/callback`. The Slack app
needs the user scope `chat:write` and the redirect URL `<origin>/api/auth/slack/callback`.

### Iterate on the inbox UI

`npm run ui:dev` serves the inbox at <http://localhost:8787/inbox> with fake data and live
reload: saving `ui/inbox.html` reloads the page, and saving anything under `scripts/` or `src/`
restarts the server with fresh data. The page is the same file the Worker serves, and the fake
API uses the same `readState`, `parse` and `render` helpers. D1, R2, the team's Durable Object
and Access are replaced by an in-memory store in
[scripts/dev-ui-fixtures.mjs](scripts/dev-ui-fixtures.mjs), and you are signed in as Dana.
New fake messages arrive every 25 seconds (`node scripts/dev-ui.mjs --no-sim` turns that off).
No Cloudflare login or `.dev.vars` is needed.

To point the preview at production instead, sign in to the inbox in Chrome with remote
debugging on (port 9222), then run `npm run ui:session -- <inbox origin>`. It copies the Access
session cookie into `.dev-ui-session.json` (gitignored, never printed), and the preview switches
to the production API, read-only: writes are refused and the page's banner says so. Delete the
file, or run `npm run ui:session -- --clear`, to go back to fake data.

### Develop and deploy

**CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, tests and a build
check on every pull request. A push to `main` applies the D1 migrations and deploys
`helix-opspile-prod`. It authenticates with the repository secrets `CLOUDFLARE_API_TOKEN`
(an account token scoped to Workers scripts, R2, Queues, D1, Artifacts and Workers
Observability; it expires after a year) and `CLOUDFLARE_ACCOUNT_ID`, and reads the plain-text vars from the
secrets of the same name. Migrations must be additive, because they run before the new code
is live.

To deploy by hand instead:

Deploys go through the new Cloudflare CLI, [`cf`](https://developers.cloudflare.com/cf/), which
reads `cloudflare.config.ts` (`--mode prod` or `--mode stage` selects the Worker).

```sh
npm install
npm run lint
cf auth create <profile> && cf auth activate <profile>  # once, for the target account
printf 'MS_CLIENT_ID=…\nMS_TENANT_ID=…\nPUBLIC_ORIGIN=https://…\nSTAFF_DOMAINS=…\n' > .env
npm run deploy:prod                                    # or deploy:stage
```

`cf` has no `keep_vars`: the plain-text vars are part of every deploy, so the config reads them
from the environment or `.env` and refuses to deploy without them. Secrets are declared by
name only; `cf deploy` checks that they exist on the Worker and keeps their values. `cf`
cannot set a single secret yet, so use
`npx wrangler secret put SLACK_BOT_TOKEN --name helix-opspile-prod`, or pass
`--secrets-file` to `cf deploy` (required for the first deploy of a new Worker). For
`cf dev`, put the bindings in an uncommitted `.dev.vars`.
