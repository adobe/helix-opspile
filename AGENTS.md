# AGENTS.md

Guidance for coding agents working on helix-opspile.

## What this is

An ops inbox fed from Slack, Microsoft Teams and Discord, and from its own customer portal (a
second Worker, for customers who can use none of the three), running on Cloudflare (Workers, R2,
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
- **A change ends in a pull request:** once it is done and tested, commit it to a branch, push,
  and open a PR (`gh pr create`), unless you were told not to. A change to the pages gets
  screenshots in it ("Debugging", below).

## Non-obvious code

- `ui/*.html` name their scripts (`<script type="module" src="inbox.js"></script>`), and
  `src/page.js` inlines them where the page is served. Never write a script into a page
  (`test/ui-scripts.test.js` fails on one). A file a page names goes into its Worker's map
  too, `SCRIPTS` in `src/pages.js` (`PORTAL_SCRIPTS` in `src/portal/pages.js`), which build
  the pages as the Worker loads: without it the Worker does not start
  (`test/ui-pages.test.js` builds them from those maps). `ui/app.js` is every page's script. It
  fetches `/api/*` without following redirects: a redirect is Cloudflare Access's sign-in, so
  the page shows "Sign in again" instead of "Failed to fetch" (`POST /__dev/signout` in
  `npm run ui:dev` shows it).
- People see this product as **Enterprise Support** ("the inbox" in a sentence), with the
  Adobe icon; the bots post under their own names per platform, so the pages call them "the
  bot". `opspile` stays the code name: the repository, identifiers, agent prompts, the MCP
  server, and messages about how a deployment is set up.
- The header is every page's too: its styles in `ui/spectrum.css` and `ui/header.js`, the global
  `Header`: the switch between the pages, which keeps where each page was left in the browser
  tab, and you with your menu. Change it there, not in a page.
- **The pages are Spectrum 2** (README, "Spectrum 2"), and their styles are all in
  `ui/spectrum.css` (every page's: the base, the header, the shared look) and
  `ui/spectrum-<page>.css` (the page's layout, then its look), which the pages link. A page
  has no `<style>` and the scripts write no static `style=""`: add a class and its rule there,
  with Spectrum 2 tokens (`var(--spectrum-…)`) only, no raw colors, lengths or durations
  (`test/ui-spectrum.test.js`); `spectrum-tokens.css` is built from what they use.
- **The customer portal is a second Worker in this repository**, not part of the inbox's:
  `src/portal/` (its entry `src/portal/worker.js`), its page `ui/portal.html`, `ui/portal.js` and
  `ui/spectrum-portal.css` (Spectrum 2 and `ui/app.js` as every page, but its own header: not
  `ui/header.js`, which is the staff's), its own D1 schema in `portal/migrations`, and its own
  `portal/cloudflare.config.ts` (`npm run deploy:portal:test`, as the renderer Worker's in
  `graphviz/`). To the inbox it is a
  platform, the source `portal` (`src/portalsource.js`, `src/portalrequests.js`). Neither Worker
  reads the other's database: they talk through the two entrypoints only (`PortalSource` in
  `src/portalentry.js`, `PortalPlatform` in `src/portal/worker.js`), and those two files are the
  only ones of them that import `cloudflare:workers`, so the rest stays testable in Node.
  `src/portal/ids.js` is the one file both import. What a customer sees is never a team's or
  another customer's: standalone portal API calls start from the signed-in mail address's domain.
  The service-only integration starts from a verified host, enrolled tenant and subject instead
  ([docs/PORTAL-INTEGRATION.md](docs/PORTAL-INTEGRATION.md)); its managed lobbies are never
  accessible by signing in with email.
  `npm run portal:dev` previews it (README, "Customer portal"). What people upload there (files,
  pictures, logos) is served so that a browser runs none of it (`src/portal/files.js`,
  `openThreadFile` in `src/fileview.js`): keep it so, and never serve SVG or HTML inline.
- **A team's and a customer's agent are sections of their pages** in Teams and Customers
  (`ui/admin.html`): `ui/agent.js` (the global `Agent`; thread agents, tools and MCP servers,
  extraction rules, the knowledge base and its editor) draws into the `#files` and `#editor`
  that `ui/admin.js` makes, which keeps the address (`view=`, `path=`). Before anything replaces
  what it shows, `ui/admin.js` awaits `Agent.leave()` (it saves, or asks). Its styles are
  `ui/spectrum-agent.css`, all under `.agent`. `/inbox/kb`, the page it was, redirects there.
- `ui/writing.js` (the global `Writing`) is the markdown formatting of a text box and the keys
  that format, the inbox's and the portal's: change a shortcut there, not in either page. The
  portal's box is rich text (`ui/richtext.js`, the global `RichText`): it sends HTML, and
  `src/portal/richtext.js` makes the markdown a message is kept in, through `src/html.js`'s
  tree. Nothing but that markdown is stored or shown: never render what a box sent as HTML.
- What a customer is told of Adobe's side of a thread (`src/portalstatus.js`: how many listen,
  the typical wait, the agent at work, a draft) is a number or a yes, never who or what: no
  name, team, agent step or draft text goes to the portal. `src/wait-model.js` is the estimate;
  `npm run response:waits` checks it against production before it is changed.
- Generated files: `src/emoji.js` (from `scripts/emoji.mjs`, do not edit it by hand),
  `src/ui-markdown.bundle.js`, `src/ui-editor.bundle.js` (CodeMirror, the knowledge-base
  editor's text field) and `src/ui-highlight.bundle.js` (@pierre/highlights, the code
  highlighter the Worker serves at `/inbox/highlight.js`) and `src/ui-fmc.bundle.js` (Graphviz
  and `src/fmc.js`, the stack drawing's renderer, at `/inbox/fmc.js`) and `src/ui-three.bundle.js`
  (three.js, the Topics page's map, at `/inbox/three.js`; all from
  `scripts/ui-markdown.mjs`, not committed), and
  `src/ui-spectrum.bundle.js` (Spectrum 2's tokens, from `@spectrum-css/tokens`, the same
  way). The `.wf-<kind>.ringed` masks at the end of `ui/spectrum-inbox.css` (a
  kind's icon inside an outline of its own shape) are written by `node scripts/wf-rings.mjs`,
  and committed: run it after changing `KIND_ICON` or a kind's icon. `npm run build` builds the bundles, and so do `npm test`, `npm run lint`,
  `npm run ui:dev`, `cf deploy` and `cf dev`. Run `npm ci` first in a fresh checkout.
- `/api/*` and `/mcp` hold D1 reads (`all()`, `first()` of a `SELECT`) for a 0 ms timer and send
  those asked for together as one `db.batch` (`src/d1batch.js`): one D1 request instead of one
  each. Writes, `run()` and `raw()` go at once. A query that fails in a batch is asked again on
  its own, so only it fails; `Server-Timing` counts a batch as one call.
- `src/agent/stub.js` reaches the `ThreadAgent` Durable Objects without importing the Agents
  SDK, so the paths that use it stay testable in Node. Keep SDK imports out of everything but
  `src/agent/agent.js`, and `agents/websearch` (it imports no `cloudflare:workers`) out of all
  but `src/agent/websearch.js`. The same goes for `@ai-ecoverse/slicc-kernel` (it imports
  `cloudflare:workers`): `src/agent/kernel.js` and `src/agent/image.js` have what Node can
  test, and `npm run computer:dev` runs an agent's computer in local workerd, its kernel and
  every image, to try the rest (README, "Try an agent's computer"); `npm run computer:check`
  runs every image's programs there, and on Cloudflare in the `Computer on stage` workflow, on
  a push to any branch but main that changes what the computer imports. Its `paths` list the
  files of `src/` the computer Worker imports: a new import from `src/agent/agent.js` goes
  there too (`test/computer-stage-paths.test.js` names it).
- The programs of a computer on the SLICC kernel are an **image** in the `IMAGES` bucket, not
  in the Worker: a stack of read-only layers, mounted at `/opt/image`.
  `scripts/computer-images.mjs` defines the layers and the images, from the
  `@ai-ecoverse/wasm-*` devDependencies, and `npm run computer:images` uploads them. Add a
  program to a layer there, with its package pinned, and name it in the `tools` of the images
  that have the layer.
- `ui/rank.js` is the team order's model; its `MODEL` block is written by `npm run rank -- train`
  (README, "Train the team order"), not by hand. `.rank/` holds production threads: never commit it.
- `scripts/dev-ui-fixtures.mjs` is the fake data of `npm run ui:dev`. Add the case a UI change
  is about, so the preview (and its screenshot) shows it.

- The knowledge bases' layout (which OKF type goes in which directory, one Contact per person at
  `contacts/<first-last>.md`) is `LAYOUT` in `src/agent/okf.js`: the agents' prompt is written
  from it, their writes are checked against it, and the inbox's profile cards find people by it
  (`src/kbpeople.js`). Change it there, and in docs/ARCHITECTURE.md, "Layout".

- Message bodies become markdown through a syntax tree, never by regular expressions on
  markdown: `src/html.js` (Teams), `src/slackmd.js` (Slack blocks and mrkdwn) and
  `src/discordmd.js` build mdast, and `src/mdast.js` writes it. A platform's quirk goes into its
  module's tree; what every platform needs (spacing around bold, link form) into `src/mdast.js`.

- **The search finds knowledge-base entries in D1, not in Artifacts:** `kb_concepts`
  (src/kbindex.js) has a row per concept and `CONTENT` a vector (`type: kb`), kept by every
  write (src/agent/kbwrite.js) and the cron; src/kbsearch.js answers `/api/search`'s `kb` from
  them. A query of the threads' vectors names its `type` (`message`, `thread`), or it gets
  the concepts' too.

- **A merged org is a rule:** `loadRules` (src/lookup.js) adds every row of `org_merges` as a
  rule of target `merge`, and `classify` files what the other rules give a merged slug under the
  org it went into (`mergedOrg` in src/rules.js). Get the rules from `loadRules`, never from
  `SELECT * FROM rules`, or a merged org comes back. The duplicate search, the merge and its
  requests are src/orgmerge.js.

- **Most lifecycles here are implicit:** a nullable timestamp, a watermark, whether a row exists.
  [docs/STATE-MACHINES.md](docs/STATE-MACHINES.md) lists them, with the rules they follow. Read the
  entry before changing one, and add one for anything new with a lifecycle.

## Debugging

- **The inbox in a browser: `playwright-cli`, without `--cdp`.** Chrome runs with remote
  debugging on a port of its choosing, which `playwright-cli` finds by itself (`tab-list`,
  then `tab-select`; never assume 9222), and is signed in to the inbox (Cloudflare Access),
  so `goto`, `snapshot`, `eval`, `click` and `screenshot` work on the production inbox as the
  user sees it.
  `screenshot` and `drop` take refs from `snapshot` (`e492`), not CSS selectors. To check a
  fix before it is deployed, run `npm run ui:dev` (`PORT=` for another port) and open it in
  the same browser; `npm run ui:session -- <inbox origin> --cdp http://127.0.0.1:<port>`
  points it at production's API, read-only.
- **Screenshots for pull requests** come from `npm run ui:dev`, never from production. To
  attach them, pass the files to `gh`: `gh pr create`, `gh pr edit` and `gh pr comment` take
  `--attach '<file>#<alt text>'`, once per file. A body that names a file
  (`![alt](./shot.png)`) gets its `user-attachments` URL there; one it does not name is added at
  the end. A motion is caught half-way by making its duration long in the page first
  (`--side-motion` on `main`, for one).
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
