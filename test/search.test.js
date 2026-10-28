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
import { api, inbox, searchInbox } from '../src/api.js';
import { render } from '../src/channels.js';
import { refile } from '../src/refile.js';
import { messageVectorId, threadVectorId, vectorizeThread } from '../src/vectors.js';
import {
  MIN_SIMILAR, QUERY_PREFIX, snippet, terms, vectorFilters,
} from '../src/search.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up teams, channels, people and texts only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
};
const me = { ...ADA, teams: [{ slug: 'helix', name: 'Helix' }] };
const AT = '2026-10-22T10:00:00.000Z';
const later = (minutes) => new Date(Date.parse(AT) + minutes * 60000).toISOString();

/**
 * Threads of two teams: helix's own channel C1 (Slack) and C2 (Teams), and edge's C3 (shared
 * with helix) and C4 (not). The vectors answer with what `matches` says for each filter.
 */
function setup() {
  const DB = d1({
    people: [ADA],
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }],
  });
  const CHANNELS = fakeBucket();
  const thread = ({
    key, source = 'slack', tenant = 'E1', channel, root, org = 'acme', team = 'helix', title,
    minutes = 0, logical = null, kind = 'channel',
  }) => {
    const path = `channels/${org}/${team}/${source}-${channel}/${root}/`;
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, title, path, root_at, last_at, any_at, messages, logical_thread,
        updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(
        key,
        source,
        tenant,
        channel,
        root,
        org,
        team,
        kind,
        `aem-${org}`,
        title,
        path,
        later(minutes),
        later(minutes),
        later(minutes),
        logical,
        AT,
      );
    DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author,
        author_key, counted) VALUES (?, ?, ?, ?, ?, ?, 'Cy Customer', ?, 1)`)
      .run(source, tenant, channel, root, key, later(minutes), `${source}:${tenant}:U1`);
    return path;
  };
  thread({
    key: 'slack:E1:C1:1.1', channel: 'C1', root: '1.1', title: 'Cache purge fails', minutes: 5,
  });
  thread({
    key: 'slack:E1:C1:2.1', channel: 'C1', root: '2.1', title: 'Sitemap is empty', minutes: 4,
  });
  // A follow-up re-threaded into the first: one entry.
  const p3 = thread({
    key: 'slack:E1:C1:3.1', channel: 'C1', root: '3.1', title: 'Still failing', minutes: 6, logical: 'slack:E1:C1:1.1',
  });
  const p4 = thread({
    key: 'teams:T1:G1:C2:4', source: 'teams', tenant: 'T1', channel: 'C2', root: '4', org: 'globex', title: 'Redirects after go-live', minutes: 3,
  });
  thread({
    key: 'slack:E1:C3:5.1', channel: 'C3', root: '5.1', org: 'initech', team: 'edge', title: 'Purge API returns 403', minutes: 2,
  });
  thread({
    key: 'slack:E1:C4:6.1', channel: 'C4', root: '6.1', org: 'umbrella', team: 'edge', title: 'Cache purge for umbrella', minutes: 1,
  });
  DB.sqlite.exec(`INSERT INTO channel_teams (source, channel_id, team, added_at)
    VALUES ('slack', 'C3', 'helix', '${AT}')`);
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('globex', 'Globex Corporation', 'customer', '${AT}')`);
  DB.sqlite.exec(`INSERT INTO facts (thread, source, field, value, confidence)
    VALUES ('slack:E1:C1:2.1', 'rule', 'url', 'https://www.acme.example/sitemap.xml', 1)`);
  // The message that matches, in pile 2.
  CHANNELS.objects.set(`${p3}3.1.md`, {
    body: render({
      source: 'slack', thread: 'slack:E1:C1:3.1', id: '3.1', at: later(6), author: { kind: 'person', name: 'Cy Customer' },
    }, 'After the **deploy** the [purge](https://acme.example/purge) still fails with a timeout.'),
    options: {},
  });
  CHANNELS.objects.set(`${p4}4.md`, { body: render({ id: '4', thread: 'teams:T1:G1:C2:4' }, 'x'), options: {} });
  const asked = [];
  const env = {
    DB,
    CHANNELS,
    AI: {
      async run(model, { text }) {
        assert.match(model, /bge-base/);
        asked.push(...text);
        return { data: text.map(() => [1, 0]) };
      },
    },
    matches: {},
    filters: [],
    CONTENT: {
      async query(vector, options) {
        assert.deepEqual(vector, [1, 0]);
        assert.equal(options.returnMetadata, 'all');
        env.filters.push(options.filter);
        return { matches: env.matches[JSON.stringify(options.filter)] || [] };
      },
    },
  };
  return { env, asked };
}

const vector = (thread, score, extra = {}) => ({
  id: `${thread}:${score}`,
  score,
  metadata: {
    type: 'thread', thread, channel: thread.split(':').slice(0, -1).join(':'), ...extra,
  },
});

describe('search: words and snippets', () => {
  it('takes the query apart into words', () => {
    assert.deepEqual(terms('  "Cache"  purge, a PURGE (cdn) '), ['cache', 'purge', 'cdn']);
    assert.deepEqual(terms('a b'), []);
    assert.equal(terms('one two three four five six seven eight nine ten').length, 8);
  });

  it('shows the part of a message around the first word, as plain text', () => {
    assert.equal(snippet('The **purge** [fails](https://x.example) ![img](https://x.example/a.png)'), 'The purge fails');
    assert.equal(snippet('> quoted `my_var`\n- on /en/* and _here_'), 'quoted my_var on /en/* and _here_');
    const long = `${'word '.repeat(100)}the purge fails here ${'tail '.repeat(100)}`;
    const s = snippet(long, ['purge']);
    assert.ok(s.startsWith('…') && s.endsWith('…'));
    assert.ok(s.includes('the purge fails here'));
    assert.ok(s.length <= 245);
    assert.ok(snippet(long, ['absent']).startsWith('word'));
  });

  it('asks the vectors for the team, then the shared channels in parts of under 2 KB', () => {
    assert.deepEqual(vectorFilters('helix', []), [{ team: 'helix' }]);
    const channels = Array.from({ length: 40 }, (_, i) => `teams:${'t'.repeat(36)}:${'g'.repeat(36)}:19:${i}@thread.tacv2`);
    const filters = vectorFilters('helix', channels);
    assert.ok(filters.length > 2);
    assert.deepEqual(filters.slice(1).flatMap((f) => f.channel.$in), channels);
    filters.forEach((f) => assert.ok(JSON.stringify(f).length <= 2048));
  });
});

describe('search: the inbox', () => {
  it('finds threads by title, channel, customer and facts, on every platform, in the team only', async () => {
    const { env } = setup();
    // In titles: an entry of the team's and of a shared channel's, not the other team's.
    let r = await searchInbox(env, me, 'helix', 'purge');
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched]), [
      ['slack:E1:C1:1.1', ['title']],
      ['slack:E1:C3:5.1', ['title']],
    ]);
    assert.deepEqual(r.threads.map((t) => t.thread).sort(), ['slack:E1:C1:1.1', 'slack:E1:C3:5.1']);
    assert.deepEqual(r.words, ['purge']);
    // Every word somewhere: one in the customer's name, one in the title (Teams).
    r = await searchInbox(env, me, 'helix', 'globex redirects');
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched, h.score]), [['teams:T1:G1:C2:4', ['title', 'place'], 0.65]]);
    r = await searchInbox(env, me, 'helix', 'Corporation');
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched]), [['teams:T1:G1:C2:4', ['place']]]);
    // A fact.
    r = await searchInbox(env, me, 'helix', 'sitemap.xml');
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched, h.fact]), [
      ['slack:E1:C1:2.1', ['fact'], { field: 'url', value: 'https://www.acme.example/sitemap.xml' }],
    ]);
    // LIKE's own characters are words like any other.
    assert.deepEqual((await searchInbox(env, me, 'helix', '100%')).hits, []);
    assert.deepEqual((await searchInbox(env, me, 'helix', ' ')).hits, []);
  });

  it('finds what threads are about, with the message that matched', async () => {
    const { env, asked } = setup();
    env.matches[JSON.stringify({ team: 'helix' })] = [
      vector('slack:E1:C1:3.1', 0.81, { type: 'message', message: 'slack:E1:C1:3.1' }),
      vector('slack:E1:C1:1.1', 0.78),
      vector('teams:T1:G1:C2:4', 0.74),
      // Too far from the best, and too weak.
      vector('slack:E1:C1:2.1', MIN_SIMILAR + 0.01),
      // Another team's thread with a stale team on its vector: D1 says no.
      vector('slack:E1:C4:6.1', 0.8),
    ];
    env.matches[JSON.stringify({ channel: { $in: ['slack:E1:C3'] } })] = [vector('slack:E1:C3:5.1', 0.7)];
    const r = await searchInbox(env, me, 'helix', 'deploy timeout');
    assert.deepEqual(asked, [`${QUERY_PREFIX}deploy timeout`]);
    assert.deepEqual(env.filters, [{ team: 'helix' }, { channel: { $in: ['slack:E1:C3'] } }]);
    // The re-threaded follow-up is its group's entry; the best match first.
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched, h.score]), [
      ['slack:E1:C1:1.1', ['topic'], 0.81],
      ['teams:T1:G1:C2:4', ['topic'], 0.74],
      ['slack:E1:C3:5.1', ['topic'], 0.7],
    ]);
    assert.deepEqual(r.hits[0].snippet, {
      message: 'slack:E1:C1:3.1|3.1',
      author: 'Cy Customer',
      at: later(6),
      text: 'After the deploy the purge still fails with a timeout.',
    });
    assert.equal(r.hits[1].snippet, undefined);
    // Entries as the inbox has them, with the group's members.
    const entry = r.threads.find((t) => t.thread === 'slack:E1:C1:1.1');
    assert.deepEqual(entry.members.map((m) => m.thread), ['slack:E1:C1:1.1', 'slack:E1:C1:3.1']);
    assert.equal(entry.title, 'Cache purge fails');
  });

  it('ranks words in the title over a weaker match by topic', async () => {
    const { env } = setup();
    env.matches[JSON.stringify({ team: 'helix' })] = [vector('teams:T1:G1:C2:4', 0.8)];
    const r = await searchInbox(env, me, 'helix', 'sitemap');
    assert.deepEqual(r.hits.map((h) => h.thread), ['slack:E1:C1:2.1', 'teams:T1:G1:C2:4']);
  });

  it('still finds words when the vectors fail', async () => {
    const { env } = setup();
    env.CONTENT.query = async () => {
      throw new Error('down');
    };
    const r = await quiet(() => searchInbox(env, me, 'helix', 'sitemap'));
    assert.deepEqual(r.hits.map((h) => h.thread), ['slack:E1:C1:2.1']);
  });

  it('is a route for members of the team', async () => {
    const { env } = setup();
    const call = async (path) => {
      const url = new URL(`https://opspile.example${path}`);
      const res = await api(new Request(url), env, url, { viewer: me });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await call('/api/search?team=edge&q=purge')).status, 403);
    const r = await call('/api/search?team=helix&q=purge');
    assert.equal(r.status, 200);
    assert.equal(r.body.hits.length, 2);
  });

  it('searches the personal view: the channels of my teams I posted in', async () => {
    const { env } = setup();
    env.DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author,
        person, staff, counted) VALUES ('slack', 'E1', 'C1', '2.2', 'slack:E1:C1:2.1', '${later(7)}',
        'Ada', 1, 1, 1)`);
    const url = new URL('https://opspile.example/api/search?view=personal&q=purge');
    const res = await api(new Request(url), env, url, { viewer: me });
    const body = await res.json();
    // C1 is Ada's; the shared C3 is in helix's inbox, but she never posted there.
    assert.deepEqual([body.personal, body.hits.map((h) => h.thread)], [true, ['slack:E1:C1:1.1']]);
  });

  it('shows only the entries asked for when the inbox gets groups', async () => {
    const { env } = setup();
    const r = await inbox(env, me, 'helix', { groups: ['slack:E1:C1:1.1', 'slack:E1:C4:6.1'] });
    assert.deepEqual(r.threads.map((t) => t.thread), ['slack:E1:C1:1.1']);
    assert.equal(r.page.next, null);
  });
});

describe('search: re-filed channels', () => {
  it('makes the vectors of re-filed threads again, under their new team', async () => {
    const DB = d1({
      rules: [{
        id: 1, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'helix',
      }, {
        id: 2, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
      }],
    });
    DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C1', 'aem-acme', '${AT}')`);
    const path = 'channels/_unassigned/_unassigned/slack-C1/1.1/';
    DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, path, root_at, last_at, any_at, messages, embedded, vectorized_through, updated_at)
      VALUES ('slack:E1:C1:1.1', 'slack', 'E1', 'C1', '1.1', '_unassigned', '_unassigned',
        'channel', '${path}', '${AT}', '${AT}', '${AT}', 1, 'h', '${AT}', '${AT}')`);
    DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, counted, embedded)
      VALUES ('slack', 'E1', 'C1', '1.1', 'slack:E1:C1:1.1', '${AT}', 1, 'h')`);
    const CHANNELS = fakeBucket({ [`${path}1.1.md`]: '---\nid: "1.1"\n---\nhello' });
    const queued = [];
    const NORMALIZE = {
      async send(body) { queued.push(body); },
      async sendBatch(jobs) { queued.push(...jobs.map((j) => j.body)); },
    };
    const job = {
      source: 'slack', tenant: 'E1', channelId: 'C1', threads: [['slack:E1:C1:1.1', path]],
    };
    // Without a CONTENT index, nothing to do.
    await refile({ DB, CHANNELS, NORMALIZE }, job);
    assert.deepEqual(queued, []);
    assert.deepEqual(DB.rows('SELECT team, embedded FROM threads'), [{ team: 'helix', embedded: 'h' }]);
    // Moved back (as a rule change would) and filed again, with the index: made again.
    DB.sqlite.exec("UPDATE threads SET team = '_unassigned', org = '_unassigned'");
    await refile({
      DB, CHANNELS, NORMALIZE, CONTENT: {},
    }, job);
    assert.deepEqual(queued, [{ vectorize: 'slack:E1:C1:1.1' }]);
    assert.deepEqual(DB.rows('SELECT team, embedded, vectorized_through FROM threads'), [
      { team: 'helix', embedded: null, vectorized_through: null },
    ]);
    assert.deepEqual(DB.rows('SELECT embedded FROM messages'), [{ embedded: null }]);
    // Filed where it already is: nothing.
    queued.length = 0;
    await refile({
      DB, CHANNELS, NORMALIZE, CONTENT: {},
    }, job);
    assert.deepEqual(queued, []);

    // Re-filed as an alert channel: its vectors are taken away, not made again.
    DB.sqlite.exec("UPDATE messages SET embedded = 'h'; UPDATE threads SET embedded = 'h'");
    DB.sqlite.exec(`INSERT INTO rules (id, target, priority, source, field, pattern, value)
      VALUES (3, 'kind', 100, NULL, 'name', '^aem-', 'alert')`);
    const removed = [];
    const CONTENT = {
      async deleteByIds(ids) {
        removed.push(...ids);
      },
    };
    await refile({
      DB, CHANNELS, NORMALIZE, CONTENT,
    }, job);
    assert.deepEqual(queued, [{ vectorize: 'slack:E1:C1:1.1' }]);
    const r = await vectorizeThread({ DB, CHANNELS, CONTENT }, 'slack:E1:C1:1.1');
    assert.deepEqual(r, { result: 'skip', reason: 'alert', removed: 2 });
    assert.deepEqual(removed, [
      await messageVectorId('slack:E1:C1:1.1'), await threadVectorId('slack:E1:C1:1.1'),
    ]);
    assert.deepEqual(DB.rows('SELECT embedded FROM messages'), [{ embedded: null }]);
    assert.deepEqual(await vectorizeThread({ DB, CHANNELS, CONTENT }, 'slack:E1:C1:1.1'), {
      result: 'skip', reason: 'alert',
    });
  });
});
