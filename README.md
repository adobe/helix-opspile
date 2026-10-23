# helix-opspile

An inbox for opsophiles: one place for an ops team to work through every Slack and Microsoft
Teams channel it is responsible for, with per-person and per-team read state.

Status: **piles 1, 2 and 4 live, with a first inbox; thread agents that fill pile 3, in one test channel.** Signed Slack events are stored in R2 and queued for
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
| `GET /inbox/admin` | Teams, members, rules and manual assignments; customers, partners and vendors (name, icon, type, manual assignments). One static page, for the admin team. |
| `/api/admin/*` | Its API, admin team only: `teams`, `team?slug=`, `members`, `rules`, `assign`, `channels?q=`, `orgs`, `org?slug=` (GET, and POST/PUT/DELETE with JSON bodies). Rule changes take `dryRun: true` and answer with the channels they would move; applied, they queue `refile` jobs. |
| `GET /inbox/kb` | The knowledge-base editor (one static page), for the admin team: list the knowledge bases and their files, edit concepts and the agents' `systemprompt.md` (saved as you type), see the history. |
| `GET /api/kb`, `GET /api/kb/files?repo=`, `GET /api/kb/log?repo=`, `GET`/`PUT`/`DELETE /api/kb/file` | The editor's API, admin team only: knowledge bases, files, commits, and one file (`?repo=&path=`); `PUT { repo, path, content, base?, message? }` commits it as the signed-in person (`base`: the blob it was written from; without one the file must not exist yet), `DELETE { repo, path, base }` removes it. `409` with the current file when it changed meanwhile. |
| `GET /api/me`, `/api/inbox?team=`, `/api/thread?thread=` | The signed-in person, a team's threads with read state and who each waits on (`waiting_on`: Clef's next actor, but never `us` when Adobe posted last), one thread's messages from pile 2. Both lists carry `profiles`: a profile card per author (Adobe, partner, customer or bot, title, mail domain, ops teams), keyed by platform account. Behind Access; the Worker also verifies the Access JWT and ties the email to a person in D1. |
| `GET /api/review/queue`, `GET /api/review/stats`, `POST /api/review` | Label review for members of the `admin` team: unreviewed labels (least confident first), Clef's agreement per question, and a correction for one question of one label. |
| `POST /api/post` | Reply in a thread **as the signed-in person**, through their own Slack or Microsoft account. `409` with `connect` when they have not connected it yet. Only staff, only in their teams. `mentions` (account ids) turn each `@Name` of those accounts into a real Slack (`<@U…>`) or Teams (`<at>`) mention, so the person is notified. |
| `POST /api/react` | Add (or with `remove`, take off) a reaction on one message **as the signed-in person**: `{ thread, id, emoji }`, where `thread` is the message's platform thread and `emoji` a picker name (`thumbsup`, `white_check_mark`, …) or a reaction as the thread shows it. Slack `reactions.add`/`remove`, Teams `setReaction`/`unsetReaction`; recorded in D1 at once, then again by the platform's own event. `409` with `reconnect: 'slack'` for Slack tokens from before `reactions:write`. Only staff, only in their teams. |
| `POST /api/resolve` | `{ thread, undo? }`: ✅ on the root message of the entry's latest platform thread, as the signed-in person (`white_check_mark` on Slack, `✅` on Teams), or with `undo` take their ✅ off every root of the entry. A staff ✅ on the root marks the thread resolved (see ARCHITECTURE, "Resolved"). |
| `GET`, `PUT`, `DELETE /api/draft` | The thread's shared draft (at most one per inbox entry), seen by everyone in the team that owns the channel. `PUT { thread, text, mentions?, base }` saves it as the signed-in person, `DELETE { thread, base? }` discards it; `base` is the `updated_at` of the draft the text was written from, and a draft that changed since answers `409` with the current one. `POST /api/post` with `draft: <base>` uses the draft up. Inbox entries carry `draft` (who, when, a preview), the thread its full `draft`. Only in their teams (admins can see any thread's draft). |
| `GET /api/mentionable?thread=&q=` | Who can be mentioned in a reply: accounts already in D1 for the thread's platform and workspace whose name (any word) starts with `q`; people in the thread first, then staff. |
| `GET /api/auth/{slack,teams}/start`, `…/callback`, `DELETE /api/auth/{slack,teams}` | Connect or disconnect a person's Slack (user scopes `chat:write`, `reactions:write`) or Microsoft account (delegated `ChannelMessage.Send`, `offline_access`, `User.Read`). The account must be the person's own (same person in D1, or same email). Tokens are stored encrypted with `TOKEN_KEY`. |
| `GET /api/media?u=` | Images attached to messages (Slack files, Teams hosted contents), fetched with the platform's credentials; nothing else is fetched. |
| `GET /api/people`, header `x-opspile-as: <person id>` | Admins: the people in the ops teams, and any API call as one of them (read-only: no reads, replies, reviews or connections). |
| `POST /api/read`, `GET /api/live?team=` | Mark a thread read; the team's live WebSocket (read events and new activity), served by the team's Durable Object. |
| `POST /mcp` | An MCP server (Streamable HTTP, protocol `2026-07-28`; 2025 clients via `initialize`), with its own OAuth (open client registration, consent behind Access). See "MCP server" below. |
| `/.well-known/oauth-*`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`, `GET/POST /api/oauth/authorize` | OAuth for MCP clients. |
| `GET /api/agent?thread=`, `POST /api/agent/seed` | Whether a thread has an agent and what it is doing (its watermark, pending runs); share knowledge with an agent: `{ thread, text }` for a thread's agent, `{ team, org, text }` for the knowledge-base agent of a team and customer. Only in their teams. See "Thread agents". |
| `GET`, `POST /diag/agent?name=` | One agent by name (an inbox entry key, or `kb:<team>:<org>`), guarded by `x-opspile-diag`: `GET` its status, `POST {}` delivers new messages, `POST { text }` seeds it. |
| `GET /diag/teams` | Self-test of the Microsoft side, guarded by the `x-opspile-diag` header. Returns the token's granted roles and the number of visible teams; `?sub=1` also creates and immediately deletes a `/teams/getAllMessages` probe subscription; `?ensure=1` runs the cron's renewal now. Never returns a token. |
| queue `helix-opspile-normalize` | Also carries thread backfill requests, label jobs, thread-agent pokes and re-filing after a rule change (see ARCHITECTURE). Pile 1 → pile 2: reads the raw object, looks up the channel and author (cached in D1), applies the rules, and writes `channels/<org>/<team>/<source>-<channelId>/<rootId>/<messageId>.md`. Five retries, then `helix-opspile-normalize-dlq`. |
| cron `*/20 * * * *` | Creates missing team knowledge bases (pile 3), and imports or refreshes the Artifacts mirrors of the GitHub repositories agents may read. Keeps exactly one `/teams/getAllMessages` subscription (`created,updated,deleted`, no resource data) pointed at `/teams/notify`: renews it to 55 minutes, deletes duplicates, creates it if missing. Graph's subscription list is the record; nothing else is stored. |

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
| `ACCESS_AUD` | var | Audience tag of the Access application in front of `/inbox`, `/api` and `/mcp` |
| `AGENT_MODEL` | var | Optional: the Bedrock inference profile of the thread agents' model, e.g. `us.anthropic.claude-opus-5-5`. Agents are off without it. |
| `AGENT_CHANNELS` | var | Comma-separated channel ids (Slack or Teams) where thread agents run |
| `AGENT_GATEWAY` | var | The AI Gateway (id) agents call Bedrock through |
| `AGENT_REGION` | var | Optional: Bedrock region, default `us-east-2` |
| `AI_GATEWAY_ACCOUNT` | var | Optional: the gateway's account id; the deploy fills in `CLOUDFLARE_ACCOUNT_ID` |
| `AGENT_ANTHROPIC_BETA` | var | Optional: the `anthropic-beta` features to ask for instead of pi's defaults, `none` for none |
| `AGENT_BASE_URL` | var | Optional, for development: an Anthropic Messages endpoint to use instead of the gateway |
| `BEDROCK_API_KEY` | secret | Amazon Bedrock API key (bearer token). Required when `AGENT_MODEL` is set |
| `AI_GATEWAY_TOKEN` | secret | Optional: a token for an authenticated gateway, sent as `cf-aig-authorization`; set `AI_GATEWAY_TOKEN_REQUIRED=1` at deploy so `cf` checks it exists |
| `MCP_ORIGINS` | var | Optional, comma-separated: browser origins besides `PUBLIC_ORIGIN` that may call `/mcp` (requests with any other `Origin` get 403) |
| `ROOMS` | Durable Object | `TeamRoom`, one per ops team: live read state |
| `AGENTS` | Durable Object | `ThreadAgent`, one per inbox entry with an agent (and per team and customer for seeded knowledge) |
| `RAW` | R2 bucket | Pile 1: `helix-opspile-raw` (`-stage` for stage) |
| `CHANNELS` | R2 bucket | Pile 2: `helix-opspile-channels` (`-stage`) |
| `DB` | D1 | `helix-opspile` (`-stage`): teams, people, identities, channels, rules, orgs, partner domains, threads, messages, watermarks, mentions, backfills, labels, facts, drafts, agent repos and their mirrors |
| `AI` | Workers AI | Clef (thread labels, re-threading, the agents' prompt-injection check) and Clairic (facts), `bge-base-en-v1.5` embeddings |
| `VECTORS` | Vectorize | `helix-opspile-roots` (`-stage`): one vector per root message. Create it by hand: 768 dimensions, cosine, metadata indexes `channel` (string) and `at` (number) |
| `ARTIFACTS` | Artifacts | Pile 3: namespace `helix-opspile` (`-stage`), one repo per org (`kb-org-<slug>`) and per team (`kb-team-<slug>`), created when a channel is discovered and by the cron for every team; and read-only mirrors of GitHub repositories for the agents (`gh-<owner>-<name>-<time>`) |
| `NORMALIZE` | queue | Keys of new pile-1 objects for #6: `helix-opspile-normalize` (`-stage`) |

`cf deploy` creates the buckets and queues when they are missing. The D1 schema is in
`migrations/`; apply it with `cf d1 migrations apply <database id>` **before** the first
deploy, and load teams, people and rules (data, never committed) with `cf d1 query`.

### Inbox and Access

`/inbox` and `/api` are one Cloudflare Access application (one-time PIN by email). Its
policy allows the members of the ops teams; when you add someone to a team in D1, add their
email to the policy too. The Worker trusts only a verified `Cf-Access-Jwt-Assertion` whose
email is a person in D1, and shows them the threads of their own teams.

### MCP server

`/mcp` lets an agent outside the browser (Claude, an IDE, a CLI) work the inbox as the person
signed in, with seven tools: `whoami`, `list_threads`,
`get_thread`, `reply`, `react_to_message`, `resolve_thread` and `seed_agent`. It speaks MCP `2026-07-28`
over Streamable HTTP: stateless, `server/discover`, version and capabilities in each
request's `_meta`, header checks (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`), caching
hints, and plain JSON responses (no SSE, no `subscriptions/listen`). Clients of the 2025
revisions get `initialize` and the same tools, without a session. `reply` asks the user to
confirm before posting (a multi round-trip `elicitation/create`) when the client supports
elicitation; otherwise the client's own tool approval is the check. `get_thread` does not mark
anything read.

Sign-in is OAuth 2.1, served by the Worker itself (`src/oauth.js`): discovery
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), open
dynamic client registration (`/oauth/register`, any https redirect URI or localhost), and
`/oauth/token` (PKCE S256, refresh tokens rotated). There is no list of allowed clients:
the consent page `/api/oauth/authorize`, behind Access like the rest of `/api`, shows who
asks and, in large type, the host the grant goes to, and the person decides. Codes and
tokens are stored hashed in D1 (`oauth_*`, migration 0015); an access token lives an hour.
`/mcp` itself is **not** behind Access; it takes these tokens (or an Access assertion, for
`cloudflared access curl`). Connect a client to `<origin>/mcp`.

### Thread agents

An agent per thread in the channels listed in `AGENT_CHANNELS` follows the thread, keeps its
shared draft current (a person sends it), and fills the customer's and the team's knowledge
bases (OKF; see ARCHITECTURE, "Thread agents"). To turn them on:

1. Create an AI Gateway in the Worker's account (`AGENT_GATEWAY` is its id). Leave it
   unauthenticated, or create a token and set the secret `AI_GATEWAY_TOKEN`.
2. Create an [Amazon Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
   that may invoke the model's inference profile in `AGENT_REGION`, and set it as the Worker
   secret `BEDROCK_API_KEY` (`npx wrangler secret put BEDROCK_API_KEY --name helix-opspile-prod`).
3. Export `AGENT_MODEL`, `AGENT_GATEWAY` and `AGENT_CHANNELS` (and for CI, add them as
   repository secrets), apply the migrations and deploy.

GitHub repositories the agents may read are rows in `agent_repos`, data like the rules:
`INSERT INTO agent_repos (scope, slug, url, note) VALUES ('org', 'acme', 'https://github.com/acme/site', 'their site')`
(`scope` is `all`, `team` or `org`). The cron mirrors them into Artifacts within 20 minutes.
`GET /diag/agent?name=<thread key>` shows what an agent is doing.

### Rules and replay

Rows in the `rules` table map a channel to an ops team, an org and a kind: for each target,
the matching rule with the lowest `priority` wins. `field` is `channel_id`, `name`,
`group_name` (the Teams team) or `connected` (Slack Connect team ids); `pattern` is a
case-insensitive regular expression and `value` may use `$1`. For example
`org | name | ^aem-(.+)$ | $1` files `aem-acme` under the org `acme`.

The admin team edits teams, members, rules, manual assignments and orgs at `/inbox/admin`,
which also re-files the channels a change moves. Rules changed in D1 by hand need a replay
with `--clear`.

Rows in `partner_domains` (`domain`, `name`) mark people from a partner's mail domain (or a
subdomain of it) as partners on their profile card, instead of customers:
`INSERT INTO partner_domains (domain, name) VALUES ('agency.example', 'Agency')`.

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
For replies and reactions it also needs the **delegated** permissions `ChannelMessage.Send`
(which covers `setReaction`/`unsetReaction` on channel messages), `offline_access` and
`User.Read`, and the web redirect URI `<origin>/api/auth/teams/callback`. The Slack app needs
the user scopes `chat:write` and `reactions:write` and the redirect URL
`<origin>/api/auth/slack/callback`; the bot needs `reactions:read` for the reaction events.

### Iterate on the inbox UI

`npm run ui:dev` serves the inbox at <http://localhost:8787/inbox> with fake data and live
reload: saving `ui/inbox.html` reloads the page, and saving anything under `scripts/` or `src/`
restarts the server with fresh data. The page is the same file the Worker serves, and the fake
API uses the same `readState`, `parse` and `render` helpers. D1, R2, the team's Durable Object
and Access are replaced by an in-memory store in
[scripts/dev-ui-fixtures.mjs](scripts/dev-ui-fixtures.mjs), and you are signed in as Dana.
New fake messages arrive every 25 seconds (`node scripts/dev-ui.mjs --no-sim` turns that off).
No Cloudflare login or `.dev.vars` is needed. The knowledge-base editor is at
<http://localhost:8787/inbox/kb>, over a few made-up knowledge bases in memory
([scripts/dev-ui-kb.mjs](scripts/dev-ui-kb.mjs)), written by the same code as production.
The admin pages are at <http://localhost:8787/inbox/admin>: the real `src/admin.js` over an
in-memory D1 with the migrations, seeded from the fake inbox
([scripts/dev-ui-admin.mjs](scripts/dev-ui-admin.mjs)); the fake inbox itself does not see
their changes. On both, Dana counts as a member of the admin team.

To point the preview at production instead, sign in to the inbox in Chrome with remote
debugging on (port 9222), then run `npm run ui:session -- <inbox origin>`. It copies the Access
session cookie into `.dev-ui-session.json` (gitignored, never printed), and the preview switches
to the production API, read-only: writes are refused and the page's banner says so. Delete the
file, or run `npm run ui:session -- --clear`, to go back to fake data.

### Agents in the browser (WebMCP)

The inbox registers [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tools, so an agent
in the browser (Gemini in Chrome, an extension) can work the inbox through the same UI as the
person signed in, instead of clicking through the DOM. Every tool changes what is on screen
(filters, the open thread, the reply box) and every write goes through the same endpoints as
a click, as that person. A read-only "view as" refuses writes.

| Tool | What |
| --- | --- |
| `get_inbox_state` | Viewer, team, filters, open thread, and counts per filter value |
| `filter_threads` | Set filters, sort and team |
| `list_threads` | The threads shown, most relevant first |
| `open_thread` | Open a thread (marks it read) and return its latest messages |
| `draft_reply` | Put a reply in the reply box for the person to send (only there: saving it as the thread's shared draft is the person's call) |
| `send_reply` | Post a reply as the person, after a confirmation dialog |
| `react_to_message` | Add or take off a reaction |
| `resolve_thread` | ✅ on the first message, or take it off again |

Tool output that carries message text or titles is marked `untrustedContentHint`, and
`send_reply` is marked `consequentialHint`. To try them, turn on
`chrome://flags/#enable-webmcp-testing` and open the inbox (`npm run ui:dev` works) with the
[Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)
extension.

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
