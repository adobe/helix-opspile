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
import { api } from '../src/api.js';
import { appRule, personRule } from '../src/attach.js';
import { runBackfill } from '../src/backfill.js';
import { parse } from '../src/channels.js';
import { normalize } from '../src/normalize.js';
import { processKey } from '../src/normalizer.js';
import { PLATFORMS, platformName } from '../src/platforms.js';
import { api as portalApi, clearStatuses } from '../src/portal/api.js';
import { deliver } from '../src/portal/events.js';
import { portalUserId } from '../src/portal/ids.js';
import * as platform from '../src/portal/platform.js';
import { recordLobby } from '../src/portalrequests.js';
import { clearWaitModel, portalStatus, standing } from '../src/portalstatus.js';
import {
  portalCall, portalKey, portalMarkdown, portalTechnologies, receive,
} from '../src/portalsource.js';
import { threadFiles } from '../src/agent/files.js';
import { postAsApp, reactAsApp } from '../src/agent/posting.js';
import { d1, PORTAL } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, teams and domains only.
const ADMIN = {
  id: 1, email: 'ada@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const MANAGER = {
  id: 2, email: 'max@staff.example', name: 'Max Manager', staff: 1, teams: ['edge'],
};
const OTHER = {
  id: 3, email: 'olga@staff.example', name: 'Olga Other', staff: 1, teams: ['helix'],
};
const CY = 'cy@customer.example';
const DEE = 'dee@customer.example';
const DOMAIN = 'customer.example';
const viewer = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });

/**
 * The inbox and the portal, each with its own database, bound to each other as their Workers
 * are: the portal's events reach the inbox's pile 1, and the inbox acts in the portal.
 * `pump()` delivers what the portal has to tell and normalizes what the inbox was told, until
 * both are through.
 */
function world({ bound = true } = {}) {
  const queued = [];
  const inbox = {
    queued,
    DB: d1({
      people: [ADMIN, MANAGER, OTHER],
      teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'helix', name: 'Helix ops' }],
    }),
    RAW: fakeBucket(),
    CHANNELS: fakeBucket(),
    NORMALIZE: { send: async (body) => queued.push(body) },
    STAFF_DOMAINS: 'staff.example',
  };
  inbox.DB.sqlite.prepare(`INSERT INTO team_follows (team, tech, added_at)
    VALUES ('edge', 'eds', '2026-11-01T00:00:00Z')`).run();
  inbox.DB.sqlite.prepare("UPDATE team_members SET role = 'manager' WHERE person = 2").run();
  const portal = {
    DB: d1({ migrations: PORTAL }),
    FILES: fakeBucket(),
    PORTAL_DOMAINS: DOMAIN,
    PUBLIC_ORIGIN: 'https://portal.example',
    PORTAL_NAME: 'test',
    OPSPILE: {
      events: (list) => receive(inbox, list),
      technologies: () => portalTechnologies(inbox),
      status: (a) => portalStatus(inbox, a),
    },
  };
  if (bound) {
    inbox.PORTAL = {
      post: (a) => platform.post(portal, a),
      edit: (a) => platform.edit(portal, a),
      react: (a) => platform.react(portal, a),
      open: (a) => platform.open(portal, a),
      decline: (a) => platform.decline(portal, a),
      resend: (a) => platform.again(portal, a),
      upload: (a) => platform.upload(portal, a),
      file: (a) => platform.file(portal, a),
      avatar: (a) => platform.avatar(portal, a),
      logo: (a) => platform.logo(portal, a),
      typing: (a) => platform.typing(portal, a),
    };
  }
  const results = [];
  async function pump() {
    const cache = {};
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { sent } = await deliver(portal);
      if (!sent && !queued.length) {
        return results;
      }
      while (queued.length) {
        const job = queued.shift();
        if (job.key) {
          // eslint-disable-next-line no-await-in-loop
          results.push(await processKey(inbox, job.key, cache));
        } else if (job.backfill) {
          // eslint-disable-next-line no-await-in-loop
          results.push(await runBackfill(inbox, job.backfill));
        }
      }
    }
    throw new Error('the portal and the inbox never came to rest');
  }
  /** The portal's API as a customer. */
  async function customer(email, method, path, body) {
    const url = new URL(`https://portal.example${path}`);
    const res = await portalApi(new Request(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }), portal, url, { email });
    return { status: res.status, body: await res.json() };
  }
  /** The portal's API as a customer, for bytes: an upload (`bytes`, `type`) or a download. */
  async function customerRaw(email, method, path, { bytes, type } = {}) {
    const url = new URL(`https://portal.example${path}`);
    return portalApi(new Request(url, {
      method,
      headers: { origin: 'https://portal.example', ...(type ? { 'content-type': type } : {}) },
      body: bytes,
    }), portal, url, { email });
  }
  /** The inbox's API as one of its people. */
  async function staff(me, method, path, body) {
    const url = new URL(`https://opspile.example${path}`);
    const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const res = await api(request, inbox, url, { viewer: me });
    return { status: res.status, body: await res.json() };
  }
  /** The inbox's API as one of its people, for bytes: the response as it is. */
  async function staffRaw(me, path, init = {}) {
    const url = new URL(`https://opspile.example${path}`);
    return api(new Request(url, init), inbox, url, { viewer: me });
  }
  return {
    inbox, portal, pump, customer, customerRaw, staff, staffRaw, results,
  };
}

/** A world where the customer asked for a channel: `{ …world, request }` (the inbox's row). */
async function asked(options) {
  const w = world(options);
  await w.customer(CY, 'GET', '/api/me');
  await w.customer(CY, 'POST', '/api/invite', { email: DEE });
  await w.customer(CY, 'PUT', '/api/lobby', { company: 'Customer Inc', tech: ['eds', 'da'], note: 'We migrate.' });
  await w.customer(CY, 'POST', '/api/lobby/request', {});
  await w.pump();
  const { body } = await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests');
  return { ...w, request: body.portal[0] };
}

/** A world with an open channel and its welcome thread: `{ …world, channel, thread, root }`. */
async function openedWorld() {
  const w = await asked();
  const res = await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', {
    id: w.request.id, team: 'edge', name: 'Customer Inc', welcome: 'Welcome, Customer Inc!',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await w.pump();
  return {
    ...w, channel: res.body.channel.channelId, thread: res.body.thread, root: res.body.welcome.id,
  };
}

describe('the portal as a source', () => {
  it('is a platform of the inbox', () => {
    assert.ok(PLATFORMS.includes('portal'));
    assert.equal(platformName('portal'), 'Customer Portal');
    // Files go there through its Worker, as the person and as the app.
    assert.equal(personRule('portal').count, 10);
    assert.equal(appRule('portal').other, true);
  });

  it('keys an event by the portal\'s number for it, so one delivered twice is one', async () => {
    const event = {
      portal: 'test', seq: 7, at: '2026-11-17T10:00:00.500Z', type: 'message', domain: DOMAIN, channel: { id: 'c1' }, message: { id: 'm1' },
    };
    assert.equal(portalKey(event), 'portal/customer.example/c1/2026/11/17/1794909600500-test-7.json');
    assert.equal(portalKey({ ...event, type: 'lobby', channel: undefined }), 'portal/customer.example/_lobby/2026/11/17/1794909600500-test-7.json');
    for (const bad of [{ ...event, type: 'nope' }, { ...event, domain: '../x' }, { ...event, seq: 'x' }, { ...event, at: 'x' }, { ...event, channel: {} }, null]) {
      assert.equal(portalKey(bad), null);
    }
    const { inbox } = world();
    const stored = await quiet(() => receive(inbox, [event, event, { type: 'nope' }]));
    assert.deepEqual(stored, { ok: true, stored: 2, skipped: 1 });
    assert.equal(inbox.RAW.objects.size, 1);
    assert.deepEqual(inbox.queued.map((q) => q.key), [portalKey(event), portalKey(event)]);
  });

  it('reads a message, a deletion, a reaction, a channel and a lobby from the portal\'s events', () => {
    const base = {
      portal: 'test', seq: 3, at: '2026-11-17T10:00:00Z', domain: DOMAIN, channel: { id: 'c1', name: 'customer', company: 'Customer Inc' },
    };
    const author = {
      id: 'u1', name: 'Cy', email: CY, kind: 'customer',
    };
    const message = {
      id: 'm2', root: 'm1', rev: 0, at: '2026-11-17T10:00:00Z', text: 'Hello', permalink: 'https://portal.example/?c=c1&t=m1#m2',
    };
    const up = normalize('portal/customer.example/c1/k.json', {
      ...base, type: 'message', author, message,
    });
    assert.equal(up.op, 'upsert');
    assert.equal(up.message.thread, 'portal:customer.example:c1:m1');
    assert.deepEqual(up.message.authorRef, {
      source: 'portal', tenant: DOMAIN, userId: 'u1', name: 'Cy', email: CY, avatar: '',
    });
    assert.deepEqual(up.message.channelHint, { name: 'customer', topic: null, company: 'Customer Inc' });
    assert.equal(up.message.format, 'portal');
    const edited = normalize('portal/x', {
      ...base, type: 'message', author, message: { ...message, rev: 1, editedAt: '2026-11-17T11:00:00Z' },
    });
    assert.ok(edited.message.version > up.message.version);
    const gone = normalize('portal/x', {
      ...base,
      type: 'message',
      author,
      message: {
        ...message, rev: 2, editedAt: '2026-11-17T11:00:00Z', deletedAt: '2026-11-17T12:00:00Z',
      },
    });
    assert.equal(gone.op, 'delete');
    assert.ok(gone.message.version > edited.message.version);
    const bot = normalize('portal/x', {
      ...base, type: 'message', author: { id: 'b1', name: 'Enterprise Support', kind: 'bot' }, message,
    });
    assert.deepEqual(bot.message.authorRef, {
      kind: 'bot', name: 'Enterprise Support', source: 'portal', tenant: DOMAIN, botId: 'b1',
    });
    const reaction = normalize('portal/x', {
      ...base,
      type: 'reaction',
      author,
      reaction: {
        message: 'm1', root: 'm1', emoji: '✅', removed: false, at: '2026-11-17T10:05:00Z',
      },
    });
    assert.equal(reaction.op, 'reaction');
    assert.deepEqual([reaction.reaction.id, reaction.reaction.emoji, reaction.reaction.userId, reaction.reaction.channelId], ['m1', '✅', 'u1', 'c1']);
    assert.equal(normalize('portal/x', { ...base, type: 'channel' }).op, 'channel');
    const lobby = normalize('portal/x', { ...base, type: 'lobby', lobby: { status: 'requested', tech: ['eds'] } });
    assert.deepEqual(lobby, {
      op: 'lobby',
      lobby: {
        status: 'requested', tech: ['eds'], domain: DOMAIN, portal: 'test', seq: 3, at: base.at,
      },
    });
    assert.equal(normalize('portal/x', { ...base, type: 'other' }).op, 'skip');
  });

  it('keeps a message\'s markdown as typed, but for images, which become links', () => {
    const typed = 'Hello *there*,\nsee foo_bar and <b>this</b>.\n\n- one\n- two';
    assert.equal(portalMarkdown(typed), typed);
    assert.equal(portalMarkdown('Look: ![a pixel](https://tracker.example/p.png) ok'), 'Look: [a pixel](https://tracker.example/p.png) ok');
    assert.equal(portalMarkdown('![](https://tracker.example/p.png)'), '[https://tracker.example/p.png](https://tracker.example/p.png)');
    assert.equal(portalMarkdown('not an image: `![x](y)`'), 'not an image: `![x](y)`');
  });

  it('has the portal\'s files only: a link a customer typed is not one the app fetches', () => {
    const slack = '[report](https://files.slack.com/files-pri/T1-F0SECRET1/report.pdf)';
    const own = '[log.txt](https://portal.example/api/file/f0123456789abcdef/log.txt)';
    const there = {
      id: 'm1', source: 'portal', thread: 'portal:customer.example:c1:m1', at: '2026-11-17T10:00:00Z',
    };
    const elsewhere = {
      id: '1.1', source: 'slack', thread: 'slack:E1:C1:1.1', at: '2026-11-17T10:00:00Z',
    };
    // A Slack file named in a portal message is text; the portal's own file is a file.
    assert.deepEqual(threadFiles([{ ...there, body: slack }]), []);
    assert.deepEqual(threadFiles([{ ...there, body: own }]).map((f) => [f.source, f.id, f.name]), [['portal', 'f0123456789abcdef', 'log.txt']]);
    // And the other way: a link to a portal file posted in Slack opens nothing.
    assert.deepEqual(threadFiles([{ ...elsewhere, body: own }]), []);
    assert.equal(threadFiles([{ ...elsewhere, body: slack }]).length, 1);
    // A portal message is one by its thread's key too, where its source is not said.
    assert.deepEqual(threadFiles([{ ...there, source: undefined, body: slack }]), []);
  });

  it('answers without the portal when its Worker is not bound', async () => {
    const { inbox } = world({ bound: false });
    assert.deepEqual(await portalCall(inbox, 'post', {}), { error: 'the customer portal is not connected here', status: 409 });
    inbox.PORTAL = { post: () => Promise.reject(new Error('gone')) };
    const res = await quiet(() => portalCall(inbox, 'post', {}));
    assert.equal(res.unknown, true);
  });

  it('offers the portal the tech stack\'s entries marked for it', async () => {
    const { inbox } = world();
    const tech = await portalTechnologies(inbox);
    assert.ok(tech.some((t) => t.tech === 'eds' && t.product === 'Experience Manager Sites'));
    // Nothing the customer does not have from Adobe.
    assert.ok(!tech.some((t) => ['akamai', 'github', 'sharepoint'].includes(t.tech)));
    inbox.DB.sqlite.prepare("UPDATE tech_stack SET enabled = 0 WHERE tech = 'eds'").run();
    assert.ok(!(await portalTechnologies(inbox)).some((t) => t.tech === 'eds'));
  });
});

describe('portal requests', () => {
  it('reach the admin team, and the managers of a team that follows what was picked', async () => {
    const w = await asked();
    assert.deepEqual(w.results.map((r) => r.result), ['lobby']);
    const r = w.request;
    assert.equal(r.domain, DOMAIN);
    assert.equal(r.company, 'Customer Inc');
    assert.equal(r.status, 'open');
    assert.equal(r.note, 'We migrate.');
    assert.deepEqual(r.tech, [{ tech: 'eds', name: 'Edge Delivery' }, { tech: 'da', name: 'Document Authoring' }]);
    assert.deepEqual(r.members.map((m) => [m.email, m.joined]), [[CY, true], [DEE, false]]);
    assert.deepEqual(r.requestedBy, { email: CY, name: 'Cy' });
    assert.deepEqual(r.teams, [{ team: 'edge', name: 'Edge ops', tech: ['eds'] }]);
    assert.deepEqual(r.suggest, {
      name: 'customer-inc', org: 'customer-inc', orgName: 'Customer Inc', known: false,
    });
    // They count on Requests, for the admin team and for that team's managers.
    assert.equal((await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests?count=1')).body.open, 1);
    const mine = await w.staff(viewer(MANAGER, 'manager'), 'GET', '/api/admin/requests');
    assert.deepEqual(mine.body.portal.map((x) => x.domain), [DOMAIN]);
    assert.equal(mine.body.open, 1);
    const theirs = await w.staff(viewer(OTHER, 'manager'), 'GET', '/api/admin/requests');
    assert.deepEqual(theirs.body.portal, []);
    assert.equal(theirs.body.open, 0);
    // And on the team's page.
    const page = await w.staff(viewer(MANAGER, 'manager'), 'GET', '/api/admin/team?slug=edge');
    assert.deepEqual(page.body.portal.map((x) => x.domain), [DOMAIN]);
    assert.equal(page.body.portalBound, true);
  });

  it('follow the lobby as it changes, and never an older event', async () => {
    const w = await asked();
    await w.customer(CY, 'PUT', '/api/lobby', { tech: ['da'] });
    await w.customer(DEE, 'GET', '/api/me');
    await w.pump();
    let [row] = (await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests')).body.portal;
    assert.deepEqual(row.tech.map((t) => t.tech), ['da']);
    assert.deepEqual(row.members.map((m) => m.joined), [true, true]);
    assert.deepEqual(row.teams, []);
    // A replay of an older event changes nothing.
    const old = await recordLobby(w.inbox, {
      portal: 'test', domain: DOMAIN, seq: 1, status: 'requested', tech: ['eds'], members: [],
    });
    assert.equal(old.result, 'unchanged');
    [row] = (await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests')).body.portal;
    assert.deepEqual(row.tech.map((t) => t.tech), ['da']);
    assert.equal((await recordLobby(w.inbox, { domain: DOMAIN, status: 'draft' })).result, 'skip');
  });

  it('are declined by the admin team, with a reason the customer reads, and asked again', async () => {
    const w = await asked();
    const no = await w.staff(viewer(MANAGER, 'manager'), 'POST', '/api/admin/portal/decline', { id: w.request.id });
    assert.equal(no.status, 403);
    const res = await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/decline', { id: w.request.id, reason: 'You have a Slack channel.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'declined');
    assert.deepEqual(res.body.request.decidedBy, { email: ADMIN.email, name: ADMIN.name });
    assert.equal((await w.customer(CY, 'GET', '/api/me')).body.lobby.reason, 'You have a Slack channel.');
    assert.equal((await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/decline', { id: w.request.id })).status, 409);
    // A declined lobby gets no channel until it asks again.
    assert.equal((await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', { id: w.request.id, team: 'edge' })).status, 409);
    await w.pump();
    await w.customer(CY, 'POST', '/api/lobby/request', {});
    await w.pump();
    const [row] = (await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests')).body.portal;
    assert.equal(row.status, 'open');
    assert.equal(row.reason, null);
    assert.equal(row.decidedBy, null);
  });

  it('cannot be opened where the portal is not connected', async () => {
    const w = await asked({ bound: false });
    const res = await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', { id: w.request.id, team: 'edge' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /not connected/);
    assert.equal((await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests')).body.portalBound, false);
  });

  it('are opened by a manager only for a team of theirs that follows what was picked', async () => {
    const w = await asked();
    // Not their team; not a team that follows any of it.
    assert.equal((await w.staff(viewer(OTHER, 'manager'), 'POST', '/api/admin/portal/open', { id: w.request.id, team: 'edge' })).status, 403);
    const res = await w.staff(viewer(OTHER, 'manager'), 'POST', '/api/admin/portal/open', { id: w.request.id, team: 'helix' });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /follows none/);
    assert.equal((await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', { id: w.request.id, team: 'nope' })).status, 400);
    assert.equal((await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', { id: 99, team: 'edge' })).status, 404);
    // Theirs: filed under their team and the customer the inbox suggests, whatever they say.
    const ok = await w.staff(viewer(MANAGER, 'manager'), 'POST', '/api/admin/portal/open', {
      id: w.request.id, team: 'edge', org: 'somebody-else', share: ['helix'], welcome: 'Hello!',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.channel.team, ok.body.channel.org, ok.body.shared], ['edge', 'customer-inc', []]);
  });
});

describe('a portal channel in the inbox', () => {
  it('is opened for the lobby: filed by hand, shared, with its welcome thread', async () => {
    const w = await asked();
    const res = await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', {
      id: w.request.id, team: 'edge', name: 'Customer Inc', org: 'customer', share: ['helix', 'edge', 'nope'], welcome: 'Welcome, Customer Inc!',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { channel, request, thread } = res.body;
    assert.deepEqual([channel.name, channel.team, channel.org, res.body.shared], ['customer-inc', 'edge', 'customer', ['helix']]);
    assert.equal(request.status, 'opened');
    assert.deepEqual(request.channel, {
      source: 'portal', tenant: DOMAIN, channelId: channel.channelId, team: 'edge', org: 'customer',
    });
    assert.equal(thread, `portal:${DOMAIN}:${channel.channelId}:${res.body.welcome.id}`);
    // The customer has the channel, with the welcome in it.
    const me = await w.customer(DEE, 'GET', '/api/me');
    assert.deepEqual(me.body.channels.map((c) => c.name), ['customer-inc']);
    // In the inbox: the channel, its two rules, its share, and the customer.
    const rules = w.inbox.DB.rows('SELECT target, source, field, pattern, value, priority FROM rules ORDER BY target');
    assert.deepEqual(rules, [
      {
        target: 'org', source: 'portal', field: 'channel_id', pattern: `^${channel.channelId}$`, value: 'customer', priority: 10,
      },
      {
        target: 'team', source: 'portal', field: 'channel_id', pattern: `^${channel.channelId}$`, value: 'edge', priority: 10,
      },
    ]);
    assert.deepEqual(w.inbox.DB.rows('SELECT source, channel_id, team FROM channel_teams'), [{ source: 'portal', channel_id: channel.channelId, team: 'helix' }]);
    assert.deepEqual(w.inbox.DB.rows('SELECT slug, name, icon, type FROM orgs'), [{
      slug: 'customer', name: 'Customer Inc', icon: DOMAIN, type: 'customer',
    }]);
    await w.pump();
    // The welcome came back through the portal's events, as its author's: Adobe staff.
    const [t] = w.inbox.DB.rows('SELECT thread, source, tenant, channel_id, org, team, kind, channel_name FROM threads');
    assert.deepEqual(t, {
      thread, source: 'portal', tenant: DOMAIN, channel_id: channel.channelId, org: 'customer', team: 'edge', kind: 'channel', channel_name: 'customer-inc',
    });
    const [m] = w.inbox.DB.rows('SELECT author, person, staff, counted FROM messages');
    assert.deepEqual(m, {
      author: 'Ada Admin', person: 1, staff: 1, counted: 1,
    });
    const [c] = w.inbox.DB.rows("SELECT name, group_id, group_name, shared FROM channels WHERE source = 'portal'");
    assert.deepEqual(c, {
      name: 'customer-inc', group_id: DOMAIN, group_name: 'Customer Inc', shared: 1,
    });
    // It is in the inbox of the team it is filed under, and of the one it is shared with.
    for (const [who, team] of [[MANAGER, 'edge'], [OTHER, 'helix']]) {
      // eslint-disable-next-line no-await-in-loop
      const inboxOf = await w.staff(viewer(who), 'GET', `/api/inbox?team=${team}`);
      assert.deepEqual(inboxOf.body.threads.map((x) => x.thread), [thread], team);
    }
    // A lobby with a channel can get another.
    const more = await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', { id: w.request.id, team: 'helix', name: 'second' });
    assert.equal(more.status, 200);
    assert.equal((await w.customer(CY, 'GET', '/api/me')).body.channels.length, 2);
  });

  it('files what the customer and Adobe write, edit, delete and react with', async () => {
    const w = await openedWorld();
    const { channel, thread, root } = w;
    const reply = await w.customer(CY, 'POST', '/api/post', { channel, thread: root, text: 'Thanks! ![logo](https://tracker.example/x.png)' });
    await w.pump();
    const [{ path }] = w.inbox.DB.rows('SELECT path FROM threads');
    assert.equal(path, `channels/customer-inc/edge/portal-${channel}/${root}/`);
    const file = parse(w.inbox.CHANNELS.objects.get(`${path}${reply.body.id}.md`).body);
    assert.deepEqual(file.meta.author, {
      kind: 'person', name: 'Cy', org: DOMAIN, staff: false,
    });
    assert.equal(file.meta.source, 'portal');
    // The portal is its customers': the inbox keeps no link nobody of it could open.
    assert.equal(file.meta.permalink, undefined);
    assert.equal(file.body.trim(), 'Thanks! [logo](https://tracker.example/x.png)');
    const identity = w.inbox.DB.rows("SELECT name, email, kind, person FROM identities WHERE source = 'portal' AND user_id = ?", await portalUserId(CY))[0];
    assert.deepEqual(identity, {
      name: 'Cy', email: CY, kind: 'person', person: null,
    });
    // The customer's message makes the thread wait on Adobe.
    assert.deepEqual(w.inbox.DB.rows('SELECT messages, last_staff FROM threads'), [{ messages: 2, last_staff: 0 }]);

    // Adobe replies from the inbox, as the person: it is in the portal, and comes back.
    const answer = await w.staff(viewer(MANAGER), 'POST', '/api/post', { thread, text: 'Glad to help :tada:' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.platform, 'portal');
    assert.equal(answer.body.text, 'Glad to help 🎉');
    let seen = (await w.customer(CY, 'GET', `/api/thread?channel=${channel}&thread=${root}`)).body.thread;
    assert.deepEqual(seen.messages.map((x) => [x.author.name, x.author.kind]), [['Ada Admin', 'staff'], ['Cy', 'customer'], ['Max Manager', 'staff']]);
    await w.pump();
    assert.deepEqual(w.inbox.DB.rows('SELECT author, person, staff FROM messages ORDER BY at, id').map((x) => [x.author, x.person, x.staff]), [['Ada Admin', 1, 1], ['Cy', null, 0], ['Max Manager', 2, 1]]);
    // Files do not go to the portal, and somebody outside the thread's teams posts nothing.
    assert.equal((await w.staff(viewer(OTHER), 'POST', '/api/post', { thread, text: 'hi' })).status, 404);

    // The customer edits, then deletes: the file follows, and ends as a tombstone.
    await w.customer(CY, 'POST', '/api/edit', { channel, id: reply.body.id, text: 'Thanks a lot!' });
    await w.pump();
    let again = parse(w.inbox.CHANNELS.objects.get(`${path}${reply.body.id}.md`).body);
    assert.equal(again.body.trim(), 'Thanks a lot!');
    assert.ok(again.meta.editedAt);
    await w.customer(CY, 'POST', '/api/delete', { channel, id: reply.body.id });
    await w.pump();
    again = parse(w.inbox.CHANNELS.objects.get(`${path}${reply.body.id}.md`).body);
    assert.ok(again.meta.deletedAt);
    assert.equal(again.body.trim(), '');

    // Adobe resolves it: ✅ on the first message, as the person, which the customer sees.
    const resolved = await w.staff(viewer(MANAGER), 'POST', '/api/resolve', { thread });
    assert.deepEqual(resolved.body, { ok: true, resolved: true });
    seen = (await w.customer(CY, 'GET', `/api/thread?channel=${channel}&thread=${root}`)).body.thread;
    assert.equal(seen.resolved, true);
    const key = `portal:${DOMAIN}:${await portalUserId(MANAGER.email)}`;
    assert.deepEqual(w.inbox.DB.rows('SELECT emoji, user_key FROM reactions'), [{ emoji: '✅', user_key: key }]);
    // The portal's own event of it changes nothing; the customer's 👍 is recorded as theirs.
    await w.customer(DEE, 'GET', '/api/me');
    await w.customer(DEE, 'POST', '/api/react', { channel, id: root, emoji: '👍' });
    await w.pump();
    assert.deepEqual(w.inbox.DB.rows('SELECT emoji, user_key FROM reactions ORDER BY emoji'), [
      { emoji: '✅', user_key: key },
      { emoji: '👍', user_key: `portal:${DOMAIN}:${await portalUserId(DEE)}` },
    ]);
    assert.equal(w.inbox.DB.rows("SELECT name FROM identities WHERE source = 'portal' AND email = ?", DEE)[0].name, 'Dee');
    const undone = await w.staff(viewer(MANAGER), 'POST', '/api/resolve', { thread, undo: true });
    assert.deepEqual(undone.body, { ok: true, resolved: false });
    seen = (await w.customer(CY, 'GET', `/api/thread?channel=${channel}&thread=${root}`)).body.thread;
    assert.equal(seen.resolved, false);

    // A person edits their own message from the inbox, and nobody else's.
    const mine = w.inbox.DB.rows("SELECT id FROM messages WHERE author = 'Max Manager'")[0].id;
    const edit = await w.staff(viewer(MANAGER), 'POST', '/api/edit', { thread, id: mine, text: 'Glad to help, always.' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal((await w.staff(viewer(MANAGER), 'POST', '/api/edit', { thread, id: root, text: 'x' })).status, 403);
    seen = (await w.customer(CY, 'GET', `/api/thread?channel=${channel}&thread=${root}`)).body.thread;
    assert.equal(seen.messages.at(-1).body, 'Glad to help, always.');
  });

  it('starts a thread in the channel from the inbox, and lists it where threads start', async () => {
    const w = await openedWorld();
    const ref = `portal:${DOMAIN}:${w.channel}`;
    const { body: { channels } } = await w.staff(viewer(MANAGER), 'GET', '/api/channels');
    assert.deepEqual(channels.map((c) => [c.ref, c.source, c.name, c.org]), [[ref, 'portal', 'customer-inc', 'customer-inc']]);
    const res = await w.staff(viewer(MANAGER), 'POST', '/api/post', { channel: ref, text: 'Maintenance on Friday' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.thread, `${ref}:${res.body.id}`);
    await w.pump();
    assert.deepEqual(w.inbox.DB.rows('SELECT thread FROM threads ORDER BY root_at').map((t) => t.thread), [w.thread, res.body.thread]);
    const { body: { threads } } = await w.customer(CY, 'GET', `/api/threads?channel=${w.channel}`);
    assert.deepEqual(threads.map((t) => t.title), ['Maintenance on Friday', 'Welcome, Customer Inc!']);
    // A reply in it before the inbox has it names its root, which is a portal message id.
    assert.equal((await w.staff(viewer(MANAGER), 'POST', '/api/post', { channel: ref, root: '1.1', text: 'x' })).status, 400);
    assert.equal((await w.staff(viewer(MANAGER), 'POST', '/api/post', { channel: ref, root: res.body.id, text: 'More on it' })).status, 200);
  });

  it('tells a person what they may do there without connecting anything', async () => {
    const w = await openedWorld();
    const me = (await w.staff(viewer(MANAGER), 'GET', '/api/me')).body;
    assert.equal(me.connected.portal, true);
    assert.equal(me.react.portal, true);
    assert.equal(me.edit.portal, true);
    assert.equal(me.attach.portal.count, 10);
    const none = world({ bound: false });
    const without = (await none.staff(viewer(MANAGER), 'GET', '/api/me')).body;
    assert.equal(without.connected.portal, undefined);
  });

  it('posts and reacts there as the inbox\'s app', async () => {
    const w = await openedWorld();
    const sent = await postAsApp(w.inbox, w.thread, 'An answer from the agent.');
    assert.deepEqual([sent.ok, sent.platform], [true, 'portal']);
    const reacted = await reactAsApp(w.inbox, w.thread, w.root, '🎉');
    assert.deepEqual(reacted, { ok: true, platform: 'portal', emoji: '🎉' });
    await w.pump();
    const [bot] = w.inbox.DB.rows('SELECT author, person, staff, counted FROM messages WHERE id = ?', sent.id);
    assert.deepEqual(bot, {
      author: 'Enterprise Support', person: null, staff: 0, counted: 0,
    });
    const seen = (await w.customer(CY, 'GET', `/api/thread?channel=${w.channel}&thread=${w.root}`)).body.thread;
    assert.deepEqual(seen.messages.map((m) => m.author.kind), ['staff', 'bot']);
    assert.deepEqual(seen.messages[0].reactions.map((r) => r.emoji), ['🎉']);
    // With a file, which the customer finds under the message.
    const withFile = await postAsApp(w.inbox, w.thread, 'The log.', {
      files: [{ name: 'run.log', type: 'text/plain', bytes: new TextEncoder().encode('ok\n') }],
    });
    assert.equal(withFile.ok, true);
    const again = (await w.customer(CY, 'GET', `/api/thread?channel=${w.channel}&thread=${w.root}`)).body.thread;
    assert.deepEqual(again.messages.at(-1).files.map((f) => [f.name, f.type, f.size]), [['run.log', 'text/plain', 3]]);
  });

  it('asks the portal for a thread it has a reply of, but not the start', async () => {
    const w = await openedWorld();
    const reply = await w.customer(CY, 'POST', '/api/post', { channel: w.channel, thread: w.root, text: 'A reply' });
    // The inbox lost the thread's first message, and the reply arrives.
    w.inbox.DB.sqlite.exec('DELETE FROM messages; DELETE FROM threads;');
    await w.pump();
    assert.ok(w.results.some((r) => r.result === 'backfilled' && r.messages === 2));
    assert.deepEqual(w.inbox.DB.rows('SELECT id FROM messages ORDER BY at, id').map((m) => m.id).sort(), [w.root, reply.body.id].sort());
  });

  it('is rebuilt from pile 1 in any order, to the same pile 2', async () => {
    const w = await openedWorld();
    const reply = await w.customer(CY, 'POST', '/api/post', { channel: w.channel, thread: w.root, text: 'First' });
    await w.customer(CY, 'POST', '/api/edit', { channel: w.channel, id: reply.body.id, text: 'Second' });
    await w.pump();
    const before = [...w.inbox.CHANNELS.objects].map(([k, o]) => [k, parse(o.body).body]);
    const keys = [...w.inbox.RAW.objects.keys()].reverse();
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await processKey(w.inbox, key, {});
    }
    const after = [...w.inbox.CHANNELS.objects].map(([k, o]) => [k, parse(o.body).body]);
    assert.deepEqual(after, before);
    assert.equal(parse(w.inbox.CHANNELS.objects.get(`channels/customer-inc/edge/portal-${w.channel}/${w.root}/${reply.body.id}.md`).body).body.trim(), 'Second');
  });
});

/** The start of a PNG of `w` by `h`: enough for its size to be read. */
function pngOf(w, h) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const text = (s) => new TextEncoder().encode(s);

describe('files, mentions and pictures between the portal and the inbox', () => {
  it('files a customer\'s attachments, shows them through the portal, and sends files back', async () => {
    const w = await openedWorld();
    const { channel, thread, root } = w;
    const up = async (name, type, bytes) => (await (await w.customerRaw(CY, 'POST', `/api/upload?channel=${channel}&name=${encodeURIComponent(name)}`, { bytes, type })).json()).file;
    const shot = await up('shot (1).png', 'image/png', pngOf(640, 480));
    const csv = await up('rows.csv', 'text/csv', text('a,b\n1,2\n'));
    assert.deepEqual([shot.width, shot.height, shot.size], [640, 480, 40]);
    const sent = await w.customer(CY, 'POST', '/api/post', { channel, thread: root, files: [shot.id, csv.id] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await w.pump();

    // Pile 2: the files as every platform's are, linked to the portal.
    const [{ path }] = w.inbox.DB.rows('SELECT path FROM threads');
    const { body } = parse(w.inbox.CHANNELS.objects.get(`${path}${sent.body.id}.md`).body);
    const image = `https://portal.example/api/file/${shot.id}/shot%20%281%29.png`;
    const table = `https://portal.example/api/file/${csv.id}/rows.csv`;
    assert.equal(body.trim(), `Attachments:\n![shot (1).png](${image} "640x480")\n\n- [rows.csv](${table})`);
    assert.equal(w.inbox.DB.rows('SELECT attachments FROM messages WHERE id = ?', sent.body.id)[0].attachments, 2);

    // The inbox shows the image through the portal's Worker, for the thread's people only.
    const t = encodeURIComponent(thread);
    const media = await w.staffRaw(viewer(MANAGER), `/api/media?t=${t}&u=${encodeURIComponent(image)}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal((await media.arrayBuffer()).byteLength, 40);
    assert.equal((await w.staffRaw(viewer(OTHER), `/api/media?t=${t}&u=${encodeURIComponent(image)}`)).status, 404);
    // Without its thread, a portal address is nobody's attachment.
    assert.equal((await w.staffRaw(viewer(MANAGER), `/api/media?u=${encodeURIComponent(image)}`)).status, 400);
    // The other file is a download, and its text can be previewed.
    const open = await w.staffRaw(viewer(MANAGER), `/api/file/open?t=${t}&u=${encodeURIComponent(table)}`);
    assert.equal(open.status, 200);
    assert.equal(open.headers.get('content-type'), 'application/octet-stream');
    assert.match(open.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''rows\.csv$/);
    assert.equal(await open.text(), 'a,b\n1,2\n');
    const preview = await w.staffRaw(viewer(MANAGER), `/api/file?t=${t}&u=${encodeURIComponent(table)}`);
    assert.equal(await preview.text(), 'a,b\n1,2\n');
    // A file that is not one of the thread's messages opens nothing, whatever its address says.
    const other = 'https://portal.example/api/file/f0000000000000000/rows.csv';
    assert.equal((await w.staffRaw(viewer(MANAGER), `/api/file/open?t=${t}&u=${encodeURIComponent(other)}`)).status, 404);
    assert.equal((await w.staffRaw(viewer(MANAGER), `/api/media?t=${t}&u=${encodeURIComponent(other)}`)).status, 502);

    // Adobe answers with a file of its own: uploaded to the portal, then posted.
    const form = new FormData();
    form.append('payload', JSON.stringify({ thread, text: 'Fixed in this one.' }));
    form.append('files', new File([pngOf(20, 10)], 'fix.png', { type: 'image/png' }));
    const reply = await w.staffRaw(viewer(MANAGER), '/api/post', { method: 'POST', body: form });
    assert.equal(reply.status, 200, JSON.stringify(await reply.clone().json()));
    const seen = (await w.customer(CY, 'GET', `/api/thread?channel=${channel}&thread=${root}`)).body.thread;
    const [file] = seen.messages.at(-1).files;
    assert.deepEqual([file.name, file.type, file.width, file.height], ['fix.png', 'image/png', 20, 10]);
    const got = await w.customerRaw(CY, 'GET', file.url);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal((await got.arrayBuffer()).byteLength, 40);
    // And it comes back to the inbox as the person's message, with its file.
    await w.pump();
    const [mine] = w.inbox.DB.rows("SELECT id, attachments FROM messages WHERE author = 'Max Manager'");
    assert.equal(mine.attachments, 1);
  });

  it('knows whom a message mentions, on both sides', async () => {
    const w = await openedWorld();
    const { channel, thread, root } = w;
    // The people of the channel: the lobby's, and the Adobe people who wrote there.
    const { body: { people } } = await w.customer(CY, 'GET', `/api/people?channel=${channel}`);
    assert.deepEqual(people.map((p) => [p.name, p.kind]), [['Cy', 'customer'], ['Ada Admin', 'staff']]);
    await w.customer(CY, 'POST', '/api/post', { channel, thread: root, text: 'Could you look, @Ada Admin? And @Nobody Here.' });
    await w.pump();
    assert.deepEqual(w.inbox.DB.rows('SELECT person, via FROM mentions'), [{ person: 1, via: 'id' }]);

    // Adobe mentions a customer by name: theirs in the portal, where the thread says so.
    await w.customer(DEE, 'GET', '/api/me');
    const sent = await w.staff(viewer(MANAGER), 'POST', '/api/post', { thread, text: 'Yes. @Dee, is it the same for you?' });
    assert.equal(sent.status, 200);
    const { body: { threads } } = await w.customer(DEE, 'GET', `/api/threads?channel=${channel}`);
    assert.equal(threads[0].mentioned, true);
    assert.equal((await w.customer(CY, 'GET', `/api/threads?channel=${channel}`)).body.threads[0].mentioned, false);
    const seen = (await w.customer(DEE, 'GET', `/api/thread?channel=${channel}&thread=${root}`)).body.thread;
    assert.deepEqual(seen.messages.map((m) => m.mentionsMe), [false, false, true]);
    // Read, it mentions nobody anew.
    assert.equal((await w.customer(DEE, 'GET', `/api/threads?channel=${channel}`)).body.threads[0].mentioned, false);
    // The lobby's people are accounts in the inbox, so a reply can name one who never wrote.
    await w.pump();
    const names = w.inbox.DB.rows("SELECT name FROM identities WHERE source = 'portal' AND tenant = ? ORDER BY name", DOMAIN).map((r) => r.name);
    assert.deepEqual(names, ['Ada Admin', 'Cy', 'Dee', 'Max Manager']);
  });

  it('shows people\'s pictures: a customer\'s in the inbox, Adobe\'s in the portal', async () => {
    const w = await openedWorld();
    const { channel, thread, root } = w;
    // A customer uploads a picture; their next message carries it to the inbox.
    const put = await w.customerRaw(CY, 'PUT', '/api/avatar', { bytes: pngOf(256, 256), type: 'image/png' });
    const { avatar } = await put.json();
    assert.match(avatar, /^\/api\/avatar\/u[0-9a-f]{20}\?v=\w+$/);
    await w.customer(CY, 'POST', '/api/post', { channel, thread: root, text: 'Hello' });
    await w.pump();
    const cy = await portalUserId(CY);
    const [identity] = w.inbox.DB.rows("SELECT avatar FROM identities WHERE source = 'portal' AND user_id = ?", cy);
    assert.match(identity.avatar, new RegExp(`^/api/portal/avatar/${cy}\\?v=\\w+$`));
    const shown = await w.staffRaw(viewer(MANAGER), identity.avatar);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.equal((await w.staffRaw(viewer(MANAGER), `/api/portal/avatar/${await portalUserId(DEE)}`)).status, 404);
    // Taken away again, their Gravatar's stands in with their next message.
    await w.customer(CY, 'DELETE', '/api/avatar', {});
    await w.customer(CY, 'POST', '/api/post', { channel, thread: root, text: 'Again' });
    await w.pump();
    assert.match(w.inbox.DB.rows("SELECT avatar FROM identities WHERE source = 'portal' AND user_id = ?", cy)[0].avatar, /^https:\/\/gravatar\.com\/avatar\//);

    // Adobe's people have the picture the inbox knows of them, which the portal fetches itself.
    w.inbox.DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email,
      person, fetched_at, avatar) VALUES ('slack', 'E1', 'U2', 'person', 'Max Manager', ?, 2,
      '2026-11-17T00:00:00Z', 'https://avatars.example/max.png')`).run(MANAGER.email);
    await w.staff(viewer(MANAGER), 'POST', '/api/post', { thread, text: 'Hi' });
    const max = await portalUserId(MANAGER.email);
    assert.equal(w.portal.DB.rows('SELECT avatar FROM users WHERE id = ?', max)[0].avatar, 'https://avatars.example/max.png');
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return new Response(pngOf(48, 48), { headers: { 'content-type': 'image/png' } });
    };
    try {
      const face = await w.customerRaw(CY, 'GET', `/api/avatar/${max}`);
      assert.equal(face.status, 200);
      assert.equal(face.headers.get('content-type'), 'image/png');
      assert.deepEqual(fetched, ['https://avatars.example/max.png']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('shows a customer\'s logo on its request, and as the icon of a customer it had not met', async () => {
    const w = await asked();
    w.inbox.PUBLIC_ORIGIN = 'https://opspile.example/';
    const put = await w.customerRaw(CY, 'PUT', '/api/logo', { bytes: pngOf(128, 64), type: 'image/png' });
    assert.match((await put.json()).lobby.logo, /^\/api\/logo\?v=\w+$/);
    await w.pump();
    const [request] = (await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests')).body.portal;
    assert.match(request.logo, /^\/api\/portal\/logo\/customer\.example\?v=\w+$/);
    const shown = await w.staffRaw(viewer(ADMIN), request.logo);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.equal((await w.staffRaw(viewer(ADMIN), '/api/portal/logo/nobody.example')).status, 404);
    await w.staff(viewer(ADMIN), 'POST', '/api/admin/portal/open', { id: request.id, team: 'edge' });
    assert.deepEqual(w.inbox.DB.rows('SELECT slug, icon FROM orgs'), [{
      slug: 'customer-inc', icon: 'https://opspile.example/api/portal/logo/customer.example',
    }]);
    // Removed, the request has none.
    await w.customer(CY, 'DELETE', '/api/logo', {});
    await w.pump();
    assert.equal((await w.staff(viewer(ADMIN), 'GET', '/api/admin/requests')).body.portal[0].logo, null);
  });
});

describe('Adobe\'s side of a thread, for the customer', () => {
  /** What the portal tells `email` of a thread, asked anew. */
  const statusOf = async (w, email, root) => {
    clearStatuses();
    const q = root ? `&thread=${root}` : '';
    return (await w.customer(email, 'GET', `/api/status?channel=${w.channel}${q}`)).body;
  };

  it('knows where a thread stands: who waits, since when, and after what', () => {
    const at = (minutes) => new Date(Date.UTC(2026, 10, 2, 9, minutes)).toISOString();
    const customer = (minutes) => ({ at: at(minutes), staff: 0, counted: 1 });
    const adobe = (minutes) => ({ at: at(minutes), staff: 1, counted: 1 });
    // Nobody at Adobe wrote yet: the customer waits since their first message.
    assert.deepEqual(standing([customer(0), customer(5)]), {
      asked: Date.parse(at(0)), gap: null, last: null,
    });
    // Adobe answered: nobody waits.
    assert.deepEqual(standing([customer(0), adobe(9)]), {
      asked: null, gap: null, last: Date.parse(at(9)),
    });
    // The customer wrote again four minutes after: a live conversation.
    assert.deepEqual(standing([customer(0), adobe(9), customer(13), customer(20)]), {
      asked: Date.parse(at(13)), gap: 4, last: Date.parse(at(9)),
    });
    // The inbox's app answers for Adobe too: its message is nobody's, and ends the wait.
    assert.equal(standing([customer(0), { at: at(3), staff: 0, counted: 0 }]).asked, null);
  });

  it('says how many at Adobe listen: the thread\'s teams\' people and its followers, once', async () => {
    const w = await openedWorld();
    clearWaitModel();
    // The channel is the edge team's, opened by an admin: Max is on it.
    assert.equal((await statusOf(w, CY, w.root)).listening, 1);
    // Shared with another team, its people listen too; someone who follows what the thread
    // shows as well, and someone on both counts once.
    w.inbox.DB.sqlite.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('portal', ?, 'helix', '2026-11-01T00:00:00Z')`).run(w.channel);
    assert.equal((await statusOf(w, CY, w.root)).listening, 2);
    w.inbox.DB.sqlite.prepare("INSERT INTO thread_tech (thread, tech, p) VALUES (?, 'eds', 0.9)").run(w.thread);
    w.inbox.DB.sqlite.prepare(`INSERT INTO person_follows (person, tech, added_at)
      VALUES (1, 'eds', '2026-11-01T00:00:00Z'), (3, 'eds', '2026-11-01T00:00:00Z')`).run();
    assert.equal((await statusOf(w, CY, w.root)).listening, 3);
    // The channel, for a thread about to be written: its teams, without a thread's followers.
    assert.equal((await statusOf(w, CY)).listening, 2);
    // A number, and nothing of who: no name, no team.
    const said = JSON.stringify(await statusOf(w, CY, w.root));
    assert.doesNotMatch(said, /Max|Olga|Ada|edge|helix/);
    // Not a channel of this customer's: nothing, and another domain's customer is not asked.
    assert.deepEqual(await portalStatus(w.inbox, { domain: 'elsewhere.example', channel: w.channel, root: w.root }), {
      listening: 0, estimate: null, working: false, draft: false,
    });
  });

  it('estimates the next answer from how Adobe answered before, once someone waits', async () => {
    const w = await openedWorld();
    clearWaitModel();
    // Nothing to learn from yet: Adobe wrote first, nobody has waited.
    assert.equal((await statusOf(w, CY, w.root)).estimate, null);
    // Thirty conversations of the team's, each answered after about an hour.
    const insert = w.inbox.DB.sqlite.prepare(`INSERT INTO messages
      (source, tenant, channel_id, id, thread, at, author, staff, counted, deleted)
      VALUES ('portal', 'customer.example', ?1, ?2, ?3, ?4, 'x', ?5, 1, 0)`);
    const thread = w.inbox.DB.sqlite.prepare(`INSERT INTO threads
      (thread, source, tenant, channel_id, root_id, kind, org, team, path, updated_at)
      VALUES (?1, 'portal', 'customer.example', ?2, ?3, 'channel', 'customer-inc', 'edge', ?1, ?4)`);
    const now = Date.now();
    for (let i = 1; i <= 30; i += 1) {
      const began = now - i * 24 * 60 * 60 * 1000;
      const key = `portal:customer.example:${w.channel}:old${i}`;
      thread.run(key, w.channel, `old${i}`, new Date(began).toISOString());
      insert.run(w.channel, `q${i}`, key, new Date(began).toISOString(), 0);
      insert.run(w.channel, `a${i}`, key, new Date(began + 60 * 60 * 1000).toISOString(), 1);
    }
    clearWaitModel();
    // Adobe wrote last in the welcome thread: what a reply written now would wait.
    const idle = (await statusOf(w, CY, w.root)).estimate;
    assert.equal(idle.asked, null);
    assert.ok(idle.minutes > 5 && idle.minutes < 600, `a reply now: ${idle.minutes}`);
    // The customer asks: they wait since then.
    const reply = await w.customer(CY, 'POST', '/api/post', { channel: w.channel, thread: w.root, text: 'How long?' });
    await w.pump();
    const waiting = (await statusOf(w, CY, w.root)).estimate;
    assert.ok(Math.abs(Date.parse(waiting.asked) - Date.now()) < 60000, waiting.asked);
    assert.ok(Number.isInteger(waiting.minutes) && waiting.minutes > 5 && waiting.minutes < 600);
    assert.ok(reply.body.id);
    // A new thread in the channel has an estimate too.
    assert.ok((await statusOf(w, CY)).estimate.minutes > 5);
    // Adobe answers: nobody waits.
    await w.staff(viewer(MANAGER), 'POST', '/api/post', { thread: w.thread, text: 'Not long.' });
    await w.pump();
    assert.equal((await statusOf(w, CY, w.root)).estimate.asked, null);
  });

  it('fits the model once per isolate, then again behind an answer when it is an hour old', async () => {
    const w = await openedWorld();
    clearWaitModel();
    let reads = 0;
    const { prepare } = w.inbox.DB;
    w.inbox.DB.prepare = (sql) => {
      reads += /FROM messages x JOIN threads t/.test(sql) ? 1 : 0;
      return prepare.call(w.inbox.DB, sql);
    };
    const args = { domain: DOMAIN, channel: w.channel, root: w.root };
    const now = Date.now();
    const behind = [];
    const options = (at) => ({ now: at, waitUntil: (p) => behind.push(p) });
    // Two pages at once on a new isolate: one read.
    await Promise.all([
      portalStatus(w.inbox, args, options(now)), portalStatus(w.inbox, args, options(now)),
    ]);
    assert.deepEqual([reads, behind.length], [1, 0]);
    await portalStatus(w.inbox, args, options(now + 59 * 60 * 1000));
    assert.equal(reads, 1);
    // An hour on: answered with the model it has, the next one fitted behind the answer.
    await portalStatus(w.inbox, args, options(now + 61 * 60 * 1000));
    assert.equal(behind.length, 1);
    await Promise.all(behind);
    assert.equal(reads, 2);
    await portalStatus(w.inbox, args, options(now + 62 * 60 * 1000));
    assert.deepEqual([reads, behind.length], [2, 1]);
  });

  it('says when the agent works on the thread, or a draft waits, and nothing of what they say', async () => {
    const w = await openedWorld();
    clearWaitModel();
    await w.customer(CY, 'POST', '/api/post', { channel: w.channel, thread: w.root, text: 'Anyone?' });
    await w.pump();
    const idle = await statusOf(w, CY, w.root);
    assert.deepEqual([idle.working, idle.draft], [false, false]);
    const live = w.inbox.DB.sqlite.prepare(`INSERT INTO agent_live (thread, turn, at) VALUES (?1, ?2, ?3)
      ON CONFLICT (thread) DO UPDATE SET turn = excluded.turn, at = excluded.at`);
    const turn = (t) => live.run(w.thread, JSON.stringify(t), new Date().toISOString());
    turn({ state: 'working', text: 'Reading the secret runbook', startedAt: Date.now() });
    let said = await statusOf(w, CY, w.root);
    assert.equal(said.working, true);
    assert.doesNotMatch(JSON.stringify(said), /runbook/);
    // A sidebar message is the team's own: the customer hears nothing of it.
    turn({
      state: 'working', text: 'Looking', startedAt: Date.now(), sidebar: 'm1',
    });
    assert.equal((await statusOf(w, CY, w.root)).working, false);
    turn({
      state: 'done', text: 'Drafted', startedAt: Date.now(), endedAt: Date.now(),
    });
    assert.equal((await statusOf(w, CY, w.root)).working, false);
    // A draft, an agent's or a person's, while the customer waits.
    w.inbox.DB.sqlite.prepare(`INSERT INTO drafts (thread, body, person, created_at, updated_at)
      VALUES (?, 'An internal draft', 2, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')`).run(w.thread);
    said = await statusOf(w, CY, w.root);
    assert.equal(said.draft, true);
    assert.doesNotMatch(JSON.stringify(said), /internal/);
    // Once Adobe answered, a draft left behind is nobody's business.
    await w.staff(viewer(MANAGER), 'POST', '/api/post', { thread: w.thread, text: 'Here.' });
    await w.pump();
    assert.equal((await statusOf(w, CY, w.root)).draft, false);
  });

  it('shows who at Adobe is writing, for a few seconds, and that something is new', async () => {
    const w = await openedWorld();
    clearWaitModel();
    const before = await statusOf(w, CY, w.root);
    assert.deepEqual(before.typing, []);
    // Max types in the inbox: the portal is told, and Cy sees it.
    const typing = (me, thread = w.thread) => w.staffRaw(viewer(me), '/api/typing', {
      method: 'POST', body: JSON.stringify({ thread }),
    });
    assert.equal((await typing(MANAGER)).status, 204);
    assert.deepEqual((await statusOf(w, CY, w.root)).typing, ['Max Manager']);
    // Not somebody outside the thread's teams, and not in a thread that is not there.
    assert.equal((await typing(OTHER)).status, 404);
    assert.equal((await typing(MANAGER, 'portal:customer.example:nowhere:m0')).status, 404);
    // It is over after a few seconds without another word.
    w.portal.DB.sqlite.prepare("UPDATE typing SET at = '2026-01-01T00:00:00.000Z'").run();
    assert.deepEqual((await statusOf(w, CY, w.root)).typing, []);
    // And when their message arrives; the stamp says the thread changed.
    await typing(MANAGER);
    await w.staff(viewer(MANAGER), 'POST', '/api/post', { thread: w.thread, text: 'Here it is.' });
    const after = await statusOf(w, CY, w.root);
    assert.deepEqual(after.typing, []);
    assert.notEqual(after.stamp, before.stamp);
    // An edit and a reaction change it too, so the page loads the thread again.
    await w.customer(CY, 'POST', '/api/react', { channel: w.channel, id: w.root, emoji: '👍' });
    const reacted = await statusOf(w, CY, w.root);
    assert.notEqual(reacted.stamp, after.stamp);
    // Without the inbox, the portal still says what it knows itself.
    delete w.portal.OPSPILE.status;
    w.portal.OPSPILE = undefined;
    const alone = await statusOf(w, CY, w.root);
    assert.deepEqual([alone.listening, alone.typing, alone.stamp], [undefined, [], reacted.stamp]);
  });

  it('asks the inbox once in ten seconds for a thread, however many pages ask', async () => {
    const w = await openedWorld();
    clearStatuses();
    let calls = 0;
    w.portal.OPSPILE.status = async () => {
      calls += 1;
      return {
        listening: 4, estimate: { minutes: 12.4, asked: null }, working: true, draft: false, more: 'x',
      };
    };
    const get = () => w.customer(CY, 'GET', `/api/status?channel=${w.channel}&thread=${w.root}`);
    const first = (await get()).body;
    await get();
    await w.customer(DEE, 'GET', '/api/me');
    await w.customer(DEE, 'GET', `/api/status?channel=${w.channel}&thread=${w.root}`);
    assert.equal(calls, 1);
    // Only what the page shows comes through.
    assert.deepEqual([first.listening, first.estimate, first.working, first.draft, first.more], [
      4, { minutes: 12.4, asked: null }, true, false, undefined,
    ]);
    // An inbox that fails is no error of the page's.
    clearStatuses();
    w.portal.OPSPILE.status = () => Promise.reject(new Error('down'));
    const failed = await quiet(() => get());
    assert.equal(failed.status, 200);
    assert.equal(failed.body.listening, undefined);
  });
});
