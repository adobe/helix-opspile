# AGENTS.md

Guidance for coding agents working on helix-opspile.

## What this is

An ops inbox fed from Slack and Microsoft Teams, running on Cloudflare (Workers, R2,
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
- `src/slack.js` — Slack Events API endpoint
- `src/teams.js` — Graph validation endpoint, token and client helpers
- `src/diag.js` — guarded `/diag/teams` self-test
- `src/drafts.js` — shared drafts: one unsent reply per thread, seen by the channel's team
- `src/kb.js` — pile 3: creates the org and team knowledge-base repos in Artifacts
- `src/admin.js` and `ui/admin.html` — the admin team's pages for teams, members, rules and
  orgs at `/inbox/admin` (team managers: their teams' members); `src/refile.js` moves channels a rule change re-files
- `src/kbadmin.js` and `ui/kb.html` — the admin team's knowledge-base editor at `/inbox/kb`
  (including each knowledge base's `systemprompt.md` for the agents)
- `src/agent/` — thread agents: `agent.js` (the `ThreadAgent` Durable Object, Pi via
  `PiHarness`), `tools.js` (its prompt and tools), `deliver.js` (what it is told, Clef's
  prompt-injection check), `model.js` (Bedrock through AI Gateway), `repos.js` (reading
  knowledge bases and GitHub mirrors), `kbwrite.js`, `okf.js` and `memfs.js` (OKF writes with
  isomorphic-git in memory), `stub.js` (reaching agents without importing the SDK)
- `src/timing.js` — the `Server-Timing` header on every `/api/*` answer (D1, R2, auth, total;
  durations and counts only); `src/filecache.js` — thread files kept per isolate by R2 version
- `src/mcp.js` — `/mcp` MCP server (transport, protocol); `src/mcp-tools.js` — its tools
- `src/page.js` — serves `ui/inbox.html` with Slack's emoji names from `src/emoji.js`, which
  `scripts/emoji.mjs` generates (do not edit it by hand), and with the page's markdown renderer
  `src/ui-markdown.js` (micromark), which `scripts/ui-markdown.mjs` bundles into
  `src/ui-markdown.bundle.js` (generated, not committed: `npm run build`; `cf deploy`, `cf dev`,
  `npm test`, `npm run lint` and `npm run ui:dev` build it)
- `cloudflare.config.ts` — `cf` deploy config; `--mode prod` and `--mode stage`
