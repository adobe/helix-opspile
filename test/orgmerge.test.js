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
import { beforeEach, describe, it } from 'node:test';
import { api } from '../src/api.js';
import { loadRules } from '../src/lookup.js';
import { consume } from '../src/normalizer.js';
import {
  candidates, forgetFacts, mergeKnowledge, signalsOf,
} from '../src/orgmerge.js';
import {
  classify, matching, mergedOrg, mergeRule,
} from '../src/rules.js';
import { d1 } from './d1.js';
import { fakeBucket, fakeRepo, quiet } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['edge'],
};
const asMe = (p) => ({ ...p, teams: p.teams.map((t) => (typeof t === 'string' ? { slug: t } : t)) });
const RULES = [
  {
    id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^(?:aem|workfront)-(.+)$', value: '$1',
  },
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^(aem|workfront)-', value: 'helix',
  },
];

/** Clef, made up: two ACMEs are one, anything else is not. */
function fakeAI() {
  const asked = [];
  return {
    asked,
    async run(model, input) {
      asked.push(input.state);
      const both = /slug acme,/.test(input.state) && /slug acmeco,/.test(input.state);
      return { answers: { one: { type: 'noul', noul: both ? 0.9 : 0.1 } } };
    },
  };
}

function env() {
  const queued = [];
  const DB = d1({
    rules: RULES,
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  const CHANNELS = fakeBucket();
  const channel = (id, name) => {
    DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', ?, ?, '2026-10-22T00:00:00Z')`).run(id, name);
  };
  const thread = (id, root, org, team, name) => {
    const path = `channels/${org}/${team}/slack-${id}/${root}/`;
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'slack', 'E1', ?, ?, ?, ?, 'channel', ?, ?, '2026-10-22T00:00:00Z',
        '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z', 1, '2026-10-22T00:00:00Z')`)
      .run(`slack:E1:${id}:${root}`, id, root, org, team, name, path);
    CHANNELS.objects.set(`${path}${root}.md`, { body: '---\nid: "1"\n---\nmessage', options: {} });
  };
  const member = (id, user, email) => DB.sqlite.prepare(`INSERT INTO channel_members
      (source, tenant, channel_id, user_id, email) VALUES ('slack', 'E1', ?, ?, ?)`).run(id, user, email);
  channel('C1', 'aem-acme');
  channel('C2', 'workfront-acmeco');
  channel('C3', 'aem-globex');
  thread('C1', '1.1', 'acme', 'helix', 'aem-acme');
  thread('C2', '2.1', 'acmeco', 'helix', 'workfront-acmeco');
  thread('C3', '3.1', 'globex', 'helix', 'aem-globex');
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', NULL, 'customer', NULL, '2026-10-22T00:00:00Z'),
    ('acmeco', 'ACME', 'customer', 'acme.example', '2026-10-22T00:00:00Z')`);
  // Two people of the customer in both, and staff everywhere.
  for (const c of ['C1', 'C2']) {
    member(c, 'U1', 'wile@acme.example');
    member(c, 'U2', 'road@acme.example');
  }
  for (const c of ['C1', 'C2', 'C3']) {
    member(c, 'U9', 'ada@staff.example');
  }
  return {
    queued, DB, CHANNELS, AI: fakeAI(), STAFF_DOMAINS: 'staff.example', NORMALIZE: { send: async (body) => queued.push(body) },
  };
}

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: asMe(me) });
  return { status: res.status, body: await res.json() };
}

async function drain(e) {
  while (e.queued.length) {
    const messages = e.queued.splice(0).map((body) => ({ body, ack() {}, retry() {} }));
    // eslint-disable-next-line no-await-in-loop
    await quiet(() => consume({ messages }, e));
  }
}

beforeEach(() => forgetFacts());

describe('org merges in the rules', () => {
  it('files what the rules give a merged org under the one it was merged into', () => {
    const rules = [...RULES, mergeRule({ slug: 'acmeco', into_slug: 'acme' }, 0),
      mergeRule({ slug: 'acme-old', into_slug: 'acmeco' }, 1)];
    assert.equal(classify(rules, { source: 'slack', name: 'workfront-acmeco' }).org, 'acme');
    assert.equal(classify(rules, { source: 'slack', name: 'aem-acme-old' }).org, 'acme');
    assert.equal(classify(rules, { source: 'slack', name: 'aem-globex' }).org, 'globex');
    assert.equal(matching(rules, { source: 'slack', name: 'aem-acmeco' }, 'org')[0].value, 'acme');
    // A loop ends.
    const loop = [mergeRule({ slug: 'a', into: 'b' }), mergeRule({ slug: 'b', into: 'a' }, 1)];
    assert.ok(['a', 'b'].includes(mergedOrg(loop, 'a')));
  });
});

describe('duplicate candidates', () => {
  const org = (slug, more = {}) => ({
    slug, name: null, type: 'customer', icon: null, domains: [], channels: [], ...more,
  });

  it('says why two orgs may be one', () => {
    const kinds = (a, b, ctx) => signalsOf(a, b, ctx).map((s) => [s.kind, s.weight]);
    assert.deepEqual(kinds(org('acme'), org('acmeco', { name: 'ACME' })), [['name', 3]]);
    assert.deepEqual(kinds(org('initech'), org('initech-labs')), [['name', 2]]);
    assert.deepEqual(kinds(org('umbrellacorp'), org('umbrelacorp')), [['name', 2]]);
    assert.deepEqual(kinds(org('hooli'), org('umbrella')), []);
    assert.deepEqual(kinds(org('nutrasync'), org('nestle-professional-solutions')), []);
    assert.deepEqual(kinds(
      org('x1', { icon: 'acme.example', domains: ['acme.example'] }),
      org('y2', { domains: ['acme.example'] }),
    ), [['icon', 2], ['mail', 3]]);
    const place = (p) => [{ places: [p] }];
    assert.deepEqual(kinds(org('p1', { channels: place('connect:T9') }), org('q2', { channels: place('connect:T9') }), {
      places: new Map([['connect:T9', 2]]),
    }), [['place', 3]]);
    // A domain or a Slack Connect team more orgs share is an agency's: it says less.
    const agency = (slug) => org(slug, { domains: ['agency.example'], channels: place('connect:T8') });
    assert.deepEqual(kinds(agency('p1'), agency('q2'), {
      places: new Map([['connect:T8', 4]]), domains: new Map([['agency.example', 5]]),
    }), [['mail', 1], ['place', 1.5]]);
    const members = { size: new Map([['p1', 3], ['q2', 2]]), shared: new Map([['p1:q2', 2]]) };
    assert.deepEqual(kinds(org('p1'), org('q2'), { members }), [['people', 2]]);
  });

  it('lists the pairs whose signals add up, strongest first', () => {
    const orgs = new Map([
      ['acme', org('acme')], ['acmeco', org('acmeco', { name: 'ACME' })], ['acme-labs', org('acme-labs')],
      ['hooli', org('hooli')],
    ]);
    assert.deepEqual(candidates({ orgs, members: null }).map((c) => [c.a, c.b]), [['acme', 'acmeco']]);
  });

  it('lists a customer with its partner only when their names are alike', () => {
    // The partner's people write from its domain in the customer's channels, on its Slack team.
    const worker = (slug, type) => org(slug, {
      type, domains: ['agency.example'], channels: [{ places: ['connect:T7'] }],
    });
    const orgs = new Map([['globex', worker('globex', 'customer')], ['agency', worker('agency', 'partner')]]);
    assert.deepEqual(candidates({ orgs, members: null }), []);
    // A customer with a name of the partner's is one, perhaps typed wrong.
    orgs.set('agency-emea', worker('agency-emea', 'customer'));
    assert.deepEqual(candidates({ orgs, members: null }).map((c) => [c.a, c.b]), [['agency', 'agency-emea']]);
    // Two customers that share all that are a candidate, as before.
    orgs.delete('agency-emea');
    orgs.set('agency', worker('agency', 'customer'));
    assert.deepEqual(candidates({ orgs, members: null }).map((c) => [c.a, c.b]), [['agency', 'globex']]);
  });

  it('never lists a public org: people of every org meet there', () => {
    const orgs = new Map([
      ['globex', org('globex', { domains: ['globex.example'] })],
      ['globex-community', org('globex-community', { type: 'public', domains: ['globex.example'] })],
    ]);
    assert.deepEqual(candidates({ orgs, members: null }), []);
  });
});

describe('admin: duplicate customers', () => {
  it('keeps the facts across requests, and loads them once for requests that come together', async () => {
    const e = env();
    let loads = 0;
    const prepare = e.DB.prepare.bind(e.DB);
    e.DB.prepare = (sql) => {
      // mailDomains, one of the facts' queries.
      if (sql.includes("COUNT(DISTINCT m.thread || ' ' || m.author_key)")) {
        loads += 1;
      }
      return prepare(sql);
    };
    // Each request wraps the binding anew (src/api.js): the facts are kept by the binding.
    const [a, b] = await Promise.all([
      call(e, ADA, 'GET', '/api/admin/org-duplicates'),
      call(e, ADA, 'GET', '/api/admin/org-duplicates'),
    ]);
    const c = await call(e, ADA, 'GET', '/api/admin/org-duplicates');
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.deepEqual(c.body.pairs.map((p) => [p.a, p.b]), a.body.pairs.map((p) => [p.a, p.b]));
    assert.equal(loads, 1);
    await call(e, ADA, 'GET', '/api/admin/org-duplicates?fresh=1');
    assert.equal(loads, 2);
  });

  it('lists likely duplicates with Clef, and keeps what it said', async () => {
    const e = env();
    const r = await call(e, ADA, 'GET', '/api/admin/org-duplicates');
    assert.equal(r.status, 200);
    const [pair] = r.body.pairs;
    assert.deepEqual([pair.a, pair.b, pair.p], ['acme', 'acmeco', 0.9]);
    assert.deepEqual(pair.signals.map((s) => s.kind), ['name', 'people']);
    assert.equal(r.body.unchecked, 0);
    assert.equal(r.body.orgs.acmeco.name, 'ACME');
    assert.ok(!r.body.pairs.some((p) => p.b === 'globex'));
    // Shown the same, Clef is not asked again.
    const asked = e.AI.asked.length;
    await call(e, ADA, 'GET', '/api/admin/org-duplicates?fresh=1');
    assert.equal(e.AI.asked.length, asked);
    // One pair, whatever its signals.
    const one = await call(e, ADA, 'GET', '/api/admin/org-duplicates?pair=globex:acme');
    assert.deepEqual(one.body.pairs.map((p) => [p.a, p.b, p.p]), [['acme', 'globex', 0.1]]);
  });

  it('lets a team member ask for a merge, and only the admin team merge', async () => {
    const e = env();
    // Bo's team owns both; Cy's neither.
    let r = await call(e, BO, 'GET', '/api/admin/org-duplicates');
    assert.equal(r.body.pairs.length, 1);
    assert.equal(r.body.merges, undefined);
    assert.equal((await call(e, CY, 'GET', '/api/admin/org-duplicates')).body.pairs.length, 0);
    assert.equal((await call(e, CY, 'POST', '/api/admin/org-merge-requests', { from: 'acmeco', into: 'acme' })).status, 403);
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-merge', { from: 'acmeco', into: 'acme' })).status, 403);
    assert.equal((await call(e, BO, 'PUT', '/api/admin/orgs', { slug: 'acme', name: 'Acme' })).status, 403);
    r = await call(e, BO, 'POST', '/api/admin/org-merge-requests', { from: 'acmeco', into: 'acme', note: 'one customer' });
    assert.equal(r.status, 200);
    const { id } = r.body.request;
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-merge-requests', { from: 'acme', into: 'acmeco' })).status, 409);
    // The admin team sees it waiting.
    const requests = await call(e, ADA, 'GET', '/api/admin/requests');
    assert.deepEqual(requests.body.orgMerges.map((x) => [x.id, x.status]), [[id, 'open']]);
    assert.equal(requests.body.open, 1);
    assert.equal((await call(e, CY, 'DELETE', '/api/admin/org-merge-requests', { id })).status, 403);
    r = await call(e, BO, 'DELETE', '/api/admin/org-merge-requests', { id });
    assert.equal(r.body.request.status, 'withdrawn');
    assert.equal((await call(e, BO, 'DELETE', '/api/admin/org-merge-requests', { id })).status, 409);
  });

  it('merges one org into another, its channels and what is set up for it, and undoes it', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO mcp_servers (scope, slug, name, url, updated_at)
      VALUES ('org', 'acmeco', 'tracker', 'https://mcp.example/', '2026-10-22T00:00:00Z')`);
    // A channel filed otherwise than the rules say, for another reason: the merge leaves it.
    e.DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C4', 'aem-hooli', '2026-10-22T00:00:00Z')`);
    e.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        channel_name, path, root_at, last_at, any_at, messages, updated_at)
      VALUES ('slack:E1:C4:4.1', 'slack', 'E1', 'C4', '4.1', 'elsewhere', 'helix', 'channel', 'aem-hooli',
        'channels/elsewhere/helix/slack-C4/4.1/', '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z',
        '2026-10-22T00:00:00Z', 1, '2026-10-22T00:00:00Z')`);
    const asked = await call(e, BO, 'POST', '/api/admin/org-merge-requests', { from: 'acmeco', into: 'acme' });
    let r = await call(e, ADA, 'POST', '/api/admin/org-merge', { from: 'acmeco', into: 'acme', dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moves.map((m) => [m.channel.channelId, m.to.org]), [['C2', 'acme']]);
    assert.deepEqual(r.body.moved, { mcp_servers: 1 });
    assert.equal(e.DB.rows('SELECT * FROM org_merges').length, 0);

    r = await call(e, ADA, 'POST', '/api/admin/org-merge', { from: 'acmeco', into: 'acme' });
    assert.equal(r.status, 200);
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT org, path FROM threads WHERE channel_id = 'C2'"), [
      { org: 'acme', path: 'channels/acme/helix/slack-C2/2.1/' },
    ]);
    // The name and icon fill in the one kept; what was set up for it goes along.
    assert.deepEqual(e.DB.rows("SELECT slug, name, icon FROM orgs WHERE slug LIKE 'acme%'"), [
      { slug: 'acme', name: 'ACME', icon: 'acme.example' },
    ]);
    assert.deepEqual(e.DB.rows('SELECT slug FROM mcp_servers'), [{ slug: 'acme' }]);
    assert.equal(e.DB.rows('SELECT status FROM org_merge_requests WHERE id = ?', asked.body.request.id)[0].status, 'merged');
    // The rules file it there from now on, and the lists know it no more.
    const rules = await loadRules(e);
    assert.equal(classify(rules, { source: 'slack', name: 'workfront-acmeco' }).org, 'acme');
    assert.ok(!(await call(e, ADA, 'GET', '/api/admin/rules')).body.rules.some((x) => x.target === 'merge'));
    const orgs = await call(e, ADA, 'GET', '/api/admin/orgs');
    assert.deepEqual(orgs.body.orgs.map((o) => o.slug), ['acme', 'elsewhere', 'globex']);
    assert.deepEqual((await call(e, ADA, 'GET', '/api/admin/org?slug=acmeco')).body.mergedInto, 'acme');
    assert.deepEqual((await call(e, ADA, 'GET', '/api/admin/org?slug=acme')).body.merged.map((m) => m.slug), ['acmeco']);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/orgs', { name: 'acmeco' })).status, 409);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/org-merge', { from: 'globex', into: 'acmeco' })).status, 409);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/org-duplicates')).body.pairs.length, 0);

    // Undone, its channels go back, and so does its name.
    r = await call(e, ADA, 'DELETE', '/api/admin/org-merge', { slug: 'acmeco' });
    assert.deepEqual(r.body.moves.map((m) => [m.channel.channelId, m.to.org]), [['C2', 'acmeco']]);
    await drain(e);
    assert.equal(e.DB.rows("SELECT org FROM threads WHERE channel_id = 'C2'")[0].org, 'acmeco');
    assert.equal(e.DB.rows("SELECT org FROM threads WHERE channel_id = 'C4'")[0].org, 'elsewhere');
    assert.equal(e.DB.rows("SELECT name FROM orgs WHERE slug = 'acmeco'")[0].name, 'ACME');
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/org-merge', { slug: 'acmeco' })).status, 404);
  });

  it('takes a pair the admin team dismissed off the list', async () => {
    const e = env();
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-duplicates/dismiss', { a: 'acme', b: 'acmeco' })).status, 403);
    await call(e, ADA, 'POST', '/api/admin/org-duplicates/dismiss', { a: 'acmeco', b: 'acme' });
    assert.equal((await call(e, BO, 'GET', '/api/admin/org-duplicates')).body.pairs.length, 0);
    const admin = await call(e, ADA, 'GET', '/api/admin/org-duplicates');
    assert.equal(admin.body.pairs[0].dismissed.by, 'ada@staff.example');
    // Asked for again, it is back.
    await call(e, BO, 'POST', '/api/admin/org-merge-requests', { from: 'acmeco', into: 'acme' });
    assert.equal((await call(e, BO, 'GET', '/api/admin/org-duplicates')).body.pairs.length, 1);
  });
});

describe('merging knowledge bases', () => {
  it('copies the entries the other has not, and keeps the ones both have', async () => {
    const DB = d1();
    DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at, entries) VALUES
      ('kb-org-acmeco', 'org', 'acmeco', 'r', '2026-10-22T00:00:00Z', 3),
      ('kb-org-acme', 'org', 'acme', 'r', '2026-10-22T00:00:00Z', 1)`);
    const repos = {
      'kb-org-acmeco': {
        'index.md': 'i', 'log.md': 'l', 'sites/www.md': 'site', 'contacts/wile-e.md': 'wile', 'customer/profile.md': 'theirs',
      },
      'kb-org-acme': { 'index.md': 'j', 'customer/profile.md': 'ours' },
    };
    const writes = [];
    const e = { DB, ARTIFACTS: { get: async (name) => fakeRepo(repos[name]) } };
    const res = await mergeKnowledge(e, ADA, 'acmeco', 'acme', {
      write: async (env2, repo, changes) => {
        writes.push([repo, changes.map((c) => [c.path, c.content, c.create])]);
        return { commit: 'c1' };
      },
    });
    assert.deepEqual(res, { copied: 2, kept: ['customer/profile.md'] });
    assert.deepEqual(writes, [['kb-org-acme', [['contacts/wile-e.md', 'wile', true], ['sites/www.md', 'site', true]]]]);
  });
});
