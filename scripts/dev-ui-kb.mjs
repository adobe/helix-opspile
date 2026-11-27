/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import git from 'isomorphic-git';
import { checkChanges, commitChanges } from '../src/agent/kbwrite.js';
import { memfs } from '../src/agent/memfs.js';
import { isEntry, SYSTEM_PROMPT } from '../src/agent/okf.js';
import { inCatalog } from '../src/catalog.js';
import { areaFile, isArea } from '../src/areas.js';
import { BUILT_IN_AREAS } from '../src/label.js';
import { stackFile } from '../src/stack.js';

/**
 * Fake knowledge bases for `npm run ui:dev`: real git repos in memory, written by the same
 * `commitChanges` as production (OKF checks, indexes, log), behind the `/api/kb*` routes of
 * src/kbadmin.js. Made-up content only.
 */

/**
 * ACME's stack drawing (src/stack.js), which the inbox shows from ACME's heading; Globex has
 * none, so its heading shows what Clef saw instead. The FMC gallery (scripts/fmc-gallery.mjs)
 * draws it too.
 */
export const ACME_STACK = {
  summary: 'ACME sells on an Edge Delivery storefront behind Akamai, with Adobe Commerce for the catalog, cart and checkout. Orders go on to their ERP through an App Builder action; authors write in SharePoint.',
  parts: [
    { layer: 'edge', name: 'Shoppers', kind: 'person' },
    {
      layer: 'edge', name: 'Akamai', tech: 'akamai', note: 'www.acme.example; /checkout bypasses the cache',
    },
    {
      layer: 'site', name: 'Edge Delivery', tech: 'eds', note: 'storefront and PDPs, `acme/storefront`',
    },
    {
      layer: 'site', name: 'Legacy shop', tech: 'aem65', note: 'the B2B pages, until they move',
    },
    { layer: 'content', name: 'Authors', kind: 'person' },
    {
      layer: 'content', name: 'SharePoint', kind: 'storage', group: 'Authoring', tech: 'sharepoint', note: 'pages and the redirects sheet',
    },
    {
      layer: 'content', name: 'Assets', kind: 'storage', group: 'Authoring', tech: 'assets', note: 'product images',
    },
    {
      layer: 'code', name: 'GitHub', kind: 'storage', tech: 'github', note: '`acme/storefront`, `acme/order-sync`',
    },
    {
      layer: 'code', name: 'App Builder', tech: 'appbuilder', note: 'order sync every 5 minutes',
    },
    {
      layer: 'commerce', name: 'Adobe Commerce', tech: 'commerce', note: 'catalog, cart, checkout',
    },
    {
      layer: 'commerce', name: 'Payments', kind: 'external', note: 'hosted payment page',
    },
    {
      layer: 'commerce', name: 'ERP', tech: 'erp', note: 'fulfilment and invoices',
    },
    {
      layer: 'martech', name: 'Adobe Analytics', tech: 'analytics', note: 'through Launch',
    },
    {
      layer: 'identity', name: 'Okta', tech: 'sso', note: 'authors sign in to SharePoint and the Sidekick',
    },
  ],
  flows: [
    {
      from: 'Shoppers', to: 'Akamai', kind: 'request', label: 'HTTPS',
    },
    {
      from: 'Akamai', to: 'Edge Delivery', kind: 'request', label: 'every page but /b2b',
    },
    {
      from: 'Akamai', to: 'Legacy shop', kind: 'request', label: '/b2b',
    },
    {
      from: 'Authors', to: 'SharePoint', kind: 'modify', label: 'pages',
    },
    {
      from: 'Edge Delivery', to: 'SharePoint', kind: 'read', label: 'preview and publish',
    },
    {
      from: 'Edge Delivery', to: 'Assets', kind: 'read', label: 'images',
    },
    {
      from: 'Edge Delivery', to: 'GitHub', kind: 'read', label: 'code',
    },
    {
      from: 'Edge Delivery', to: 'Adobe Commerce', kind: 'request', label: 'cart and checkout',
    },
    {
      from: 'Adobe Commerce', to: 'Payments', kind: 'request', label: 'payment',
    },
    { from: 'Adobe Commerce', to: 'App Builder', label: 'new orders' },
    { from: 'App Builder', to: 'ERP', label: 'orders, every 5 minutes' },
  ],
  notes: '## Open questions\n\n- When the B2B pages move to Edge Delivery.',
};

const DIR = '/kb';
/** A made-up delivery stack, as an FMC block diagram: requests down, content up. */
const DELIVERY_DOT = `// The path of a visitor's request through the CDNs to the content, and how authors publish.
digraph delivery {
  label="How a page is delivered";
  graph [nodesep=0.3, ranksep=0.35, newrank=true];
  node [shape=box, fixedsize=true, width=1.3, height=0.6];
  edge [dir=none];

  visitor [fmc=person, label="Visitor", width=0.85, height=0.85];
  author [fmc=person, label="Author", width=0.85, height=0.85];
  // Defaults in braces hold for those only: the channels are small circles, the rest boxes.
  { node [fmc=channel, label="", width=0.16, height=0.16, request=true]; c1; c2; c3; c4; }
  subgraph cluster_edge { fmc=group; label="Edge";
    byo [label="Customer CDN"];
    outer [label="Outer CDN\\n\`*.example.live\`", width=2.8];
    cache [fmc=storage, style=rounded, label="Cache"];
  }
  subgraph cluster_pipe { fmc=group; label="Pipeline";
    pipeline [label="Pipeline"];
    subgraph cluster_store { fmc=storage; label="Content store";
      node [fmc=storage, style=rounded, width=0.9, height=0.26];
      p1 [label="preview"]; p2 [label="live"];
    }
  }
  editor [label="Editor"];
  { rank=same; visitor; author; }
  { rank=same; outer; cache; }
  { rank=same; p1; p2; } p2 -> p1 [style=invis];

  visitor -> c1 -> byo; byo -> c2 -> outer; outer -> cache [dir=both];
  outer -> c3 -> pipeline; pipeline -> p2 [dir=back, lhead=cluster_store];
  author -> c4 -> editor; editor -> p1 [dir=forward, lhead=cluster_store];
}
`;
/**
 * Platform ops' own stack drawing: the setup it runs for its customers, which its overview shows
 * under its knowledge base (ui/team.js).
 */
export const PLATFORM_STACK = {
  summary: 'Most of Platform ops\' customers run Edge Delivery behind their own CDN, authors writing in SharePoint or Document Authoring, code on GitHub.',
  parts: [
    { layer: 'edge', name: 'Visitors', kind: 'person' },
    {
      layer: 'edge', name: 'Customer CDN', tech: 'fastly', note: 'Fastly or Akamai, run by the customer',
    },
    {
      layer: 'edge', name: 'Adobe Managed CDN', tech: 'adobe/aem-sites/managed-cdn', note: 'for those without one',
    },
    {
      layer: 'site', name: 'Edge Delivery', tech: 'eds', note: 'the pages and their code',
    },
    { layer: 'content', name: 'Authors', kind: 'person' },
    {
      layer: 'content', name: 'SharePoint', kind: 'storage', tech: 'sharepoint', note: 'documents and sheets',
    },
    {
      layer: 'content', name: 'Document Authoring', kind: 'storage', tech: 'da',
    },
    {
      layer: 'code', name: 'GitHub', kind: 'storage', tech: 'github', note: 'one repository per site',
    },
  ],
  flows: [
    {
      from: 'Visitors', to: 'Customer CDN', kind: 'request', label: 'HTTPS',
    },
    {
      from: 'Visitors', to: 'Adobe Managed CDN', kind: 'request', label: 'HTTPS',
    },
    {
      from: 'Customer CDN', to: 'Edge Delivery', kind: 'request', label: 'cache misses',
    },
    {
      from: 'Adobe Managed CDN', to: 'Edge Delivery', kind: 'request', label: 'cache misses',
    },
    {
      from: 'Authors', to: 'SharePoint', kind: 'modify', label: 'pages',
    },
    {
      from: 'Authors', to: 'Document Authoring', kind: 'modify', label: 'pages',
    },
    {
      from: 'Edge Delivery', to: 'SharePoint', kind: 'read', label: 'preview and publish',
    },
    {
      from: 'Edge Delivery', to: 'Document Authoring', kind: 'read', label: 'preview and publish',
    },
    {
      from: 'Edge Delivery', to: 'GitHub', kind: 'read', label: 'code',
    },
  ],
};
const SEED = {
  'kb-team-platform': {
    name: 'Platform ops',
    kind: 'team',
    files: {
      [SYSTEM_PROMPT]: '---\ntype: System Prompt\ntitle: Agent instructions for Platform ops\n---\n\nSign drafts with the team name, never a person\'s.\n',
      // A diagram (src/dot.js), drawn beside its DOT in the editor, and the concept it belongs to.
      'reference/delivery.md': '---\ntype: Reference\ntitle: How a page is delivered\ndescription: The path of a visitor\'s request through the CDNs to the content.\n---\n\n'
        + 'The visitor\'s CDN asks ours, which asks the pipeline; authors publish to the content store. '
        + 'See [the diagram](/reference/delivery.dot).\n',
      'reference/delivery.dot': DELIVERY_DOT,
      // Frontmatter, folded when it opens, and Markdown, both highlighted (src/ui-editor.js).
      'playbooks/cdn-purge.md': [
        '---', 'type: Playbook', 'title: CDN purge takes long',
        'description: "What to check when a purge seems slow."', 'tags: [cdn, cache]', 'reviewed: 2026-03-02',
        '---', '', '# CDN purge takes long', '', 'A purge is **usually** done in a few seconds; *slow* ones have a cause.',
        '', '## Check', '', '1. The cache TTL: `curl -sI https://www.example.com/ | grep -i age`.',
        '2. A second CDN in front, see [the site](../sites/www.md).', '', '> Ask the customer before purging everything.', '',
      ].join('\n'),
      // The team's catalog (src/catalog.js): what Clef asks about. Fastly was a technology of the
      // admin team's (`fastly`) until it moved here; the managed CDN is a feature of its own.
      'products/fastly/cdn.md': [
        '---', 'type: Product', 'title: Fastly', 'description: Fastly as CDN, run by the customer',
        'aliases: [Fastly CDN, Compute@Edge]', 'layer: edge', 'moved_from: [fastly]', '---', '',
        // The record of it, wrapped as the agents write files: the Topics page shows it.
        '# Fastly', '',
        'Customers who bring their own Fastly service in front of the site. It asks our CDN for the',
        'pages, so a purge has to reach both: ours first, then theirs.', '',
        '## How it is set up', '',
        '- The service\'s origin is the site\'s live host, with the host header set to it.',
        '- A **push invalidation** key lets us purge their service when an author publishes.',
        '- `X-Forwarded-Host` carries the customer\'s domain, for redirects and the sitemap.', '',
        '## Known issues', '',
        '- Pages stay stale after publishing when the purge key is missing: see',
        '  [the purge playbook](../../playbooks/cdn-purge.md).',
        '- A VCL that strips `Cache-Control` keeps HTML for a day.', '',
        'Dana knows it best; ACME and Globex run it.', '',
      ].join('\n'),
      // Two vendors' products (dev-ui-vendor.mjs): the vendors' pages list their customers.
      'products/initech/edge.md': [
        '---', 'type: Product', 'title: Initech Edge', 'description: Initech\'s edge network in front of the site',
        'layer: edge', '---', '', 'A few customers run it in front of Edge Delivery.', '',
      ].join('\n'),
      'products/vandelay/translate.md': [
        '---', 'type: Product', 'title: Vandelay Translate', 'description: Vandelay\'s translation service',
        'layer: content', '---', '', 'Translations of customers\' pages, through its connector.', '',
      ].join('\n'),
      'products/adobe/aem-sites.md': [
        '---', 'type: Product', 'title: Experience Manager Sites',
        'description: Adobe Experience Manager Sites', '---', '', 'Its features, one file each.', '',
      ].join('\n'),
      'products/adobe/aem-sites/managed-cdn.md': [
        '---', 'type: Feature', 'title: Adobe Managed CDN',
        'description: the CDN Adobe runs for Edge Delivery or AEM as a Cloud Service',
        'aliases: [Managed CDN]', 'layer: edge', '---', '',
        'Adobe runs it; the customer points their domain at it.', '',
      ].join('\n'),
      // What it learned, a few of each type, for its overview (ui/team.js).
      'issues/purge-stale-html.md': '---\ntype: Known Issue\ntitle: Purged pages still served stale\ndescription: A second CDN in front keeps its own copy after a purge.\n---\n\nPurge both CDNs, ours first.\n',
      'issues/sso-loop.md': '---\ntype: Known Issue\ntitle: Sign-in loops after an IdP change\ndescription: The Sidekick keeps the old session until it is signed out.\n---\n\nSign out of the Sidekick, then in again.\n',
      'issues/redirect-sheet-limit.md': '---\ntype: Known Issue\ntitle: Redirects sheet over its row limit\ndescription: Rows after the limit are ignored, silently.\n---\n\nSplit the sheet by path prefix.\n',
      'playbooks/go-live.md': '---\ntype: Playbook\ntitle: Go-live checklist\ndescription: DNS, CDN, redirects and the sitemap, in that order.\n---\n\n1. Lower the DNS TTL a day before.\n',
      'decisions/managed-cdn-default.md': '---\ntype: Decision\ntitle: Adobe Managed CDN by default\ndescription: New sites start on the managed CDN unless the customer runs their own.\n---\n\nAgreed by the team in October.\n',
      'stack.md': stackFile(PLATFORM_STACK, { title: 'What Platform ops runs for its customers', keep: 'status: stable' }),
      // Its members' profiles (docs/ARCHITECTURE.md, "Layout"): their cards show them.
      'contacts/dana-ops.md': [
        '---', 'type: Contact', 'title: Dana Ops',
        'description: Platform ops\' site reliability engineer; owns the CDN setups and is on call for launches.',
        '---', '', '# Dana Ops', '', 'Knows Fastly and Akamai in front of Edge Delivery best; ACME and Globex are hers.', '',
      ].join('\n'),
      'contacts/priya-nair.md': [
        '---', 'type: Contact', 'title: Priya Nair',
        'description: Platform ops\' support engineer for sign-in and authoring: SSO, Document Authoring and SharePoint.',
        '---', '', '# Priya Nair', '',
      ].join('\n'),
      // Her Discord name among her aliases: it suggests her for the Discord staff account of that
      // name (src/accountlinks.js, the admin team's Staff accounts).
      'contacts/lena-berg.md': [
        '---', 'type: Contact', 'title: Lena Berg',
        'description: Platform ops\' engineer for forms and the Sidekick.',
        'aliases: [Lena, lb_ops]', '---', '', '# Lena Berg', '',
      ].join('\n'),
      // A partner the team works with across customers.
      'contacts/ravi-kumar.md': [
        '---', 'type: Contact', 'title: Ravi Kumar',
        'description: Solution architect at Agency Co, the partner that builds several customers\' sites; reviews their CDN setups.',
        '---', '', '# Ravi Kumar', '',
      ].join('\n'),
    },
  },
  // Edge ops words Fastly otherwise: a conflict for the admin team (src/techconflicts.js).
  'kb-team-edge': {
    name: 'Edge ops',
    kind: 'team',
    files: {
      'products/fastly/cdn.md': [
        '---', 'type: Product', 'title: Fastly', 'description: Fastly as CDN, with Compute at the edge',
        'layer: edge', '---', '', 'Edge ops\' own words for it, in its channels.', '',
      ].join('\n'),
    },
  },
  // The admin team's: its extraction rules and tech stack apply to every channel.
  // The areas Clef asks about (src/areas.js), as the bootstrap wrote production's.
  'kb-team-admin': {
    name: 'Admin',
    kind: 'team',
    files: Object.fromEntries(BUILT_IN_AREAS.map((a) => [`areas/${a.id}.md`, areaFile({ title: a.name, what: a.what })])),
  },
  'kb-org-acme': {
    name: 'acme',
    kind: 'org',
    files: {
      'sites/www.md': '---\ntype: Site\ntitle: www\ndescription: The main website, on Fastly.\n---\n\nGoes live in March.\n',
      'stack.md': stackFile(ACME_STACK, { title: 'Tech stack of ACME', keep: 'status: stable' }),
      // People, one Contact each (docs/ARCHITECTURE.md, "Layout"): the profile cards show them.
      'contacts/sam-reyes.md': [
        '---', 'type: Contact', 'title: Sam Reyes',
        'description: ACME\'s web lead; owns the go-live date and signs off on DNS and CDN changes.',
        'aliases: [sreyes]', 'resource: mailto:sam@acme.example', 'status: stable', '---', '',
        '# Sam Reyes', '', 'Prefers a call over a long thread for anything that touches the launch.', '',
      ].join('\n'),
      'contacts/dana-ops.md': [
        '---', 'type: Contact', 'title: Dana Ops',
        'description: Adobe\'s site reliability engineer on the ACME account; set up their CDN and on call for the launch.',
        '---', '', '# Dana Ops', '', 'Knows the Fastly setup of [www](/sites/www.md) best.', '',
      ].join('\n'),
    },
  },
  // More customers, so that the list's sort (by activity: entries, then tools) has something to do.
  'kb-org-initech': {
    name: 'initech',
    kind: 'org',
    files: {
      'sites/support.md': '---\ntype: Site\ntitle: support\ndescription: Their support portal.\n---\n\nOn the legacy stack until the migration.\n',
      'people/contacts.md': '---\ntype: Reference\ntitle: Contacts\ndescription: Who to ask at Initech.\n---\n\nThe release manager, for anything about go-lives.\n',
    },
  },
  'kb-org-globex': { name: 'globex', kind: 'org', files: {} },
  'kb-org-umbrella': { name: 'umbrella', kind: 'org', files: {} },
  // Forms ops' customer alone: Dana reads it, and its agent changes nothing for her.
  'kb-org-massive': {
    name: 'massive',
    kind: 'org',
    files: {
      'sites/surveys.md': '---\ntype: Site\ntitle: surveys\ndescription: Their survey forms, on AEM Forms.\n---\n\nUploads up to 10 MB since the limit was raised.\n',
    },
  },
};

export async function createKnowledgeBases() {
  const repos = new Map();
  for (const [repo, seed] of Object.entries(SEED)) {
    const fs = memfs();
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdirp(DIR);
    // eslint-disable-next-line no-await-in-loop
    await git.init({ fs, dir: DIR, defaultBranch: 'main' });
    const changes = Object.entries(seed.files).map(([path, content]) => ({ path, content }));
    if (changes.length) {
      // eslint-disable-next-line no-await-in-loop
      await commitChanges(fs, changes, {
        message: 'Seed', by: 'human:dana@staff.example', at: '2026-10-20T09:00:00.000Z', logEntry: '**Creation**: seed',
      });
    }
    repos.set(repo, { ...seed, fs, entries: changes.filter((c) => isEntry(c.path)).length });
  }

  const blobHash = async (fs, path) => (await git.hashBlob({
    object: await fs.promises.readFile(`${DIR}/${path}`),
  })).oid;
  const tracked = async (r) => {
    try {
      return await git.listFiles({ fs: r.fs, dir: DIR });
    } catch {
      return [];
    }
  };

  return {
    list: () => [...repos].map(([repo, r]) => ({
      repo,
      kind: r.kind,
      slug: repo.replace(/^kb-(team|org)-/, ''),
      name: r.name,
      created_at: '2026-10-20T09:00:00.000Z',
      entries: r.entries,
    })).sort((x, y) => y.kind.localeCompare(x.kind) || x.slug.localeCompare(y.slug)),
    has: (repo) => repos.has(repo),
    async files(repo) {
      const r = repos.get(repo);
      const paths = await tracked(r);
      return Promise.all(paths.map(async (path) => ({ path, hash: await blobHash(r.fs, path) })));
    },
    async read(repo, path) {
      const r = repos.get(repo);
      if (!(await tracked(r)).includes(path)) {
        return { error: `no such file: ${path}` };
      }
      return { path, hash: await blobHash(r.fs, path), text: await r.fs.promises.readFile(`${DIR}/${path}`, 'utf8') };
    },
    /** `{ [hash]: text }` of the tracked files whose blob hash is one of `hashes`. */
    async blobs(repo, hashes) {
      const r = repos.get(repo);
      const out = {};
      for (const path of await tracked(r)) {
        // eslint-disable-next-line no-await-in-loop
        const hash = await blobHash(r.fs, path);
        if (hashes.includes(hash)) {
          // eslint-disable-next-line no-await-in-loop
          out[hash] = await r.fs.promises.readFile(`${DIR}/${path}`, 'utf8');
        }
      }
      return out;
    },
    async write(repo, changes, options) {
      const { kind } = repos.get(repo);
      const invalid = checkChanges(changes, { staff: true, kind });
      return invalid ? { error: invalid }
        : commitChanges(repos.get(repo).fs, changes, { ...options, catalog: kind === 'team' });
    },
    /** The catalog files of a team's knowledge base, `[{ path, text }]` (src/catalog.js). */
    async catalog(repo) {
      const r = repos.get(repo);
      const paths = (await tracked(r)).filter((p) => inCatalog(p) || isArea(p));
      return Promise.all(paths.map(async (path) => ({
        path, text: await r.fs.promises.readFile(`${DIR}/${path}`, 'utf8'),
      })));
    },
    async log(repo) {
      const commits = await git.log({ fs: repos.get(repo).fs, dir: DIR }).catch(() => []);
      return commits.map((c) => ({
        hash: c.oid.slice(0, 12),
        at: new Date(c.commit.author.timestamp * 1000).toISOString(),
        author: c.commit.author.name,
        message: c.commit.message.split('\n')[0],
      }));
    },
  };
}
