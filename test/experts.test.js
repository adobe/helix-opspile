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
import {
  clearExpertLists, experts, findExperts, hasPair, MAX_SUGGESTED, reasonsOf, responseTimes, roughly,
  suggestExpert, titlePairs,
} from '../src/experts.js';
import { d1 } from './d1.js';

// Made-up ids, names and vectors only.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const HOURS = 60;
const DAYS = 24 * HOURS;
const THREAD = 'slack:E1:C1:9.9';

const STAFF = [
  [1, 'Ada'], [2, 'Bo'], [3, 'Cy'], [4, 'Di'], [5, 'Ed'], [6, 'Flo'], [7, 'Gus'],
];

function env({ matches = [], chunks = [], search = true } = {}) {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: STAFF.map(([id, name]) => ({
      id, email: `${name.toLowerCase()}@staff.example`, name, staff: 1,
    })),
  });
  const { sqlite } = DB;
  const addThread = (thread, { org = 'acme', channel = 'C1', logical = null } = {}) => {
    sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, title, embedded, logical_thread, any_at, updated_at)
      VALUES (?, 'slack', 'E1', ?, ?, ?, 'helix', 'p/', 'Slow cache purge', 'h', ?, ?, ?)`)
      .run(thread, channel, thread.split(':')[3], org, logical, ago(0), ago(0));
  };
  const addMessage = (thread, id, person, minutes, { channel = 'C1', staff = 1 } = {}) => {
    sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person, staff,
      counted, author_key) VALUES ('slack', 'E1', ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(channel, id, thread, ago(minutes), person, staff, `slack:E1:U${person}`);
  };
  const mention = (thread, message, person, minutes) => {
    sqlite.prepare(`INSERT INTO mentions (thread, message, person, at, via)
      VALUES (?, ?, ?, ?, 'id')`).run(thread, message, person, ago(minutes));
  };
  const member = (person, channel = 'C1') => {
    sqlite.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id)
      VALUES ('slack', 'E1', ?, ?)`).run(channel, `U${person}`);
  };
  for (const [id, name] of STAFF) {
    sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, person, fetched_at)
      VALUES ('slack', 'E1', ?, 'person', ?, ?, ?)`).run(`U${id}`, name, id, ago(0));
  }
  sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, fetched_at)
    VALUES ('slack', 'E1', 'C1', ?)`).run(ago(0));
  addThread(THREAD);
  return {
    STAFF_DOMAINS: 'staff.example',
    DB,
    addThread,
    addMessage,
    mention,
    member,
    AI: { async run() { return { data: [[1, 0, 0]] }; } },
    CONTENT: {
      async getByIds(ids) { return ids.map((id) => ({ id, values: [1, 0, 0] })); },
      async query() { return { matches }; },
    },
    ...(search ? { SEARCH: { async search() { return { chunks }; } } } : {}),
  };
}

const vector = (score, person, thread = 'slack:E1:C9:1.1') => ({
  score, metadata: { person, thread, author: `slack:E1:U${person}` },
});
const word = (message, text, score = 1) => ({ score, text, item: { metadata: { message } } });
const names = (found) => found.experts.map((e) => e.name);

describe('expert finder', () => {
  beforeEach(clearExpertLists);

  it('says times in words', () => {
    assert.equal(roughly(2), 'within minutes');
    assert.equal(roughly(37), 'about 35 minutes');
    assert.equal(roughly(60), 'about 1 hour');
    assert.equal(roughly(4.2 * 60), 'about 4 hours');
    assert.equal(roughly(50 * 60), 'about 2 days');
  });

  it('counts answered mentions, a group as one thread', async () => {
    const e = env();
    e.addThread('slack:E1:C1:1.1');
    e.addThread('slack:E1:C1:2.1', { logical: 'slack:E1:C1:1.1' });
    // Bo: mentioned in the group's first thread, answers in its second.
    e.mention('slack:E1:C1:1.1', 'm1', 2, 3 * DAYS);
    e.addMessage('slack:E1:C1:2.1', 'a1', 2, 3 * DAYS - 30);
    // Not answered.
    e.mention('slack:E1:C1:1.1', 'm2', 2, 2 * DAYS);
    // Long before the window: it does not count.
    e.mention('slack:E1:C1:1.1', 'm0', 2, 300 * DAYS);
    const times = await responseTimes(e, [2], { channel: 'slack:E1:C1', now: NOW });
    assert.equal(times.get(2).mentions, 2);
    assert.equal(times.get(2).answered, 1);
  });

  it('times new people in a thread from the customer message before them', async () => {
    const e = env();
    ['1.1', '2.1', '3.1'].forEach((root, i) => {
      const thread = `slack:E1:C1:${root}`;
      e.addThread(thread);
      e.addMessage(thread, `c${i}`, null, (i + 1) * DAYS, { staff: 0 });
      e.addMessage(thread, `a${i}`, 2, (i + 1) * DAYS - 60);
      // Already active: this post says nothing.
      e.addMessage(thread, `b${i}`, 2, (i + 1) * DAYS - 600);
    });
    const times = await responseTimes(e, [2, 3], { channel: 'slack:E1:C1', now: NOW });
    assert.equal(times.get(2).joins, 3);
    assert.equal(times.get(2).minutes, 60);
    assert.equal(times.get(3).joins, 0);
  });

  it('says a response time only with enough answers, and most mentions answered', () => {
    const said = (response) => reasonsOf({ response, member: true });
    const answers = { joins: 3, answered: 3, mentions: 3 };
    assert.deepEqual(said({ ...answers, minutes: 60 }), ['typically responds in about 1 hour']);
    assert.deepEqual(said({ ...answers, minutes: 2 }), ['typically responds within minutes']);
    // Nobody mentioned them: the answers still say something.
    assert.deepEqual(said({
      minutes: 60, joins: 3, answered: 0, mentions: 0,
    }), ['typically responds in about 1 hour']);
    assert.deepEqual(said({ ...answers, minutes: 60, joins: 2 }), []);
    assert.deepEqual(said({ ...answers, minutes: 60, mentions: 7 }), []);
  });

  it('adds up channel, customer, meaning and words, and says why', async () => {
    const e = env({
      matches: [vector(0.9, 3), vector(0.85, 3), vector(0.82, 4)],
      chunks: [word('slack:E1:C9:5.5|5.5', 'The cache purge never ends')],
    });
    // Ada works the channel; Bo only the customer, in another channel.
    e.addThread('slack:E1:C1:1.1');
    e.addMessage('slack:E1:C1:1.1', 'x1', 1, DAYS);
    e.addThread('slack:E1:C2:1.1', { channel: 'C2' });
    e.addMessage('slack:E1:C2:1.1', 'x2', 2, DAYS, { channel: 'C2' });
    // Di's message has the title's words.
    e.addThread('slack:E1:C9:5.5', { org: 'other', channel: 'C9' });
    e.addMessage('slack:E1:C9:5.5', '5.5', 4, 2 * DAYS, { channel: 'C9' });
    e.addMessage('slack:E1:C9:5.5', 'x3', 3, 2 * DAYS, { channel: 'C9' });
    e.member(3);
    e.member(4);
    const found = await findExperts(e, THREAD, { now: NOW });
    assert.equal(found.platform, 'slack');
    assert.deepEqual(names(found), ['Ada', 'Di', 'Cy', 'Bo']);
    const of = (name) => found.experts.find((x) => x.name === name);
    assert.deepEqual(of('Ada').reasons, ['is active in this channel']);
    assert.deepEqual(of('Di').reasons, ['knows about this topic']);
    assert.deepEqual(of('Bo').reasons, ['works with this customer', 'not in this channel']);
    assert.equal(of('Cy').id, 'U3');
    assert.equal(of('Cy').member, true);
  });

  it('takes two neighbouring words of the title, not any one of them', async () => {
    const pairs = titlePairs('Image Service TEST worker secrets');
    assert.ok(hasPair('We set up image-service last week', pairs));
    assert.ok(hasPair('Two TEST workers, one prod', pairs));
    assert.ok(hasPair('Rotate the worker secret', pairs));
    assert.ok(!hasPair('Service files on a test box', pairs));
    assert.ok(!hasPair('The secrets of a worker', pairs));
    assert.ok(!hasPair('subservice testing', pairs));
    assert.ok(!hasPair(undefined, pairs));
    // A pair with a word that says nothing is no pair, and a title may have none.
    assert.deepEqual(titlePairs('Purge is slow'), []);
    assert.deepEqual(titlePairs('Purge'), []);
    assert.deepEqual(titlePairs(null), []);

    const e = env({
      chunks: [
        word('slack:E1:C9:5.5|5.5', 'The purge of the cache is done', 1),
        word('slack:E1:C9:5.5|x1', 'A slow cache here', 0.5),
      ],
    });
    e.addThread('slack:E1:C9:5.5', { org: 'other', channel: 'C9' });
    e.addMessage('slack:E1:C9:5.5', '5.5', 1, 2 * DAYS, { channel: 'C9' });
    e.addMessage('slack:E1:C9:5.5', 'x1', 2, 2 * DAYS, { channel: 'C9' });
    const found = await findExperts(e, THREAD, { now: NOW });
    // Ada's message scores higher, but only Bo's has two neighbouring words of the title.
    assert.deepEqual(names(found), ['Bo']);
    assert.deepEqual(found.experts[0].reasons, ['knows about this topic']);
  });

  it('asks for no words when the title has no pair to look for', async () => {
    const e = env();
    let asked = 0;
    e.SEARCH.search = async () => {
      asked += 1;
      return { chunks: [] };
    };
    e.DB.sqlite.prepare("UPDATE threads SET title = 'Purge is slow'").run();
    await findExperts(e, THREAD, { now: NOW });
    assert.equal(asked, 0);
  });

  it('says nothing about who is in a channel whose members were never listed', async () => {
    const e = env({ matches: [vector(0.9, 3), vector(0.89, 4)] });
    e.addThread('slack:E1:C9:1.1', { org: 'other', channel: 'C9' });
    e.addMessage('slack:E1:C9:1.1', 'x1', 3, DAYS, { channel: 'C9' });
    e.addMessage('slack:E1:C9:1.1', 'x2', 4, DAYS, { channel: 'C9' });
    let found = await findExperts(e, THREAD, { now: NOW });
    assert.deepEqual(names(found), ['Cy', 'Di']);
    assert.equal(found.experts[0].member, null);
    assert.deepEqual(found.experts[0].reasons, ['knows about this topic']);
    // Listed: Cy is not in it, and someone who is comes first.
    clearExpertLists();
    e.member(4);
    found = await findExperts(e, THREAD, { now: NOW });
    assert.deepEqual(names(found), ['Di', 'Cy']);
    assert.equal(found.experts[1].member, false);
    assert.deepEqual(found.experts[1].reasons, ['knows about this topic', 'not in this channel']);
    // A listing that failed proves nobody is out, whatever rows it left.
    clearExpertLists();
    e.DB.sqlite.prepare("UPDATE channels SET members_error = 'missing_scope'").run();
    found = await findExperts(e, THREAD, { now: NOW });
    assert.deepEqual(names(found), ['Cy', 'Di']);
    assert.equal(found.experts[0].member, null);
  });

  it('leaves out who is in the thread, who it mentions, the viewer, and who moved on', async () => {
    const e = env({
      matches: [
        vector(0.9, 1), vector(0.9, 2), vector(0.9, 3), vector(0.9, 4), vector(0.9, 5),
        // What is said in the thread itself says nothing about who should be pulled in.
        vector(0.99, 6, THREAD),
      ],
    });
    e.addThread('slack:E1:C9:1.1', { org: 'other', channel: 'C9' });
    for (const person of [1, 2, 3, 4, 5, 6]) {
      e.addMessage('slack:E1:C9:1.1', `x${person}`, person, person === 5 ? 200 * DAYS : DAYS, { channel: 'C9' });
    }
    e.addMessage(THREAD, 'y1', 1, 60);
    e.mention(THREAD, 'y1', 2, 60);
    const found = await findExperts(e, THREAD, { me: 3, now: NOW });
    assert.deepEqual(names(found), ['Di']);
  });

  it('drops people with no account on the thread\'s platform', async () => {
    const e = env({ matches: [vector(0.9, 1), vector(0.9, 2)] });
    e.addThread('slack:E1:C9:1.1', { org: 'other', channel: 'C9' });
    e.addMessage('slack:E1:C9:1.1', 'x1', 1, DAYS, { channel: 'C9' });
    e.addMessage('slack:E1:C9:1.1', 'x2', 2, DAYS, { channel: 'C9' });
    e.DB.sqlite.prepare("DELETE FROM identities WHERE user_id = 'U2'").run();
    assert.deepEqual(names(await findExperts(e, THREAD, { now: NOW })), ['Ada']);
  });

  it('still answers when a signal fails, or there is none', async () => {
    const e = env({ search: false });
    e.CONTENT.query = async () => {
      throw new Error('down');
    };
    e.addThread('slack:E1:C1:1.1');
    e.addMessage('slack:E1:C1:1.1', 'x1', 1, DAYS);
    assert.deepEqual(names(await findExperts(e, THREAD, { now: NOW })), ['Ada']);
    assert.equal(await findExperts(e, 'slack:E1:C1:nope', { now: NOW }), null);
  });

  it('keeps a list per version of the thread', async () => {
    const e = env({ matches: [] });
    let asked = 0;
    const { query } = e.CONTENT;
    e.CONTENT.query = (...args) => {
      asked += 1;
      return query(...args);
    };
    await findExperts(e, THREAD, { now: NOW });
    await findExperts(e, THREAD, { now: NOW + 1000 });
    assert.equal(asked, 1);
    e.DB.sqlite.prepare('UPDATE threads SET any_at = ? WHERE thread = ?').run(ago(-1), THREAD);
    await findExperts(e, THREAD, { now: NOW + 2000 });
    assert.equal(asked, 2);
  });

  it('shows an agent\'s suggestion first, until the person is in the thread', async () => {
    const e = env();
    e.member(5);
    e.addThread('slack:E1:C1:1.1');
    e.addMessage('slack:E1:C1:1.1', 'x1', 1, DAYS);
    const by = 'opspile-agent/test';
    assert.deepEqual(await suggestExpert(e, THREAD, { id: 'U5', reason: '  Fixed  this\nbefore ', by }), { ok: true, name: 'Ed' });
    let found = await findExperts(e, THREAD, { now: NOW });
    assert.deepEqual(names(found), ['Ed', 'Ada']);
    assert.deepEqual(found.experts[0].reasons, ['Fixed this before']);
    assert.ok(found.experts[0].suggested);
    assert.equal(found.experts[0].member, true);
    // Seen from themselves, they are not offered.
    assert.deepEqual(names(await findExperts(e, THREAD, { me: 5, now: NOW })), ['Ada']);
    e.addMessage(THREAD, 'y1', 5, 1);
    found = await findExperts(e, THREAD, { now: NOW });
    assert.deepEqual(names(found), ['Ada']);
  });

  it('takes suggestions only of staff on the platform, with a reason, and only so many', async () => {
    const e = env();
    const by = 'opspile-agent/test';
    const { sqlite } = e.DB;
    sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at)
      VALUES ('slack', 'E1', 'UX', 'person', 'A customer', ?)`).run(ago(0));
    assert.match((await suggestExpert(e, THREAD, { id: 'UX', reason: 'why', by })).error, /not an Adobe colleague/);
    assert.match((await suggestExpert(e, THREAD, { id: 'U404', reason: 'why', by })).error, /not an Adobe colleague/);
    assert.match((await suggestExpert(e, THREAD, { id: 'U1', reason: ' ', by })).error, /say why/);
    assert.match((await suggestExpert(e, 'slack:E1:C1:nope', { id: 'U1', reason: 'why', by })).error, /no such thread/);
    for (let i = 1; i <= MAX_SUGGESTED; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await suggestExpert(e, THREAD, { id: `U${i}`, reason: 'why', by })).ok, true);
    }
    assert.match((await suggestExpert(e, THREAD, { id: 'U7', reason: 'why', by })).error, /withdraw one/);
    // Changing one's reason is no new suggestion, and withdrawing makes room.
    assert.equal((await suggestExpert(e, THREAD, { id: 'U1', reason: 'better', by })).ok, true);
    assert.equal((await suggestExpert(e, THREAD, { id: 'U2', withdraw: true, by })).ok, true);
    assert.equal((await suggestExpert(e, THREAD, { id: 'U7', reason: 'why', by })).ok, true);
    const { results } = await e.DB.prepare('SELECT user_id, reason FROM expert_suggestions ORDER BY user_id').all();
    assert.deepEqual(results.map((r) => `${r.user_id}:${r.reason}`), ['U1:better', 'U3:why', 'U7:why']);
  });

  it('answers only those who may see the thread, and no message text', async () => {
    const e = env({ matches: [vector(0.9, 1)] });
    e.addThread('slack:E1:C9:1.1', { org: 'other', channel: 'C9' });
    e.addMessage('slack:E1:C9:1.1', 'x1', 1, DAYS, { channel: 'C9' });
    assert.equal((await experts(e, THREAD, () => false)).status, 404);
    assert.equal((await experts(e, 'nope', () => true)).status, 404);
    const res = await experts(e, THREAD, () => true, { me: { id: 2 } });
    const body = await res.json();
    assert.deepEqual(Object.keys(body.experts[0]).sort(), [
      'avatar', 'id', 'kind', 'member', 'name', 'reasons', 'response', 'staff',
    ]);
  });
});
