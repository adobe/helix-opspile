# AGENTS.md

Guidance for coding agents working on helix-opspile.

## What this is

An ops inbox fed from Slack, Microsoft Teams and Discord, running on Cloudflare (Workers, R2,
Queues, D1/Durable Objects). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before
changing anything: it defines the four piles and the on-disk layout of pile 2. **Clef**, in
code and docs, is the decision model that labels threads and channels.

## Rules

- **This repository is public.** Never commit message content, channel or team names,
  customer names, account ids, tenant ids, app ids or tokens — not in code, fixtures,
  docs, issues, commit messages or screenshots. Identifiers live in Worker bindings.
- Credentials are Worker secrets; plain ids are Worker vars. Both are listed in the
  README's "Bindings" section — keep that list current when you add one.
- Entra client-credentials token redemption only works server-side (from the Worker);
  a browser-origin request fails with AADSTS9002326.
- Code style is `@adobe/eslint-config-helix` (`npm run lint`), ES modules, 2-space indent,
  max line length 100.

## Non-obvious code

- `ui/*.html` name their scripts (`<script type="module" src="inbox.js"></script>`), and
  `src/page.js` inlines them where the page is served. Never write a script into a page
  (`test/ui-scripts.test.js` fails on one). `ui/app.js` is every page's script. It
  fetches `/api/*` without following redirects: a redirect is Cloudflare Access's sign-in, so
  the page shows "Sign in again" instead of "Failed to fetch" (`POST /__dev/signout` in
  `npm run ui:dev` shows it).
- The header is every page's too: `ui/header.css` (`<link rel="stylesheet" href="header.css">`,
  inlined the same way) and `ui/header.js`, the global `Header`: the switch between the pages,
  which keeps where each page was left in the browser tab, and you with your menu. Change it
  there, not in a page.
- Generated files: `src/emoji.js` (from `scripts/emoji.mjs`, do not edit it by hand),
  `src/ui-markdown.bundle.js` and `src/ui-editor.bundle.js` (CodeMirror, the knowledge-base
  editor's text field; both from `scripts/ui-markdown.mjs`, not committed). `npm run build`
  builds the bundles, and so do `npm test`, `npm run lint`, `npm run ui:dev`, `cf deploy` and
  `cf dev`. Run `npm ci` first in a fresh checkout.
- `src/agent/stub.js` reaches the `ThreadAgent` Durable Objects without importing the Agents
  SDK, so the paths that use it stay testable in Node. Keep SDK imports out of everything but
  `src/agent/agent.js`.
- `ui/rank.js` is the team order's model; its `MODEL` block is written by `npm run rank -- train`
  (README, "Train the team order"), not by hand. `.rank/` holds production threads: never commit it.
- `scripts/dev-ui-fixtures.mjs` is the fake data of `npm run ui:dev`. Add the case a UI change
  is about, so the preview (and its screenshot) shows it.

## Debugging

- **The inbox in a browser: `playwright-cli --cdp=9222`.** Chrome runs with remote debugging
  on port 9222 and is signed in to the inbox (Cloudflare Access), so `goto`, `snapshot`,
  `eval`, `click` and `screenshot` work on the production inbox as the user sees it.
  `screenshot` and `drop` take refs from `snapshot` (`e492`), not CSS selectors. To check a
  fix before it is deployed, run `npm run ui:dev` (`PORT=` for another port) and open it in
  the same browser; `npm run ui:session -- <inbox origin>` points it at production's API,
  read-only.
- **Screenshots for pull requests** come from `npm run ui:dev`, never from production. To
  attach one, `drop` the files onto the PR's comment box. GitHub writes their
  `user-attachments` URLs into the box: read them with `eval`, clear the box, and put them in
  the PR body.
- **The Worker: `cf`**, the Cloudflare CLI (reads `cloudflare.config.ts`; `--mode prod` or
  `--mode stage`). Find a command with `cf cli search "<task>"`, then `<command> --help`, and
  keep the search anonymous. `cf o11y telemetry query` searches the Worker's logs,
  `cf o11y telemetry live-tail` follows them, and `cf d1 query <database id>` reads D1.
- **`npx wrangler`** where `cf` cannot do something yet: `wrangler tail helix-opspile-prod`
  streams live logs, `wrangler secret put` sets one secret, and
  `wrangler d1 execute helix-opspile --remote --command "SELECT …"` queries D1
  (`helix-opspile-stage` for stage).
- Production is live. Read from it freely, but get the user's go-ahead before anything that
  writes: D1 changes, secrets, deploys, posts.
- `/diag/*` (the `DIAG_TOKEN` secret in the `x-opspile-diag` header; see the README) shows
  the Teams side, the Discord poller and single thread agents as the Worker sees them.
