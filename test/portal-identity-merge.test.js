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

// One end user, two IMS profiles (two user IDs, one verified address): one person in the portal's
// individual channel and in the inbox, by that address as a merge key, and never staff by its
// domain. Every identifier, name and address here is made up.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listAccountPairs } from '../src/accountpairs.js';
import { processKey } from '../src/normalizer.js';
import { receive } from '../src/portalsource.js';
import { deliver } from '../src/portal/events.js';
import { MERGE_DAYS } from '../src/portal/integration-auth.js';
import { quiet } from './fakes.js';
import {
  ADA, BO, ORG, setup, world,
} from './integration-world.js';

setup();

// Ada's second profile: another user ID of the same organization, the same verified address.
const ADA_TOO = 'A9B9C9D9E5F6A7B8C9D0E1F2@AdobeID';

/**
 * A channel of `panel` with Ada's two profiles and Bo as members, `audience` set; each profile's
 * verified address is `mail` (Ada's) or Bo's own.
 */
async function twoProfiles({ audience = 'individual', mail = 'ada@mill.example' } = {}) {
  const w = world();
  const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
  for (const subject of [ADA_TOO, BO]) {
    const { actor } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
      VALUES (?, ?) RETURNING actor`).get(channel, subject === BO ? 'Bo Example' : 'Ada Example');
    w.db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, ?)')
      .run(channel, subject, actor);
  }
  w.db.sqlite.prepare('UPDATE users SET name = \'Ada Example\' WHERE id IN (SELECT actor FROM integration_members WHERE subject = ?)').run(ADA);
  if (audience === 'individual') {
    const set = await quiet(() => w.staff(w.admin, 'PUT', '/api/admin/portal/integration/audience', {
      channel, audience,
    }));
    assert.equal(set.status, 200);
  }
  const profile = { email: mail, displayName: 'Ada Example' };
  return {
    w,
    channel,
    ada: { bearer: await w.token({ user: ADA, profile }) },
    adaToo: { bearer: await w.token({ user: ADA_TOO, profile }) },
    bo: { bearer: await w.token({ user: BO }) },
  };
}

/** What the portal told the inbox, filed there as the normalizer files it. */
async function filed(w) {
  const jobs = [];
  const { inbox, portal } = w;
  inbox.NORMALIZE = { send: (job) => jobs.push(job) };
  portal.OPSPILE = { ...portal.OPSPILE, events: (events) => receive(inbox, events) };
  await deliver(portal);
  for (const { key } of jobs.filter((j) => j.key)) {
    // eslint-disable-next-line no-await-in-loop
    await quiet(() => processKey(inbox, key, {}));
  }
}

const create = (w, who, title) => w.call('POST', '/threads', { ...who, body: { title, body: `${title}, please.` } });

describe('one person with several profiles', () => {
  it('reads their threads from either profile of an individual channel, and a colleague none', async () => {
    const {
      w, ada, adaToo, bo,
    } = await twoProfiles();
    const first = (await create(w, ada, 'From work')).body.threadId;
    await w.list(adaToo);
    const second = (await create(w, adaToo, 'From home')).body.threadId;
    const boOwn = (await create(w, bo, 'Bo alone')).body.threadId;
    for (const who of [ada, adaToo]) {
      // eslint-disable-next-line no-await-in-loop
      const list = await w.list(who);
      assert.deepEqual(list.body.items.map((i) => i.id).sort(), [first, second].sort());
      // Their own messages are not unread to them, from whichever profile they wrote.
      assert.equal(list.body.unreadThreads, 0);
    }
    assert.equal((await w.call('POST', `/threads/${first}/replies`, { ...adaToo, body: { body: 'Also from home' } })).status, 201);
    assert.deepEqual((await w.list(bo)).body.items.map((i) => i.id), [boOwn]);
    assert.equal((await w.call('GET', `/threads/${first}`, bo)).status, 404);
    // The address is a merge key on the account, never its mail address: nothing signs in with it.
    const accounts = w.db.rows(`SELECT u.email, u.verified_email FROM users u
      JOIN integration_members m ON m.actor = u.id WHERE m.subject IN (?, ?)`, ADA, ADA_TOO);
    assert.deepEqual(accounts, [
      { email: null, verified_email: 'ada@mill.example' },
      { email: null, verified_email: 'ada@mill.example' },
    ]);
  });

  it('stops making them one once a profile has not verified the address for a month', async () => {
    // As when the address went to someone new after its owner left, whose profile stays active.
    const { w, ada, adaToo } = await twoProfiles();
    await create(w, ada, 'From work');
    const home = (await create(w, adaToo, 'From home')).body.threadId;
    assert.ok((await w.list(ada)).body.items.some((i) => i.id === home));
    const old = Math.floor(Date.now() / 1000) - (MERGE_DAYS + 1) * 24 * 60 * 60;
    w.db.sqlite.prepare(`UPDATE users SET verified_at = ? WHERE id IN (SELECT actor
      FROM integration_members WHERE subject = ?)`).run(old, ADA_TOO);
    assert.ok(!(await w.list(ada)).body.items.some((i) => i.id === home));
    assert.equal((await w.call('GET', `/threads/${home}`, ada)).status, 404);
    // Verifying it again joins them again.
    await w.list(adaToo);
    assert.ok((await w.list(ada)).body.items.some((i) => i.id === home));
  });

  it('keeps an unverified address from making two profiles one', async () => {
    const { w, ada } = await twoProfiles();
    const first = (await create(w, ada, 'From work')).body.threadId;
    const unverified = {
      bearer: await w.token({
        user: ADA_TOO, profile: { email: 'ada@mill.example', emailVerified: 'false', displayName: 'Ada Example' },
      }),
    };
    const list = await w.list(unverified);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items, []);
    assert.equal((await w.call('GET', `/threads/${first}`, unverified)).status, 404);
  });

  it('is one person in the inbox, with no "one person?" card, and stays outside Adobe', async () => {
    // Their verified address is at Adobe's own mail domain, which makes anyone signed in by mail
    // staff: an embedded account never is.
    const { w, ada, adaToo } = await twoProfiles({ audience: 'shared', mail: 'ada.e@staff.example' });
    await create(w, ada, 'From work');
    await create(w, adaToo, 'From home');
    await filed(w);
    const ids = w.inbox.DB.rows(`SELECT user_id, email, merge_email, staff, person FROM identities
      WHERE source = 'portal' AND name = 'Ada Example' ORDER BY user_id`);
    assert.equal(ids.length, 2);
    for (const i of ids) {
      assert.deepEqual([i.email, i.merge_email, i.staff, i.person], [null, 'ada.e@staff.example', null, null]);
    }
    // And when it was last verified, for the window an individual channel's agent applies.
    const at = w.inbox.DB.rows(`SELECT merge_at FROM identities WHERE source = 'portal'
      AND name = 'Ada Example'`).map((r) => Date.parse(r.merge_at));
    assert.ok(at.every((t) => Math.abs(t - Date.now()) < 60 * 60 * 1000), JSON.stringify(at));
    assert.equal(w.inbox.DB.rows('SELECT * FROM people WHERE email = ?', 'ada.e@staff.example').length, 0);
    const posted = w.inbox.DB.rows('SELECT staff, person FROM messages WHERE source = \'portal\'');
    assert.ok(posted.length >= 2 && posted.every((m) => m.staff === 0 && m.person === null));
    // The two accounts share a name and an address: one person, so the admin team is not asked.
    const pairs = await listAccountPairs(w.inbox);
    assert.deepEqual(pairs.filter((p) => /Ada Example/.test(`${p.a.name}${p.b.name}`)), []);
  });

  it('still asks about two accounts of one name whose addresses differ', async () => {
    const { w, ada } = await twoProfiles({ audience: 'shared' });
    const other = {
      bearer: await w.token({
        user: ADA_TOO, profile: { email: 'ada@elsewhere.example', displayName: 'Ada Example' },
      }),
    };
    await create(w, ada, 'From work');
    await create(w, other, 'From elsewhere');
    await filed(w);
    const pairs = (await listAccountPairs(w.inbox)).filter((p) => p.a.name === 'Ada Example');
    assert.equal(pairs.length, 1);
    assert.deepEqual([...pairs[0].a.mails, ...pairs[0].b.mails].sort(), ['ada@elsewhere.example', 'ada@mill.example']);
  });
});
