# helix-opspile

An inbox for opsophiles: one place for an ops team to work through every Slack and Microsoft
Teams channel it is responsible for, with per-person and per-team read state.

Status: **ingest stub deployed.** Both platform apps are registered and their endpoints
verify; nothing is stored yet. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
design and the open issues for what comes next.

## Ingest Worker

One Cloudflare Worker, deployed as `helix-opspile-prod` and `helix-opspile-stage`.

| Route | Purpose |
| --- | --- |
| `POST /slack/events` | Slack Events API request URL. Answers `url_verification`; other events are acknowledged and dropped (for now). |
| `POST /teams/notify` | Microsoft Graph change-notification URL. Echoes `validationToken`; notifications are acknowledged with 202 and dropped (for now). |
| `POST /teams/lifecycle` | Graph lifecycle-notification URL. Same behaviour as `/teams/notify`. |
| `GET /diag/teams` | Self-test of the Microsoft side, guarded by the `x-opspile-diag` header. Returns the token's granted roles and the number of visible teams; `?sub=1` also creates and immediately deletes a `/teams/getAllMessages` subscription. Never returns a token. |

### Bindings

Nothing below is committed; set it on the Worker.

| Name | Kind | What |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | secret | Bot token of the opspile Slack app |
| `SLACK_SIGNING_SECRET` | secret | Signing secret of the opspile Slack app |
| `MS_CLIENT_SECRET` | secret | Client secret of the opspile Entra app registration |
| `DIAG_TOKEN` | secret | Random value required in `x-opspile-diag` for `/diag/*` |
| `MS_CLIENT_ID` | var | Application (client) id of the Entra app |
| `MS_TENANT_ID` | var | Directory (tenant) id |

The Entra app needs these Microsoft Graph **application** permissions, with admin consent:
`Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `User.Read.All`.

### Develop and deploy

```sh
npm install
npm run lint
npx wrangler secret put SLACK_BOT_TOKEN --env prod    # repeat per secret
export CLOUDFLARE_ACCOUNT_ID=…                         # not pinned in wrangler.toml
npm run deploy:prod                                    # or deploy:stage
```

`keep_vars = true` in `wrangler.toml` keeps the `MS_*` vars that were set outside the
file. For `wrangler dev`, put the bindings in an uncommitted `.dev.vars`.
