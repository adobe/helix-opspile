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
const SEED = {
  'kb-team-platform': {
    name: 'Platform ops',
    kind: 'team',
    files: {
      [SYSTEM_PROMPT]: '---\ntype: System Prompt\ntitle: Agent instructions for Platform ops\n---\n\nSign drafts with the team name, never a person\'s.\n',
      // Frontmatter, folded when it opens, and Markdown, both highlighted (src/ui-editor.js).
      'playbooks/cdn-purge.md': [
        '---', 'type: Playbook', 'title: CDN purge takes long',
        'description: "What to check when a purge seems slow."', 'tags: [cdn, cache]', 'reviewed: 2026-03-02',
        '---', '', '# CDN purge takes long', '', 'A purge is **usually** done in a few seconds; *slow* ones have a cause.',
        '', '## Check', '', '1. The cache TTL: `curl -sI https://www.example.com/ | grep -i age`.',
        '2. A second CDN in front, see [the site](../sites/www.md).', '', '> Ask the customer before purging everything.', '',
      ].join('\n'),
    },
  },
  'kb-team-edge': { name: 'Edge ops', kind: 'team', files: {} },
  // The admin team's: its extraction rules and tech stack apply to every channel.
  'kb-team-admin': { name: 'Admin', kind: 'team', files: {} },
  'kb-org-acme': {
    name: 'acme',
    kind: 'org',
    files: {
      'sites/www.md': '---\ntype: Site\ntitle: www\ndescription: The main website, on Fastly.\n---\n\nGoes live in March.\n',
      'stack.md': stackFile(ACME_STACK, { title: 'Tech stack of ACME', keep: 'status: stable' }),
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
      const invalid = checkChanges(changes, { staff: true });
      return invalid ? { error: invalid } : commitChanges(repos.get(repo).fs, changes, options);
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
