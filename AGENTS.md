# AGENTS.md

Guidance for coding agents working on helix-opspile.

## What this is

An ops inbox fed from Slack, Microsoft Teams and Discord, running on Cloudflare (Workers, R2,
Queues, D1/Durable Objects). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before
changing anything: it defines the four piles and the on-disk layout of pile 2.

## Rules

- **This repository is public.** Never commit message content, channel or team names,
  customer names, account ids, tenant ids, app ids or tokens — not in code, fixtures,
  docs, issues or commit messages. Identifiers live in Worker bindings.
- Credentials are Worker secrets; plain ids are Worker vars. Both are listed in the
  README's "Bindings" section — keep that list current when you add one.
- Entra client-credentials token redemption only works server-side (from the Worker);
  a browser-origin request fails with AADSTS9002326.
- Code style is `@adobe/eslint-config-helix` (`npm run lint`), ES modules, 2-space indent,
  max line length 100.

## Layout

- `src/index.js` — router
- `src/slack.js` — Slack Events API endpoint; `src/slackfiles.js` — the files of Slack Connect
  channels, looked up with `files.info` and kept in pile 1
- `src/teams.js` — Graph validation endpoint, token and client helpers
- `src/discord.js` — Discord REST helpers, snowflakes and pile-1 envelopes; `src/poller.js` —
  the `DiscordPoller` Durable Object that polls the servers for new messages, edits, deletions
  and reactions; `src/platforms.js` — platform names
- `src/bots.js` — the bots installed in each Teams team (cron), so replies can mention them
- `src/diag.js` — guarded `/diag/teams` self-test
- `src/drafts.js` — shared drafts: one unsent reply per thread, seen by the channel's teams
- `src/postapp.js` — a person posting as the opspile app, where the channel's **Post messages**
  switch lets the app post (`POST /api/post/app`)
- `src/shares.js` — channels shared by several teams: filed under their first team, in the
  others' inboxes too (`channel_teams`)
- `src/kb.js` — pile 3: creates the org and team knowledge-base repos in Artifacts
- `src/admin.js` and `ui/admin.html` — the admin team's pages for teams, members, rules and
  orgs at `/inbox/admin` (team managers: their teams' members, and requests for channels,
  `src/requests.js`, which the admin team confirms or declines); `src/refile.js` moves channels a rule change re-files;
  `src/suggest.js` suggests the admin team's channels to the teams (members' activity, Clef per channel, cron)
- `src/kbadmin.js` and `ui/kb.html` — the admin team's knowledge-base editor at `/inbox/kb`
  (including each knowledge base's `systemprompt.md` for the agents, and the per-channel switch
  of the thread agents, `src/agent/enabled.js`)
- `src/agent/` — thread agents: `agent.js` (the `ThreadAgent` Durable Object, Pi via
  `PiHarness`), `tools.js` (its prompt and tools), `files.js` (the files attached to its thread's messages, which `read_file` reads),
  `history.js` (the other threads of its
  channel, which it may list and read), `agenttools.js` (the tools that are off until
  a team or channel turns them on: `post_message`, in `posting.js`, and the `computer`, pi's
  bash on Cloudflare Computer, in `computer.js`), `deliver.js` (what it is told, Clef's
  prompt-injection check), `model.js` (Bedrock through AI Gateway), `repos.js` (reading
  knowledge bases and GitHub mirrors), `kbwrite.js`, `okf.js` and `memfs.js` (OKF writes with
  isomorphic-git in memory), `mcp.js` and `mcpclient.js` (the team's and customer's MCP
  servers, reachable from code mode scripts), `stub.js` (reaching agents without importing the
  SDK), `turn.js` (the latest turn the inbox shows under the thread), `trace.js` (its transcript
  as steps, for the admin team's MCP tool `get_thread_trace`)
- `src/tooladmin.js` — the switches of the agents' tools in the knowledge-base editor
- `src/teamsbot.js` — the opspile Teams bot (Bot Framework), how agents post in Teams;
  `scripts/teams-app.mjs` builds its Teams app package
- `src/mcpadmin.js` — the agents' MCP servers in the knowledge-base editor, per team and per org,
  and the global ones' switches per team and channel
- `src/agent/globals.js` — the global MCP servers (`browser`, `github`), their switches and
  connections (`browser` is Cloudflare's hosted Browser Run MCP server);
  `src/github.js` — the GitHub App of the `github` server (manifest flow, installation tokens)
- `src/timing.js` — the `Server-Timing` header on every `/api/*` answer (D1, R2, auth, total;
  durations and counts only); `src/filecache.js` — thread files kept per isolate by R2 version
- `src/mcp.js` — `/mcp` MCP server (transport, protocol); `src/mcp-tools.js` — its tools
- `src/page.js` — serves `ui/inbox.html` with Slack's emoji names from `src/emoji.js`, which
  `scripts/emoji.mjs` generates (do not edit it by hand), and with the page's markdown renderer
  `src/ui-markdown.js` (micromark), which `scripts/ui-markdown.mjs` bundles into
  `src/ui-markdown.bundle.js` (generated, not committed: `npm run build`; `cf deploy`, `cf dev`,
  `npm test`, `npm run lint` and `npm run ui:dev` build it)
- `cloudflare.config.ts` — `cf` deploy config; `--mode prod` and `--mode stage`
