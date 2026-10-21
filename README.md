# helix-opspile

An inbox for opsophiles: one place for an ops team to work through every Slack and Microsoft
Teams channel it is responsible for, with per-person and per-team read state.

Status: **piles 1 and 2 live.** Signed Slack events are stored in R2 and queued for
normalization; Teams: a cron keeps one tenant-wide Graph subscription alive, and its notifications and the messages they name are stored the same way. A queue consumer turns every raw object into one markdown file per message (pile 2), filed by the channel rules in D1. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
design and the open issues for what comes next.

## Ingest Worker

One Cloudflare Worker, deployed as `helix-opspile-prod` and `helix-opspile-stage`.

| Route | Purpose |
| --- | --- |
| `POST /slack/events` | Slack Events API request URL. Rejects requests without a valid signature (401). Answers `url_verification`; stores every event callback in pile 1 (without Slack's verification `token`) before acknowledging it, and answers 500 if that fails so Slack retries. |
| `POST /teams/notify` | Microsoft Graph change-notification URL. Echoes `validationToken`. Drops notifications whose `clientState` is not `GRAPH_CLIENT_STATE`, stores the rest in pile 1, answers 202, then fetches and stores the message. |
| `POST /teams/lifecycle` | Graph lifecycle-notification URL. Stores lifecycle notifications the same way, then renews (`reauthorizationRequired`) or recreates (`subscriptionRemoved`) the subscription. `missed` is only logged until the catch-up (#8). |
| `GET /diag/teams` | Self-test of the Microsoft side, guarded by the `x-opspile-diag` header. Returns the token's granted roles and the number of visible teams; `?sub=1` also creates and immediately deletes a `/teams/getAllMessages` probe subscription; `?ensure=1` runs the cron's renewal now. Never returns a token. |
| queue `helix-opspile-normalize` | Pile 1 → pile 2: reads the raw object, looks up the channel and author (cached in D1), applies the rules, and writes `channels/<org>/<team>/<source>-<channelId>/<rootId>/<messageId>.md`. Five retries, then `helix-opspile-normalize-dlq`. |
| cron `*/20 * * * *` | Keeps exactly one `/teams/getAllMessages` subscription (`created,updated,deleted`, no resource data) pointed at `/teams/notify`: renews it to 55 minutes, deletes duplicates, creates it if missing. Graph's subscription list is the record; nothing else is stored. |

### Bindings

Nothing below is committed; set it on the Worker.

| Name | Kind | What |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | secret | Bot token of the opspile Slack app |
| `SLACK_SIGNING_SECRET` | secret | Signing secret of the opspile Slack app |
| `MS_CLIENT_SECRET` | secret | Client secret of the opspile Entra app registration |
| `DIAG_TOKEN` | secret | Random value required in `x-opspile-diag` for `/diag/*` |
| `GRAPH_CLIENT_STATE` | secret | Random value our Graph subscriptions carry as `clientState`; notifications without it are dropped |
| `MS_CLIENT_ID` | var | Application (client) id of the Entra app |
| `MS_TENANT_ID` | var | Directory (tenant) id |
| `PUBLIC_ORIGIN` | var | This Worker's `https://` origin; Graph sends notifications there |
| `STAFF_DOMAINS` | var | Comma-separated mail domains whose people count as staff |
| `RAW` | R2 bucket | Pile 1: `helix-opspile-raw` (`-stage` for stage) |
| `CHANNELS` | R2 bucket | Pile 2: `helix-opspile-channels` (`-stage`) |
| `DB` | D1 | `helix-opspile` (`-stage`): teams, people, identities, channels, rules |
| `NORMALIZE` | queue | Keys of new pile-1 objects for #6: `helix-opspile-normalize` (`-stage`) |

`cf deploy` creates the buckets and queues when they are missing. The D1 schema is in
`migrations/`; apply it with `cf d1 migrations apply <database id>` **before** the first
deploy, and load teams, people and rules (data, never committed) with `cf d1 query`.

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
```

The Entra app needs these Microsoft Graph **application** permissions, with admin consent:
`Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `User.Read.All`.

### Develop and deploy

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
