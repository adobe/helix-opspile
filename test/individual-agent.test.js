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

// The thread agents of an individual channel (src/individual.js): each end user's thread learns
// into a knowledge base of its own and reads only that person's threads; the team's knowledge
// base is as in any channel. Every identifier, name and address here is made up.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { processKey } from '../src/normalizer.js';
import { normalizePortal } from '../src/normalize.js';
import { receive } from '../src/portalsource.js';
import { deliver } from '../src/portal/events.js';
import {
  endUserOf, individualOf, MERGE_DAYS, personSlug, recordAudience,
} from '../src/individual.js';
import * as platform from '../src/portal/platform.js';
import { accessibleRepos } from '../src/agent/repos.js';
import { channelThreads, resolveThread } from '../src/agent/history.js';
import { readable } from '../src/agent/watches.js';
import { readScope } from '../src/agent/agenttools.js';
import { opspileExtension, staffExtension } from '../src/agent/tools.js';
import { checkLayout } from '../src/agent/okf.js';
import { kindOf } from '../src/agent/kbwrite.js';
import { fakeArtifacts as madeArtifacts, fakeRepo, quiet } from './fakes.js';
import {
  ADA, BO, ORG, setup, world,
} from './integration-world.js';

setup();

const ADA_TOO = 'A9B9C9D9E5F6A7B8C9D0E1F2@AdobeID';

/** What the portal told the inbox, filed there. */
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

/**
 * An individual channel (or a shared one) of `panel` with Ada (two profiles, one address) and Bo,
 * their threads filed in the inbox: `{ w, channel, keys: { ada, ada2, adaToo, bo } }`.
 */
async function channelWithThreads({ audience = 'individual' } = {}) {
  const w = world();
  w.inbox.ARTIFACTS = madeArtifacts();
  const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
  for (const [subject, name] of [[ADA_TOO, 'Ada Example'], [BO, 'Bo Example']]) {
    const { actor } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
      VALUES (?, ?) RETURNING actor`).get(channel, name);
    w.db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, ?)')
      .run(channel, subject, actor);
  }
  w.db.sqlite.prepare('UPDATE users SET name = \'Ada Example\' WHERE id IN (SELECT actor FROM integration_members WHERE subject = ?)').run(ADA);
  if (audience === 'individual') {
    const set = await quiet(() => w.staff(w.admin, 'PUT', '/api/admin/portal/integration/audience', { channel, audience }));
    assert.equal(set.status, 200);
  }
  const profile = { email: 'ada@mill.example', displayName: 'Ada Example' };
  const as = {
    ada: { bearer: await w.token({ user: ADA, profile }) },
    adaToo: { bearer: await w.token({ user: ADA_TOO, profile }) },
    bo: { bearer: await w.token({ user: BO }) },
  };
  const roots = {};
  for (const [name, who, title] of [['ada', 'ada', 'Exports fail'], ['ada2', 'ada', 'Login loops'],
    ['adaToo', 'adaToo', 'From home'], ['bo', 'bo', 'Billing secret']]) {
    // eslint-disable-next-line no-await-in-loop
    roots[name] = (await w.call('POST', '/threads', { ...as[who], body: { title, body: `${title}, please.` } })).body.threadId;
  }
  await filed(w);
  const keys = Object.fromEntries(Object.entries(roots).map(([k, root]) => [k,
    w.inbox.DB.rows('SELECT thread FROM threads WHERE root_id = ?', root)[0].thread]));
  return { w, channel, keys };
}

/** The target of the agent of thread `key`, as ThreadAgent makes it (src/agent/agent.js). */
async function targetOf(env, key) {
  const row = env.DB.rows('SELECT * FROM threads WHERE thread = ?', key)[0];
  return {
    key,
    team: row.team,
    org: row.org,
    kind: row.kind,
    tenant: row.tenant,
    channelId: row.channel_id,
    channelName: row.channel_name,
    source: row.source,
    threads: [key],
    follows: [],
    individual: await individualOf(env, {
      source: row.source,
      tenant: row.tenant,
      channelId: row.channel_id,
      org: row.org,
      team: row.team,
    }, [key]),
  };
}

describe('the agents of an individual channel', () => {
  it('know the channel is individual from the portal, the latest word winning', async () => {
    const { w, channel } = await channelWithThreads();
    const tenant = `${channel}.embed.invalid`;
    const [row] = w.inbox.DB.rows('SELECT audience, seq FROM channel_audiences WHERE channel_id = ?', channel);
    assert.equal(row.audience, 'individual');
    assert.equal(await recordAudience(w.inbox, {
      tenant, channelId: channel, audience: 'shared', seq: row.seq - 1,
    }), false);
    // A shared channel nobody set has no row; a message of one writes none.
    assert.equal(await recordAudience(w.inbox, {
      tenant, channelId: 'cnothere00000', audience: 'shared', seq: 99,
    }), false);
    assert.equal(w.inbox.DB.rows('SELECT * FROM channel_audiences WHERE channel_id = ?', 'cnothere00000').length, 0);
  });

  it('gives each end user a knowledge base of their own, one for both of their profiles', async () => {
    const { w, keys } = await channelWithThreads();
    const [ada, ada2, adaToo, bo] = await Promise.all([keys.ada, keys.ada2, keys.adaToo, keys.bo]
      .map((k) => targetOf(w.inbox, k)));
    assert.equal(ada.individual.name, 'Ada Example');
    assert.equal(ada.individual.slug, await personSlug({ mail: 'ada@mill.example' }));
    assert.equal(ada2.individual.kb, ada.individual.kb);
    assert.equal(adaToo.individual.kb, ada.individual.kb);
    assert.notEqual(bo.individual.kb, ada.individual.kb);
    assert.match(ada.individual.kb, /^kb-person-p[0-9a-f]{24}$/);
    const kinds = w.inbox.DB.rows(`SELECT repo, owner_org, owner_team FROM knowledge_bases
      WHERE kind = 'person' ORDER BY repo`);
    assert.deepEqual(kinds.map((k) => k.repo).sort(), [ada.individual.kb, bo.individual.kb].sort());
    // Whose their costs are: the channel's customer and team (src/cogs/rollup.js).
    assert.ok(kinds.every((k) => k.owner_org === 'mill' && k.owner_team === 'agents'));

    // What each agent may name: the team's, and its end user's, never the org's or another's.
    const reposA = await accessibleRepos(w.inbox, ada);
    const kbs = reposA.filter((r) => r.kind === 'kb' && r.scope === 'own').map((r) => [r.id, r.artifact]);
    assert.deepEqual(kbs, [['kb-team', 'kb-team-agents'], ['kb-person', ada.individual.kb]]);
    assert.ok(!reposA.some((r) => r.id === 'kb-org' || r.artifact === bo.individual.kb));
    // A shared channel's agent has the org's, as always.
    const shared = await accessibleRepos(w.inbox, { ...ada, individual: null });
    assert.ok(shared.some((r) => r.id === 'kb-org' && r.artifact === 'kb-org-mill'));
    assert.ok(!shared.some((r) => r.id === 'kb-person'));
  });

  it('reads and writes only its end user\'s knowledge base, and is told so', async () => {
    const { w, keys } = await channelWithThreads();
    const ada = await targetOf(w.inbox, keys.ada);
    const bo = await targetOf(w.inbox, keys.bo);
    const repos = {
      'kb-team-agents': { 'index.md': '# Team\n' },
      'kb-org-mill': { 'index.md': '# Mill\n', 'customer/mill.md': 'every end user' },
      [ada.individual.kb]: { 'index.md': '# Ada\n', 'projects/exports.md': 'Ada exports nightly' },
      [bo.individual.kb]: { 'index.md': '# Bo\n', 'projects/billing.md': 'Bo billing secret' },
    };
    w.inbox.ARTIFACTS = { get: async (name) => fakeRepo(repos[name] || {}) };
    const ext = opspileExtension({
      env: w.inbox, hasThread: true, target: async () => ada, verdicts: async () => new Map(),
    });
    // A tool that throws fails its call, with what it threw (as the harness reports it).
    const run = async (name, args) => {
      try {
        const res = await ext.tools.find((t) => t.name === name).execute(args, { conversationId: 'c' });
        return res.output.map((o) => o.text).join('');
      } catch (e) {
        return e.message;
      }
    };
    assert.match(await run('git_ls', { repo: 'kb-person' }), /projects\/$/m);
    assert.match(await run('git_read', { repo: 'kb-person', path: 'projects/exports.md' }), /Ada exports nightly/);
    for (const repo of ['kb-org', bo.individual.kb, 'kb-org-mill']) {
      // eslint-disable-next-line no-await-in-loop
      assert.match(await run('git_ls', { repo }), /unknown repository/, repo);
    }
    for (const kb of ['org', bo.individual.kb]) {
      // eslint-disable-next-line no-await-in-loop
      assert.match(await run('kb_write', { kb, message: 'x', changes: [{ path: 'projects/x.md', content: 'x' }] }), /unknown repository[\s\S]*Nothing was written/);
    }
    const render = async (name) => ext.sections.find((x) => x.key === name).render({ conversationId: 'c' });
    assert.match(await render('individual'), /Your thread is with Ada Example/);
    assert.match(await render('individual'), /never their name, words, setup/);
    const listed = await render('repositories');
    assert.match(listed, /kb-person: knowledge base of Ada Example, the end user your thread is with: theirs alone \(you can write it\)/);
    assert.doesNotMatch(listed, /kb-org|Bo/);
    assert.doesNotMatch(await render('knowledge'), /Bo billing|every end user/);
    assert.equal(await render('stack-drawing'), '');
    // The team's own instructions, as in any channel.
    repos['kb-team-agents']['systemprompt.md'] = '---\ntype: System Prompt\ntitle: x\n---\n\nSign as the team.';
    repos['kb-org-mill']['systemprompt.md'] = '---\ntype: System Prompt\ntitle: x\n---\n\nAbout every end user.';
    const staffExt = staffExtension({ env: w.inbox, target: async () => ada });
    const staff = await staffExt.sections[0].render({});
    assert.match(staff, /## For the ops team agents\n\nSign as the team\./);
    assert.doesNotMatch(staff, /every end user/);
    // A shared channel's agent is told nothing of it.
    const sharedExt = opspileExtension({
      env: w.inbox, hasThread: true, target: async () => ({ ...ada, individual: null }),
    });
    assert.equal(await sharedExt.sections.find((x) => x.key === 'individual').render({}), '');
  });

  it('reads only its end user\'s threads of the channel, from either profile', async () => {
    const { w, keys } = await channelWithThreads();
    const ada = await targetOf(w.inbox, keys.ada);
    const listed = await channelThreads(w.inbox, keys.ada);
    assert.deepEqual(listed.threads.map((t) => t.thread).sort(), [keys.ada2, keys.adaToo].sort());
    assert.deepEqual((await channelThreads(w.inbox, keys.bo)).threads, []);
    assert.equal((await resolveThread(w.inbox, keys.ada, keys.adaToo)).key, keys.adaToo);
    assert.match((await resolveThread(w.inbox, keys.ada, keys.bo)).error, /no thread of your channel/);
    assert.equal(await readable(w.inbox, ada, keys.ada2), 'channel');
    assert.equal(await readable(w.inbox, ada, keys.bo), null);
    assert.equal(readScope(['org_threads', 'any_thread'], ada), null);
    const ext = opspileExtension({
      env: w.inbox, hasThread: true, target: async () => ada, verdicts: async () => new Map(),
    });
    const run = async (name, args) => {
      const res = await ext.tools.find((t) => t.name === name).execute(args, { conversationId: 'c' });
      return res.output.map((o) => o.text).join('');
    };
    assert.doesNotMatch(await run('list_channel_threads', {}), /Billing/);
    assert.match(await run('list_channel_threads', { query: 'Login' }), /Login loops/);
    assert.match(await run('read_thread', { thread: keys.bo }), /no thread of your channel/);
    assert.doesNotMatch(await run('read_thread', { thread: keys.bo }), /Billing secret/);
  });

  it('joins a profile whose address went stale no longer, as the portal does', async () => {
    const { w, keys } = await channelWithThreads();
    const before = await channelThreads(w.inbox, keys.ada);
    assert.ok(before.threads.some((t) => t.thread === keys.adaToo));
    // Her second profile last verified the address over a month ago: as if it were someone else's.
    const [{ author_key: author }] = w.inbox.DB.rows(`SELECT author_key FROM messages
      WHERE thread = ?`, keys.adaToo);
    const old = new Date(Date.now() - (MERGE_DAYS + 1) * 864e5).toISOString();
    w.inbox.DB.sqlite.prepare(`UPDATE identities SET merge_at = ? WHERE source || ':' || tenant
      || ':' || user_id = ?`).run(old, author);
    const listed = await channelThreads(w.inbox, keys.ada);
    assert.deepEqual(listed.threads.map((t) => t.thread), [keys.ada2]);
    assert.match((await resolveThread(w.inbox, keys.ada, keys.adaToo)).error, /no thread of your channel/);
  });

  it('records a resumed reservation\'s audience in the inbox either way', async () => {
    const w = world();
    await w.list();
    // A first approval reserved it individual, and the inbox recorded that; then routing failed.
    const reserved = await platform.reserve(w.portal, {
      id: 1, customer: 'agents-mill', name: 'agents-mill', by: { email: w.admin.email }, audience: 'individual',
    });
    const { id } = reserved.channel;
    await recordAudience(w.inbox, { tenant: `${id}.embed.invalid`, channelId: id, audience: 'individual' });
    const inbox = () => w.inbox.DB.rows('SELECT audience FROM channel_audiences WHERE channel_id = ?', id)
      .map((r) => r.audience);
    // Approved again, unchecked: shared in the portal and in the inbox.
    const done = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', {
      id: 1, team: 'agents', org: 'mill', audience: 'shared',
    }));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(inbox(), ['shared']);
  });

  it('reads every thread of a shared channel, as before', async () => {
    const { w, keys } = await channelWithThreads({ audience: 'shared' });
    const ada = await targetOf(w.inbox, keys.ada);
    assert.equal(ada.individual, null);
    assert.equal((await channelThreads(w.inbox, keys.ada)).threads.length, 3);
    assert.equal((await resolveThread(w.inbox, keys.ada, keys.bo)).key, keys.bo);
    assert.equal(await readable(w.inbox, ada, keys.bo), 'channel');
    assert.deepEqual(readScope(['org_threads'], ada), { org: 'mill' });
    assert.equal(w.inbox.DB.rows("SELECT * FROM knowledge_bases WHERE kind = 'person'").length, 0);
  });

  it('takes the first customer who wrote as the end user, never Adobe\'s people', async () => {
    const { w, keys } = await channelWithThreads();
    const who = await endUserOf(w.inbox, [keys.bo]);
    assert.deepEqual([who.name, who.mail], ['Bo Example', 'bo@mill.example']);
    assert.equal(await endUserOf(w.inbox, ['portal:nowhere.example:c1:m1']), null);
  });

  it('writes nothing for a shared channel\'s messages, which say no audience', () => {
    const event = (audience) => normalizePortal('k', {
      type: 'message',
      domain: 'cx.embed.invalid',
      seq: 7,
      channel: { id: 'cx', name: 'x', ...(audience ? { audience } : {}) },
      author: { id: 'u1', kind: 'customer', name: 'Ada' },
      message: {
        id: 'm1', root: 'm1', at: '2026-01-01T00:00:00Z', text: 'hi',
      },
    });
    assert.equal(event(null).message.audience, undefined);
    assert.deepEqual(event('individual').message.audience, { audience: 'individual', seq: 7 });
    const channel = normalizePortal('k', {
      type: 'channel', domain: 'cx.embed.invalid', seq: 8, channel: { id: 'cx', name: 'x', audience: 'shared' },
    });
    assert.deepEqual(channel.channel.audience, { audience: 'shared', seq: 8 });
  });

  it('lays an end user\'s knowledge base out as a customer\'s', () => {
    assert.equal(kindOf('kb-person-p0123'), 'person');
    const vendor = '---\ntype: Vendor\ntitle: Acme\n---\n';
    assert.match(checkLayout('products/acme.md', vendor, 'person'), /team's catalog/);
    assert.equal(checkLayout('customer/ada.md', '---\ntype: Customer\ntitle: Ada\n---\n', 'person'), null);
  });
});
