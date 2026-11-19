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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import git from 'isomorphic-git';
import {
  catalogId, checkCatalog, compileCatalog, movesOf, resolveTech, storeCatalog, techMoves,
  withMovedFrom,
} from '../src/catalog.js';
import { syncCatalogs } from '../src/catalogsync.js';
import {
  deleteTech, saveTech, techFor, techNames,
} from '../src/extract.js';
import { checkChanges, commitChanges, writeKnowledge } from '../src/agent/kbwrite.js';
import { checkLayout } from '../src/agent/okf.js';
import { memfs } from '../src/agent/memfs.js';
import { isTechId, questionKeys } from '../src/techid.js';
import { techOf, techQuestions } from '../src/label.js';
import { parseStack } from '../src/stack.js';
import { d1 } from './d1.js';
import { fakeRepo } from './fakes.js';
import { gitServer, hasGit } from './git-server.js';

const concept = (fields, body = 'What it is.\n') => `---\n${Object.entries(fields)
  .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n\n${body}`;

const ADOBE = concept({ type: 'Vendor', title: 'Adobe' });
const SITES = concept({ type: 'Product', title: 'Experience Manager Sites', description: 'Adobe Experience Manager Sites' });
const EDS = concept({
  type: 'Feature',
  title: 'Edge Delivery',
  description: 'Adobe Edge Delivery Services (aem.live, aem.page)',
  aliases: ['EDS', 'Franklin', 'eds'],
  layer: 'site',
  moved_from: ['eds'],
});
const SIDEKICK = concept({
  type: 'Feature', title: 'AEM Sidekick', description: 'the AEM Sidekick', layer: 'content',
});
const WORKFRONT = concept({ type: 'Product', title: 'Workfront', description: 'Adobe Workfront' });
const FASTLY = concept({
  type: 'Product', title: 'Fastly', description: 'Fastly as CDN', layer: 'edge', moved_from: ['fastly'],
});
const CONSENT = concept({
  type: 'Category', title: 'Consent manager', description: 'a consent manager', layer: 'martech',
});

const FILES = {
  'products/adobe.md': ADOBE,
  'products/adobe/aem-sites.md': SITES,
  'products/adobe/aem-sites/edge-delivery.md': EDS,
  'products/adobe/aem-sites/sidekick.md': SIDEKICK,
  'products/adobe/workfront.md': WORKFRONT,
  'products/fastly/cdn.md': FASTLY,
  'products/categories/consent-manager.md': CONSENT,
};
const files = (map = FILES) => Object.entries(map).map(([path, text]) => ({ path, text }));

describe('the catalog\'s files', () => {
  it('are a Vendor, Product, Feature or Category where their type goes', () => {
    assert.equal(checkCatalog('issues/x.md', 'anything'), null);
    for (const [path, text] of Object.entries(FILES)) {
      assert.equal(checkCatalog(path, text), null, path);
    }
    assert.match(checkCatalog('products/adobe/aem-sites.md', EDS), /a Feature goes at products\/<vendor>\/<product>\/<feature>\.md/);
    assert.match(checkCatalog('products/categories/consent/x.md', CONSENT), /a Category goes at/);
    assert.match(checkCatalog('products/notes.md', concept({ type: 'Reference', title: 'x' })), /catalog only/);
    assert.match(checkCatalog('products/fastly/cdn.md', concept({ type: 'Product', title: 'Fastly' })), /description/);
    assert.match(checkCatalog('products/fastly/cdn.md', FASTLY.replace('layer: edge', 'layer: cdn')), /layer is one of/);
    assert.match(checkCatalog('products/fastly/cdn.md', FASTLY.replace('[fastly]', '[Not An Id]')), /moved_from/);
    assert.equal(catalogId('products/adobe/aem-sites/edge-delivery.md'), 'adobe/aem-sites/edge-delivery');
    assert.equal(catalogId('products/adobe/index.md'), null);
    assert.ok(isTechId('adobe/aem-sites/edge-delivery') && isTechId('eds') && !isTechId('adobe'.repeat(40)));
  });

  it('go in a team\'s knowledge base, and a write is held to them, people\'s too', () => {
    assert.match(checkLayout('products/fastly/cdn.md', FASTLY, 'org'), /kb-team/);
    assert.equal(checkLayout('products/fastly/cdn.md', FASTLY, 'team'), null);
    const bad = [{ path: 'products/fastly/cdn.md', content: concept({ type: 'Product', title: 'Fastly' }) }];
    assert.match(checkChanges(bad, { staff: true, kind: 'team' }), /description/);
    assert.equal(checkChanges(bad, { staff: true, kind: 'org' }), null);
  });

  it('compile into technologies: features of their product, products of their vendor', () => {
    const { rows, moves, skipped } = compileCatalog([...files(), { path: 'products/x/y.md', text: 'no frontmatter' }]);
    assert.deepEqual(skipped, ['products/x/y.md']);
    // A product with features only groups them: it is not asked.
    assert.deepEqual(rows.map((r) => r.tech), [
      'adobe/aem-sites/edge-delivery', 'adobe/aem-sites/sidekick', 'adobe/workfront', 'categories/consent-manager', 'fastly/cdn',
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.tech, r]));
    assert.deepEqual(
      ['name', 'product', 'vendor', 'kind', 'layer', 'portal', 'aliases'].map((k) => by['adobe/aem-sites/edge-delivery'][k]),
      ['Edge Delivery', 'Experience Manager Sites', 'Adobe', 'Feature', 'site', true, 'EDS, Franklin'],
    );
    assert.deepEqual([by['adobe/workfront'].product, by['adobe/workfront'].portal], ['Workfront', true]);
    assert.deepEqual([by['fastly/cdn'].product, by['fastly/cdn'].vendor, by['fastly/cdn'].portal], ['Fastly', 'Fastly', false]);
    assert.deepEqual([by['categories/consent-manager'].product, by['categories/consent-manager'].vendor], ['Consent manager', null]);
    assert.deepEqual(moves, [
      { old: 'eds', tech: 'adobe/aem-sites/edge-delivery' }, { old: 'fastly', tech: 'fastly/cdn' },
    ]);
    // Asked for, a product with features is asked too; turned off, its features are off.
    const asked = compileCatalog(files({
      ...FILES, 'products/adobe/aem-sites.md': SITES.replace('type: Product', 'type: Product\nasked: true\nenabled: false'),
    })).rows;
    assert.equal(asked.find((r) => r.tech === 'adobe/aem-sites').enabled, false);
    assert.equal(asked.find((r) => r.tech === 'adobe/aem-sites/sidekick').enabled, false);
  });
});

describe('a compiled catalog', () => {
  const kb = (DB, slug) => DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
    VALUES ('kb-team-${slug}', 'team', '${slug}', 'r', '2026-11-19T00:00:00Z')`);

  it('replaces the D1 rows its moves name, and rewrites what D1 keeps under their ids once', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }] });
    kb(DB, 'helix');
    DB.sqlite.exec(`INSERT INTO team_follows (team, tech, added_at) VALUES ('helix', 'eds', 'x');
      INSERT INTO thread_tech (thread, tech, p) VALUES ('t1', 'eds', 0.9), ('t1', 'akamai', 1);
      INSERT INTO portal_requests (portal, domain, tech, requested_at) VALUES ('p', 'acme.example', '["eds","da"]', 'x')`);
    const env = { DB };
    const r = await storeCatalog(env, { team: 'helix', repo: 'kb-team-helix', commit: 'c1' }, compileCatalog(files()));
    assert.deepEqual(r, { rows: 5, moves: 2, rewritten: 2 });
    assert.deepEqual(DB.rows("SELECT team, tech FROM tech_stack WHERE tech IN ('eds', 'fastly')"), []);
    assert.deepEqual(DB.rows('SELECT tech FROM team_follows'), [{ tech: 'adobe/aem-sites/edge-delivery' }]);
    assert.deepEqual(DB.rows('SELECT tech FROM thread_tech ORDER BY tech'), [{ tech: 'adobe/aem-sites/edge-delivery' }, { tech: 'akamai' }]);
    assert.deepEqual(JSON.parse(DB.rows('SELECT tech FROM portal_requests')[0].tech), ['adobe/aem-sites/edge-delivery', 'da']);
    assert.equal(DB.rows("SELECT field FROM extraction_rules WHERE target = 'tech' AND name = 'Edge Delivery hostname'")[0].field, 'adobe/aem-sites/edge-delivery');
    assert.equal(DB.rows("SELECT catalog_commit FROM knowledge_bases WHERE repo = 'kb-team-helix'")[0].catalog_commit, 'c1');
    // Moves are read through, and labels from before still have a name.
    assert.equal(resolveTech('eds', await techMoves(env)), 'adobe/aem-sites/edge-delivery');
    assert.equal((await techNames(env)).eds, 'Edge Delivery');
    // A stack drawing from before names a part by its old id: it is the technology now.
    const drawing = parseStack('## Parts\n\n| Layer | Part | Tech |\n| --- | --- | --- |\n| site | Site | eds |\n| commerce | Their PIM | own |\n');
    assert.equal(resolveTech(drawing.parts[0].tech, await techMoves(env)), 'adobe/aem-sites/edge-delivery');
    assert.equal(drawing.parts[1].tech, 'own');
    // Compiled again, nothing new moved: nothing is rewritten.
    DB.sqlite.exec("INSERT INTO team_follows (team, tech, added_at) VALUES ('helix', 'eds', 'later')");
    assert.equal((await storeCatalog(env, { team: 'helix', repo: 'kb-team-helix' }, compileCatalog(files()))).rewritten, 0);
    assert.equal(DB.rows("SELECT COUNT(*) AS n FROM team_follows WHERE tech = 'eds'")[0].n, 1);
  });

  it('is changed in its file, not in D1', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'cdn', name: 'CDN' }] });
    kb(DB, 'helix');
    const env = { DB };
    await storeCatalog(env, { team: 'helix', repo: 'kb-team-helix' }, compileCatalog(files()));
    assert.match((await saveTech(env, 'helix', { tech: 'fastly/cdn', name: 'X' }, 'Bo')).error, /kb-team-helix at products\/fastly\/cdn\.md/);
    assert.match((await deleteTech(env, 'helix', 'fastly/cdn')).error, /change that file/);
  });

  it('is asked as the union: a team\'s own file of a path in its channels, else the admin team\'s, with every alias', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'cdn', name: 'CDN' }, { slug: 'admin', name: 'Admin' }] });
    ['helix', 'cdn', 'admin'].forEach((s) => kb(DB, s));
    const env = { DB };
    await storeCatalog(env, { team: 'cdn', repo: 'kb-team-cdn' }, compileCatalog(files({ 'products/fastly/cdn.md': FASTLY })));
    await storeCatalog(env, { team: 'admin', repo: 'kb-team-admin' }, compileCatalog(files({
      'products/fastly/cdn.md': FASTLY.replace('Fastly as CDN', 'Fastly as CDN, in front of the site').replace('layer: edge', 'layer: edge\naliases: [Compute@Edge]'),
    })));
    await storeCatalog(env, { team: 'helix', repo: 'kb-team-helix' }, compileCatalog(files({
      'products/fastly/cdn.md': FASTLY.replace('type: Product', 'type: Product\nenabled: false'),
    })));
    const of = async (team) => (await techFor(env, team)).find((t) => t.tech === 'fastly/cdn');
    assert.equal((await of('cdn')).description, 'Fastly as CDN');
    assert.equal((await of('edge')).description, 'Fastly as CDN, in front of the site');
    assert.equal((await of('edge')).aliases, 'Compute@Edge');
    assert.equal(await of('helix'), undefined);
    // Every team's technology is asked everywhere: the one D1 row of a team too.
    await saveTech(env, 'cdn', { tech: 'stats', name: 'Stats', description: 'a stats tool' }, 'Bo');
    assert.ok((await techFor(env, 'helix')).some((t) => t.tech === 'stats'));
  });

  it('is compiled again by the cron when the knowledge base moved on, and dropped with products/', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }] });
    kb(DB, 'helix');
    const repos = { 'kb-team-helix': { ...FILES, 'index.md': 'x', 'issues/a.md': 'y' } };
    const env = { DB, ARTIFACTS: { get: async (name) => fakeRepo(repos[name]) } };
    assert.deepEqual(await syncCatalogs(env), { compiled: ['helix'], failed: 0 });
    assert.equal(DB.rows("SELECT COUNT(*) AS n FROM tech_stack WHERE team = 'helix' AND path IS NOT NULL")[0].n, 5);
    assert.deepEqual(await syncCatalogs(env), { compiled: [], failed: 0 });
    repos['kb-team-helix'] = { 'issues/a.md': 'y' };
    assert.deepEqual(await syncCatalogs(env), { compiled: ['helix'], failed: 0 });
    assert.equal(DB.rows("SELECT COUNT(*) AS n FROM tech_stack WHERE team = 'helix' AND path IS NOT NULL")[0].n, 0);
    assert.deepEqual(await syncCatalogs(env), { compiled: [], failed: 0 });
  });
});

describe('a move of a catalog file', () => {
  it('keeps the ids the file had', async () => {
    assert.match(withMovedFrom(FASTLY, ['fastly', 'akamai/x']), /moved_from: \[fastly, akamai\/x\]/);
    const pairs = await movesOf([
      { path: 'products/fastly/cdn.md', delete: true },
      { path: 'products/fastly/delivery.md', content: FASTLY },
    ], { old: async () => FASTLY, present: async () => false });
    assert.deepEqual(pairs, [{ from: 'products/fastly/cdn.md', to: 'products/fastly/delivery.md', ids: ['fastly/cdn', 'fastly'] }]);
  });

  it('is a delete and a write in one commit of a team\'s knowledge base', async () => {
    const fs = memfs();
    await fs.mkdirp('/kb');
    await git.init({ fs, dir: '/kb', defaultBranch: 'main' });
    const opts = {
      message: 'm', by: 'opspile-agent/m', at: '2026-11-19T10:00:00.000Z', logEntry: 'e', catalog: true,
    };
    await commitChanges(fs, [{ path: 'products/fastly/cdn.md', content: FASTLY }], opts);
    await commitChanges(fs, [
      { path: 'products/fastly/cdn.md', delete: true },
      { path: 'products/fastly/edge.md', content: FASTLY.replace('title: Fastly', 'title: Fastly Compute') },
    ], opts);
    const moved = await fs.promises.readFile('/kb/products/fastly/edge.md', 'utf8');
    assert.match(moved, /moved_from: \[fastly, fastly\/cdn\]/);
    assert.deepEqual(compileCatalog([{ path: 'products/fastly/edge.md', text: moved }]).moves, [
      { old: 'fastly', tech: 'fastly/edge' }, { old: 'fastly/cdn', tech: 'fastly/edge' },
    ]);
  });
});

describe('Clef\'s questions about technologies', () => {
  it('are keyed by a hash of the id, and mapped back', () => {
    const tech = [{ tech: 'adobe/aem-sites/edge-delivery', description: 'Edge Delivery' }, { tech: 'eds', description: 'x' }];
    const keys = Object.keys(techQuestions(tech));
    assert.equal(keys.length, 2);
    assert.ok(keys.every((k) => /^tech\.[0-9a-f]{8}$/.test(k)));
    assert.deepEqual(questionKeys(['eds']), questionKeys(['eds']));
    const answers = { [keys[0]]: { noul: 0.91 }, [keys[1]]: { noul: 0.2 } };
    assert.deepEqual(techOf(tech, answers, []), { 'adobe/aem-sites/edge-delivery': 0.91 });
  });
});

describe('a write of a team\'s catalog', { skip: !hasGit() && 'git is not installed' }, () => {
  it('compiles it, from what was pushed', async () => {
    const srv = await gitServer();
    try {
      srv.create('kb-team-helix');
      const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }] });
      DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
        VALUES ('kb-team-helix', 'team', 'helix', 'r', '2026-11-19T00:00:00Z')`);
      const env = { DB, ARTIFACTS: srv.artifacts };
      const opts = {
        message: 'm', by: 'opspile-agent/m', at: '2026-11-19T10:00:00.000Z', logEntry: 'e',
      };
      const r = await writeKnowledge(env, 'kb-team-helix', [{ path: 'products/fastly/cdn.md', content: FASTLY }], opts);
      assert.deepEqual(DB.rows("SELECT tech, path, changed_by FROM tech_stack WHERE team = 'helix'"), [
        { tech: 'fastly/cdn', path: 'products/fastly/cdn.md', changed_by: 'opspile-agent/m' },
      ]);
      assert.equal(DB.rows("SELECT catalog_commit FROM knowledge_bases WHERE repo = 'kb-team-helix'")[0].catalog_commit, r.commit);
      assert.deepEqual(DB.rows("SELECT tech FROM tech_stack WHERE tech = 'fastly'"), []);
    } finally {
      await srv.close();
    }
  });
});
