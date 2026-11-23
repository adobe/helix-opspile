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
import { api, searchInbox } from '../src/api.js';
import {
  conceptOf, conceptVectorId, embedConcepts, isConcept, MAX_BODY, syncConcepts,
} from '../src/kbindex.js';
import { kbFilters } from '../src/kbsearch.js';
import { QUERY_PREFIX } from '../src/search.js';
import { d1 } from './d1.js';
import { fakeRepo } from './fakes.js';

// Made-up teams, customers, people and texts only.
const AT = '2026-10-22T10:00:00.000Z';
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
};
const me = { ...ADA, teams: [{ slug: 'helix', name: 'Helix' }] };
// Signed in without a team (SIGNIN_DOMAINS): the personal view only.
const NOBODY = {
  id: 2, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: [],
};

const concept = (fields, body) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}\n`;

const FILES = {
  'kb-team-helix': {
    'index.md': '# Index',
    'log.md': '# Log',
    'systemprompt.md': concept({ type: 'System Prompt', title: 'Agent instructions' }, 'Purge with care.'),
    'playbooks/cdn-purge.md': concept({
      type: 'Playbook', title: 'CDN purge takes long', description: '"What to check when a purge is slow."', tags: '[cdn, cache]',
    }, '# CDN purge takes long\n\nCheck the **TTL** first, then a second CDN in front.'),
    'reference/redirects.md': concept({ type: 'Reference', title: 'Redirects' }, 'The redirects sheet; a purge after each change.'),
    'reference/delivery.dot': 'digraph { purge -> cdn }',
  },
  'kb-team-edge': {
    'playbooks/purge.md': concept({ type: 'Playbook', title: 'Purge everything' }, 'Edge only.'),
  },
  'kb-org-acme': {
    'sites/www.md': concept({
      type: 'Site', title: 'www', description: 'The main website, on a CDN.', aliases: '[acme.example]',
    }, 'Goes live in March; purge the CDN after go-live.'),
    'contacts/sam-reyes.md': concept({ type: 'Contact', title: 'Sam Reyes', description: 'Web lead.' }, 'Signs off on CDN changes.'),
  },
  'kb-org-umbrella': {
    'sites/www.md': concept({ type: 'Site', title: 'Umbrella www' }, 'Purge by hand.'),
  },
  'kb-org-oldco': {
    'sites/old.md': concept({ type: 'Site', title: 'Old purge' }, 'Merged away.'),
  },
};

function setup() {
  const DB = d1({
    people: [ADA, NOBODY],
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }],
  });
  const thread = (key, channel, org, team) => DB.sqlite.prepare(`INSERT INTO threads (thread,
      source, tenant, channel_id, root_id, org, team, kind, channel_name, title, path, root_at,
      last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, '1.1', ?, ?, 'channel', ?, 'Hello', 'p/', ?, ?, ?, 1, ?)`)
    .run(key, channel, org, team, `aem-${org}`, AT, AT, AT, AT);
  // Helix owns ACME (and oldco, merged into ACME); Edge owns Umbrella.
  thread('slack:E1:C1:1.1', 'C1', 'acme', 'helix');
  thread('slack:E1:C2:1.1', 'C2', 'oldco', 'helix');
  thread('slack:E1:C3:1.1', 'C3', 'umbrella', 'edge');
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('acme', 'ACME Inc', 'customer', '${AT}')`);
  DB.sqlite.exec(`INSERT INTO org_merges (slug, into_slug, merged_at) VALUES ('oldco', 'acme', '${AT}')`);
  for (const repo of Object.keys(FILES)) {
    const [, kind, slug] = /^kb-(team|org)-(.+)$/.exec(repo);
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
      VALUES (?, ?, ?, 'r', ?)`).run(repo, kind, slug, AT);
  }
  const files = structuredClone(FILES);
  const read = [];
  const env = {
    DB,
    ARTIFACTS: {
      async get(name) {
        const repo = fakeRepo(files[name] || {});
        const { readBlob } = repo;
        repo.readBlob = async (hash) => {
          read.push(name);
          return readBlob(hash);
        };
        return repo;
      },
    },
  };
  return {
    env, files, read, DB,
  };
}

/** A CONTENT and AI in memory: the query's vector is [1, 0]; `matches` answers per filter. */
function withVectors(env) {
  Object.assign(env, {
    asked: [],
    filters: [],
    matches: {},
    upserted: [],
    deleted: [],
    AI: {
      async run(model, { text }) {
        env.asked.push(...text);
        return { data: text.map(() => [1, 0]) };
      },
    },
    CONTENT: {
      async query(vector, options) {
        env.filters.push(options.filter);
        return { matches: env.matches[JSON.stringify(options.filter)] || [] };
      },
      async upsert(items) {
        env.upserted.push(...items);
      },
      async deleteByIds(ids) {
        env.deleted.push(...ids);
      },
    },
  });
  return env;
}

describe('knowledge search: the concepts', () => {
  it('keeps the frontmatter and the body of a markdown entry', () => {
    assert.equal(isConcept('playbooks/a.md'), true);
    assert.equal(isConcept('index.md'), false);
    assert.equal(isConcept('a/log.md'), false);
    assert.equal(isConcept('systemprompt.md'), false);
    assert.equal(isConcept('reference/delivery.dot'), false);
    assert.deepEqual(conceptOf('playbooks/cdn-purge.md', FILES['kb-team-helix']['playbooks/cdn-purge.md']), {
      type: 'Playbook',
      title: 'CDN purge takes long',
      description: 'What to check when a purge is slow.',
      tags: 'cdn, cache',
      aliases: null,
      body: '# CDN purge takes long\n\nCheck the **TTL** first, then a second CDN in front.',
    });
    // No frontmatter title: the first heading, else the file name; the body is cut.
    assert.equal(conceptOf('a/b.md', '# Heading\n\ntext').title, 'Heading');
    assert.equal(conceptOf('a/b-c.md', 'text').title, 'b-c');
    assert.equal(conceptOf('a/b.md', 'x'.repeat(MAX_BODY + 10)).body.length, MAX_BODY);
    assert.equal(conceptOf('index.md', '# x'), null);
  });

  it('reads every knowledge base once, then only what changed', async () => {
    const {
      env, files, read, DB,
    } = setup();
    assert.deepEqual(await syncConcepts(env), { read: 5, failed: 0, embedded: 0 });
    assert.deepEqual(DB.rows('SELECT repo, path FROM kb_concepts ORDER BY repo, path'), [
      { repo: 'kb-org-acme', path: 'contacts/sam-reyes.md' },
      { repo: 'kb-org-acme', path: 'sites/www.md' },
      { repo: 'kb-org-oldco', path: 'sites/old.md' },
      { repo: 'kb-org-umbrella', path: 'sites/www.md' },
      { repo: 'kb-team-edge', path: 'playbooks/purge.md' },
      { repo: 'kb-team-helix', path: 'playbooks/cdn-purge.md' },
      { repo: 'kb-team-helix', path: 'reference/redirects.md' },
    ]);
    assert.ok(DB.rows('SELECT search_commit FROM knowledge_bases').every((r) => r.search_commit));
    // Nothing to read on the next run.
    read.length = 0;
    assert.deepEqual(await syncConcepts(env), { read: 0, failed: 0, embedded: 0 });
    assert.deepEqual(read, []);
    // Read again in full (after a write's update failed): only the changed blob is read, and the
    // row of a file that is gone goes.
    files['kb-team-helix']['reference/redirects.md'] = concept({ type: 'Reference', title: 'Redirects sheet' }, 'Moved.');
    delete files['kb-team-helix']['playbooks/cdn-purge.md'];
    DB.sqlite.exec("UPDATE knowledge_bases SET search_commit = NULL WHERE repo = 'kb-team-helix'");
    assert.deepEqual(await syncConcepts(env), { read: 1, failed: 0, embedded: 0 });
    assert.deepEqual(read, ['kb-team-helix']);
    assert.deepEqual(DB.rows("SELECT path, title FROM kb_concepts WHERE repo = 'kb-team-helix'"), [
      { path: 'reference/redirects.md', title: 'Redirects sheet' },
    ]);
  });

  it('makes the vectors of the concepts that have none, and again after a change', async () => {
    const { env, DB } = setup();
    withVectors(env);
    assert.deepEqual(await syncConcepts(env), { read: 5, failed: 0, embedded: 7 });
    const www = env.upserted.find((v) => v.metadata.repo === 'kb-org-acme' && v.metadata.path === 'sites/www.md');
    assert.deepEqual(www, {
      id: await conceptVectorId('kb-org-acme', 'sites/www.md'),
      values: [1, 0],
      metadata: {
        type: 'kb', org: 'acme', repo: 'kb-org-acme', path: 'sites/www.md',
      },
    });
    assert.equal(env.upserted.find((v) => v.metadata.repo === 'kb-team-helix').metadata.team, 'helix');
    assert.ok(env.asked.some((t) => t.startsWith('www acme.example Site The main website')));
    assert.deepEqual(await embedConcepts(env), { embedded: 0 });
    // A new blob loses the mark; the same one keeps it.
    DB.sqlite.exec("UPDATE kb_concepts SET hash = 'other' WHERE repo = 'kb-org-acme' AND path = 'sites/www.md'");
    DB.sqlite.exec("UPDATE knowledge_bases SET search_commit = NULL WHERE repo = 'kb-org-acme'");
    assert.deepEqual(await syncConcepts(env), { read: 1, failed: 0, embedded: 1 });
  });
});

describe('knowledge search: the inbox', () => {
  it('finds the concepts of the team and the customers it owns, by their words', async () => {
    const { env } = setup();
    await syncConcepts(env);
    let r = await searchInbox(env, me, 'helix', 'purge');
    // Not edge's, not Umbrella's (edge owns it), not a merged customer's, not the system prompt.
    assert.deepEqual(r.kb.map((k) => [k.repo, k.path, k.matched, k.score]), [
      // Its heading is its title: not a word in its text.
      ['kb-team-helix', 'playbooks/cdn-purge.md', ['title', 'description'], 1.5],
      // As good as each other: by title.
      ['kb-team-helix', 'reference/redirects.md', ['text'], 0.4],
      ['kb-org-acme', 'sites/www.md', ['text'], 0.4],
    ]);
    assert.deepEqual(r.kb[2], {
      repo: 'kb-org-acme',
      kind: 'org',
      slug: 'acme',
      name: 'ACME Inc',
      path: 'sites/www.md',
      type: 'Site',
      title: 'www',
      description: 'The main website, on a CDN.',
      score: 0.4,
      matched: ['text'],
      snippet: 'Goes live in March; purge the CDN after go-live.',
    });
    assert.deepEqual([r.hits, r.threads], [[], []]);
    // Every word somewhere: tags and aliases count.
    r = await searchInbox(env, me, 'helix', 'cache ttl');
    assert.deepEqual(r.kb.map((k) => [k.path, k.matched]), [['playbooks/cdn-purge.md', ['tags', 'text']]]);
    r = await searchInbox(env, me, 'helix', 'acme.example');
    assert.deepEqual(r.kb.map((k) => [k.path, k.matched]), [['sites/www.md', ['title']]]);
    assert.deepEqual((await searchInbox(env, me, 'helix', 'purge nowhere')).kb, []);
    // The personal view: the knowledge bases of my teams.
    r = await searchInbox(env, me, null, 'purge', { personal: true });
    assert.equal(r.kb.length, 3);
  });

  it('shows nobody on a team any knowledge base', async () => {
    const { env } = setup();
    await syncConcepts(env);
    const r = await searchInbox(env, NOBODY, null, 'purge', { personal: true });
    assert.deepEqual(r.kb, []);
    // Nor through the route.
    const url = new URL('https://opspile.example/api/search?view=personal&q=purge');
    const res = await api(new Request(url), env, url, { viewer: NOBODY });
    assert.deepEqual((await res.json()).kb, []);
  });

  it('finds concepts by meaning, with one vector of the query for threads and concepts', async () => {
    const { env } = setup();
    withVectors(env);
    await syncConcepts(env);
    env.asked.length = 0;
    const vector = (repo, path, score) => ({
      id: `${repo}|${path}`,
      score,
      metadata: {
        type: 'kb', repo, path,
      },
    });
    env.matches[JSON.stringify({ type: 'kb', team: 'helix' })] = [
      vector('kb-team-helix', 'reference/redirects.md', 0.8),
      // A vector left behind by a file that is gone finds nothing.
      vector('kb-team-helix', 'gone.md', 0.79),
    ];
    env.matches[JSON.stringify({ type: 'kb', org: 'acme' })] = [
      vector('kb-org-acme', 'contacts/sam-reyes.md', 0.75),
      // Not a knowledge base searched here, whatever the index says.
      vector('kb-org-umbrella', 'sites/www.md', 0.9),
    ];
    const r = await searchInbox(env, me, 'helix', 'who approves dns changes');
    assert.deepEqual(env.asked, [`${QUERY_PREFIX}who approves dns changes`]);
    assert.ok(env.filters.some((f) => f.type === 'kb' && f.team === 'helix'));
    assert.ok(env.filters.some((f) => f.type && f.type.$in));
    assert.deepEqual(r.kb.map((k) => [k.path, k.matched, k.score, k.snippet]), [
      ['reference/redirects.md', ['topic'], 0.8, 'The redirects sheet; a purge after each change.'],
      ['contacts/sam-reyes.md', ['topic'], 0.75, null],
    ]);
  });

  it('asks the vectors for the teams at once and the customers in parts', () => {
    assert.deepEqual(kbFilters([{ kind: 'team', slug: 'helix' }, { kind: 'org', slug: 'acme' }]), [
      { type: 'kb', team: 'helix' }, { type: 'kb', org: 'acme' },
    ]);
    const orgs = Array.from({ length: 200 }, (_, i) => ({ kind: 'org', slug: `customer-${'x'.repeat(20)}-${i}` }));
    const filters = kbFilters([{ kind: 'team', slug: 'helix' }, { kind: 'team', slug: 'edge' }, ...orgs]);
    assert.deepEqual(filters[0], { type: 'kb', team: { $in: ['helix', 'edge'] } });
    assert.ok(filters.length > 2);
    assert.deepEqual(filters.slice(1).flatMap((f) => f.org.$in), orgs.map((o) => o.slug));
    filters.forEach((f) => assert.ok(JSON.stringify(f).length <= 2048));
  });
});

describe('knowledge search: a write during a full read', () => {
  it('is not undone by the read', async () => {
    const { env, files, DB } = setup();
    await syncConcepts(env);
    // The read sees the tree from before the write; the write's rows land in between.
    files['kb-team-helix']['reference/redirects.md'] = concept({ type: 'Reference', title: 'Old' }, 'x');
    delete files['kb-team-helix']['playbooks/cdn-purge.md'];
    DB.sqlite.exec("UPDATE knowledge_bases SET search_commit = NULL WHERE repo = 'kb-team-helix'");
    const { get } = env.ARTIFACTS;
    env.ARTIFACTS.get = async (name) => {
      DB.sqlite.exec(`UPDATE kb_concepts SET hash = 'w', title = 'Written'
        WHERE repo = 'kb-team-helix'`);
      return get(name);
    };
    assert.deepEqual(await syncConcepts(env), { read: 1, failed: 0, embedded: 0 });
    assert.deepEqual(DB.rows("SELECT path, title FROM kb_concepts WHERE repo = 'kb-team-helix' ORDER BY path"), [
      { path: 'playbooks/cdn-purge.md', title: 'Written' },
      { path: 'reference/redirects.md', title: 'Written' },
    ]);
  });
});
