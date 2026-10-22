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
- `src/kb.js` — pile 3: creates the org and team knowledge-base repos in Artifacts
- `src/page.js` — serves `ui/inbox.html` with Slack's emoji names from `src/emoji.js`, which
  `scripts/emoji.mjs` generates (do not edit it by hand)
- `cloudflare.config.ts` — `cf` deploy config; `--mode prod` and `--mode stage`
