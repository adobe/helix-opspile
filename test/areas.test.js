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
import { execFileSync } from 'node:child_process';
import {
  areaFile, areaNames, areasFor, checkArea, compileAreas,
} from '../src/areas.js';
import { storeCatalog } from '../src/catalog.js';
import { syncCatalogs } from '../src/catalogsync.js';
import { checkChanges, writeKnowledge } from '../src/agent/kbwrite.js';
import {
  areaQuestions, areasToAsk, BUILT_IN_AREAS, TOPICS, topicsOf, vocab,
} from '../src/label.js';
import { d1 } from './d1.js';
import { fakeRepo } from './fakes.js';
import { gitServer, hasGit } from './git-server.js';

const CDN = areaFile({ title: 'Caching and delivery', what: 'caching and delivery: purging and cache rules' });
const SEARCH = areaFile({ title: 'Site search', what: 'site search: ranking, indexing and search results' });

const kb = (DB, slug) => DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
  VALUES ('kb-team-${slug}', 'team', '${slug}', 'r', '2026-11-20T00:00:00Z')`);

describe('areas', () => {
  it('are one Area per file under areas/, its title the name, its description what Clef is asked', () => {
    assert.equal(checkArea('areas/cdn.md', CDN), null);
    assert.equal(checkArea('issues/x.md', 'anything'), null);
    assert.match(checkArea('areas/cdn/x.md', CDN), /one Area per file/);
    assert.match(checkArea('areas/Bad_Id.md', CDN), /file name is its id/);
    assert.match(checkArea('areas/cdn.md', CDN.replace('type: Area', 'type: Reference')), /areas only/);
    assert.match(checkArea('areas/cdn.md', CDN.replace(/description: .*\n/, '')), /description/);
    assert.match(checkChanges([{ path: 'areas/x.md', content: CDN.replace('title: Caching and delivery', 'title:') }], { staff: true, kind: 'team' }), /title/);
    // People author them, not agents.
    assert.match(checkChanges([{ path: 'areas/cdn.md', content: CDN }], { kind: 'team' }), /admin team and team managers/);
    assert.equal(checkChanges([{ path: 'areas/cdn.md', content: CDN }], { staff: true, kind: 'team' }), null);
    const rows = compileAreas([
      { path: 'areas/cdn.md', text: CDN },
      { path: 'areas/search.md', text: SEARCH.replace('---\n\n', 'enabled: false\n---\n\n') },
      { path: 'areas/index.md', text: '# index' },
      { path: 'areas/broken.md', text: 'no frontmatter' },
    ]);
    assert.deepEqual(rows.map((r) => [r.id, r.name, r.enabled]), [['cdn', 'Caching and delivery', true], ['search', 'Site search', false]]);
  });

  it('are the built-in list until a team writes any, then every team\'s, each id once', async () => {
    const DB = d1({ teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }] });
    ['admin', 'helix'].forEach((s) => kb(DB, s));
    const env = { DB };
    assert.deepEqual((await areasToAsk(env)).map((a) => a.id), Object.keys(TOPICS));
    assert.equal((await vocab(env)).topics.cdn, 'Caching and delivery');
    await storeCatalog(env, { team: 'admin', repo: 'kb-team-admin' }, {
      rows: [], moves: [], areas: compileAreas([{ path: 'areas/cdn.md', text: CDN }]),
    });
    await storeCatalog(env, { team: 'helix', repo: 'kb-team-helix' }, {
      rows: [],
      moves: [],
      areas: compileAreas([
        { path: 'areas/search.md', text: SEARCH },
        { path: 'areas/cdn.md', text: CDN.replace('Caching and delivery', 'CDN') },
      ]),
    });
    const asked = await areasToAsk(env);
    // The admin team's of an id; the measured order first, the others after.
    assert.deepEqual(asked.map((a) => [a.id, a.name]), [['cdn', 'Caching and delivery'], ['search', 'Site search']]);
    assert.deepEqual(Object.keys(areaQuestions(asked)), ['topic.cdn', 'topic.search']);
    assert.match(areaQuestions(asked)['topic.search'].instructions, /^Is this thread about site search/);
    assert.deepEqual(topicsOf({ 'topic.search': { noul: 0.9 }, 'topic.seo': { noul: 0.9 } }, asked), { search: 0.9 });
    assert.deepEqual(await areaNames(env), { cdn: 'Caching and delivery', search: 'Site search' });
    // The built-in names stay under the teams', for the labels from before.
    assert.equal((await vocab(env)).topics.seo, 'SEO');
    // Turned off by every team that has it, it is not asked.
    DB.sqlite.exec("UPDATE areas SET enabled = 0 WHERE id = 'search'");
    assert.deepEqual((await areasFor(env, { fallback: BUILT_IN_AREAS })).map((a) => a.id), ['cdn']);
  });

  it('are compiled by the cron with the catalog, from the same commit', async () => {
    const DB = d1({ teams: [{ slug: 'admin', name: 'Admin' }] });
    kb(DB, 'admin');
    const repos = { 'kb-team-admin': { 'areas/cdn.md': CDN, 'areas/search.md': SEARCH, 'issues/a.md': 'x' } };
    const env = { DB, ARTIFACTS: { get: async (name) => fakeRepo(repos[name]) } };
    assert.deepEqual(await syncCatalogs(env), { compiled: ['admin'], failed: 0 });
    assert.deepEqual(DB.rows('SELECT id FROM areas ORDER BY id'), [{ id: 'cdn' }, { id: 'search' }]);
    assert.deepEqual(await syncCatalogs(env), { compiled: [], failed: 0 });
    repos['kb-team-admin'] = { 'issues/a.md': 'x' };
    assert.deepEqual(await syncCatalogs(env), { compiled: ['admin'], failed: 0 });
    assert.deepEqual(DB.rows('SELECT id FROM areas'), []);
  });
});

describe('the areas bootstrap', () => {
  it('writes the built-in areas as files that compile back to the same questions', () => {
    const out = execFileSync(process.execPath, [new URL('../scripts/areas-bootstrap.mjs', import.meta.url).pathname], { encoding: 'utf8' });
    const rows = compileAreas(JSON.parse(out).map((c) => ({ path: c.path, text: c.content })));
    const byId = (x, y) => x.id.localeCompare(y.id);
    const got = rows.map((r) => ({ id: r.id, name: r.name, what: r.what })).sort(byId);
    assert.deepEqual(got, [...BUILT_IN_AREAS].sort(byId));
  });
});

describe('a write of a team\'s areas', { skip: !hasGit() && 'git is not installed' }, () => {
  it('compiles them', async () => {
    const srv = await gitServer();
    try {
      srv.create('kb-team-admin');
      const DB = d1({ teams: [{ slug: 'admin', name: 'Admin' }] });
      kb(DB, 'admin');
      const env = { DB, ARTIFACTS: srv.artifacts };
      await writeKnowledge(env, 'kb-team-admin', [{ path: 'areas/search.md', content: SEARCH }], {
        message: 'm', by: 'human:ada@staff.example', at: '2026-11-20T10:00:00.000Z', logEntry: 'e', staff: true,
      });
      assert.deepEqual(DB.rows('SELECT team, id, name, changed_by FROM areas'), [
        {
          team: 'admin', id: 'search', name: 'Site search', changed_by: 'ada@staff.example',
        },
      ]);
    } finally {
      await srv.close();
    }
  });
});
