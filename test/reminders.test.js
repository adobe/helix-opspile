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
import { clearExpertLists } from '../src/experts.js';
import { sweepMentionModel } from '../src/mentionmodels.js';
import {
  mentionReminders, messageLink, QUIET_DAYS, roughlyAgo,
} from '../src/reminders.js';
import { d1 } from './d1.js';

// Made-up ids and names only.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const MIN = 60000;
const DAYS = 24 * 60 * MIN;
const ago = (ms) => new Date(NOW - ms).toISOString();
const THREAD = 'slack:E1:C1:9.9';
const STAFF = [[1, 'Ada'], [2, 'Bo'], [3, 'Cy'], [4, 'Di'], [5, 'Ed']];

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [
      ...STAFF.map(([id, name]) => ({
        id, email: `${name.toLowerCase()}@staff.example`, name, staff: 1,
      })),
      {
        id: 9, email: 'cu@customer.example', name: 'Cu', staff: 0,
      },
    ],
  });
  const { sqlite } = DB;
  for (const [id, name] of [...STAFF, [9, 'Cu']]) {
    sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, person, fetched_at)
      VALUES ('slack', 'E1', ?, 'person', ?, ?, ?)`).run(`U${id}`, name, id, ago(0));
  }
  sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, fetched_at, domain)
    VALUES ('slack', 'E1', 'C1', ?, 'acme-staff')`).run(ago(0));
  const addThread = (thread) => sqlite.prepare(`INSERT INTO threads (thread, source, tenant,
      channel_id, root_id, org, team, path, title, kind, any_at, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix', 'p/', 'A thread', 'channel', ?, ?)`)
    .run(thread, thread.split(':')[3], ago(0), ago(0));
  const addMessage = (thread, id, person, at, staff = 1) => sqlite.prepare(`INSERT INTO messages
      (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
    VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, ?, 1, ?)`)
    .run(id, thread, ago(at), person, staff, `slack:E1:U${person}`);
  const mention = (thread, message, person, at) => sqlite.prepare(`INSERT INTO mentions
      (thread, message, person, at, via) VALUES (?, ?, ?, ?, 'id')`)
    .run(thread, message, person, ago(at));
  addThread(THREAD);
  return {
    DB, addThread, addMessage, mention,
  };
}

/**
 * Two months of threads in which Ada mentions Bo and Cy: Bo answers each within the hour, Cy
 * never does, though both post every day elsewhere.
 */
function history(e) {
  for (let d = 2; d <= 60; d += 1) {
    const thread = `slack:E1:C1:${d}.1`;
    e.addThread(thread);
    e.addMessage(thread, `c${d}`, 9, d * DAYS + 5 * MIN, 0);
    e.addMessage(thread, `m${d}`, 1, d * DAYS);
    e.mention(thread, `slack:E1:C1:m${d}`, 2, d * DAYS);
    e.mention(thread, `slack:E1:C1:m${d}`, 3, d * DAYS);
    e.addMessage(thread, `a${d}`, 2, d * DAYS - 30 * MIN);
  }
  // As today, too.
  for (let d = 0; d <= 60; d += 1) {
    e.addMessage('slack:E1:C1:busy.1', `b2-${d}`, 2, d * DAYS + 3 * 60 * MIN);
    e.addMessage('slack:E1:C1:busy.1', `b3-${d}`, 3, d * DAYS + 3 * 60 * MIN);
  }
  e.addThread('slack:E1:C1:busy.1');
}

const ME = { id: 1, name: 'Ada' };
const posted = (mentions, extra = {}) => ({
  thread: THREAD, text: 'Can you look?', mentions, ...extra,
});

describe('mention reminders', () => {
  beforeEach(() => clearExpertLists());

  it('says how long ago, roughly', () => {
    assert.equal(roughlyAgo(15.4), '15 days');
    assert.equal(roughlyAgo(30), '4 weeks');
    assert.equal(roughlyAgo(100), '3 months');
    assert.equal(roughlyAgo(400), 'over a year');
  });

  it('links a message on its platform', () => {
    const slack = { source: 'slack', channel_id: 'C1', root_id: '1.1' };
    assert.equal(
      messageLink(slack, '2.2', 'acme-staff'),
      'https://acme-staff.slack.com/archives/C1/p22?thread_ts=1.1&cid=C1',
    );
    assert.equal(messageLink({ ...slack, root_id: null }, '2.2'), 'https://slack.com/archives/C1/p22');
    const teams = {
      source: 'teams', tenant: 'T1', group_id: 'G1', channel_id: '19:c@thread.tacv2', root_id: '100',
    };
    assert.equal(
      messageLink(teams, '200'),
      'https://teams.microsoft.com/l/message/19%3Ac%40thread.tacv2/200?groupId=G1&tenantId=T1&parentMessageId=100',
    );
    assert.equal(messageLink({ source: 'portal' }, 'x'), null);
    assert.equal(messageLink(slack, null), null);
  });

  it('names who has not posted for two weeks, or never, and not the poster or customers', async () => {
    const e = env();
    e.addMessage('slack:E1:C1:old.1', 'o1', 4, 20 * DAYS);
    e.addMessage('slack:E1:C1:new.1', 'n1', 2, 2 * DAYS);
    const said = await mentionReminders(e, ME, posted(['U1', 'U2', 'U4', 'U5', 'U9']), {
      id: '10.1',
    }, { now: NOW });
    assert.deepEqual(said.reminders.map((r) => [r.id, r.name, r.why, r.said, r.days]), [
      ['U4', 'Di', 'quiet', 'has not posted for 20 days', 20],
      ['U5', 'Ed', 'quiet', 'has never posted where the inbox reads', null],
    ]);
    assert.equal(said.permalink, 'https://acme-staff.slack.com/archives/C1/p101?thread_ts=9.9&cid=C1');
    // Just under two weeks is not quiet.
    e.addMessage('slack:E1:C1:new.1', 'n4', 4, (QUIET_DAYS - 1) * DAYS);
    const again = await mentionReminders(e, ME, posted(['U4']), { id: '10.1' }, { now: NOW });
    assert.deepEqual(again.reminders, []);
  });

  it('names who the mention model says will likely not answer, unless they are in the thread', async () => {
    const e = env();
    history(e);
    await sweepMentionModel(e, NOW);
    const said = await mentionReminders(e, ME, posted(['U2', 'U3']), { id: '10.1' }, { now: NOW });
    assert.deepEqual(said.reminders.map((r) => [r.name, r.why]), [['Cy', 'unlikely']]);
    assert.match(said.reminders[0].said, /^answers (few|about a third of) mentions$/);
    assert.ok(said.reminders[0].odds < 0.5);
    // Cy wrote in the thread: the odds are for people not in it yet.
    e.addMessage(THREAD, 'cy', 3, DAYS);
    clearExpertLists();
    const there = await mentionReminders(e, ME, posted(['U3']), { id: '10.1' }, { now: NOW });
    assert.deepEqual(there.reminders, []);
  });

  it('says nothing without mentions, and links a new thread by its first message', async () => {
    const e = env();
    assert.deepEqual(await mentionReminders(e, ME, posted([]), { id: '1.1' }, { now: NOW }), {
      reminders: [],
    });
    const said = await mentionReminders(e, ME, {
      channel: 'slack:E1:C1', text: 'Hello', mentions: ['U5'],
    }, { id: '11.1', thread: 'slack:E1:C1:11.1' }, { now: NOW });
    assert.deepEqual(said.reminders.map((r) => r.name), ['Ed']);
    assert.equal(said.permalink, 'https://acme-staff.slack.com/archives/C1/p111');
  });
});
