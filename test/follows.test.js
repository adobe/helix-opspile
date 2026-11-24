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
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  api, inbox, searchInbox, thread,
} from '../src/api.js';
import { entryOf } from '../src/drafts.js';
import {
  entryFollowers, followable, followersOf, followingTeams, threadAreaStatements,
  threadTechStatements,
} from '../src/follows.js';
import { forgetTrends, suggestFollows } from '../src/followsuggest.js';
import {
  inPersonalInbox, mayPost, mayReply, mayWork, recipients, roomsOf, teamsOf,
} from '../src/shares.js';
import { accessibleRepos } from '../src/agent/repos.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up people, teams, channels and customers only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
};
const EW = {
  id: 2, email: 'ew@staff.example', name: 'Ew', staff: 1, teams: ['ew'],
};
const SOLO = {
  id: 3, email: 'solo@staff.example', name: 'Solo', staff: 1, teams: [],
};
const MANAGER = { ...EW, id: 4, email: 'lead@staff.example' };
const ADMIN = {
  id: 5, email: 'root@staff.example', name: 'Root', staff: 1, teams: ['admin'],
};
const asMe = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });

const AT = '2026-11-17T10:00:00Z';
const key = (channel, root) => `slack:E1:${channel}:${root}`;

/**
 * Helix holds C1 (acme) and C2 (globex); ew holds nothing. In C1, 1.1 shows Experience Workspace
 * (xw) and 2.1 nothing; in C2, 3.1 is the first of a group whose second post, 4.1, shows Document
 * Authoring (da). C3 is an alert channel whose thread shows xw too.
 */
function env() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }, { slug: 'ew', name: 'EW' }],
    people: [ADA, EW, SOLO, MANAGER, ADMIN],
  });
  DB.sqlite.exec(`UPDATE team_members SET role = 'manager' WHERE person = ${MANAGER.id}`);
  const row = (channel, root, { org = 'acme', kind = 'channel', group = null } = {}) => {
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, title, path, root_at, last_at, any_at, messages, updated_at, logical_thread)
      VALUES (?, 'slack', 'E1', ?, ?, ?, 'helix', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(
        key(channel, root),
        channel,
        root,
        org,
        kind,
        `aem-${org}`,
        `about ${root}`,
        `channels/${org}/helix/slack-${channel}/${root}/`,
        AT,
        AT,
        AT,
        AT,
        group,
      );
    DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
        counted, author_key) VALUES ('slack', 'E1', ?, ?, ?, ?, 0, 1, 'slack:E1:U9')`)
      .run(channel, root, key(channel, root), AT);
  };
  row('C1', '1.1');
  row('C1', '2.1');
  row('C2', '3.1', { org: 'globex' });
  row('C2', '4.1', { org: 'globex', group: key('C2', '3.1') });
  row('C3', '5.1', { kind: 'alert' });
  const shows = (k, tech) => {
    DB.sqlite.prepare(`INSERT INTO labels (thread, labeled_through, model, labeled_at, tech)
      VALUES (?, ?, 'test', ?, ?)`).run(k, AT, AT, JSON.stringify(tech));
    DB.sqlite.prepare('INSERT INTO thread_tech (thread, tech, p) VALUES (?, ?, ?)')
      .run(k, ...Object.entries(tech)[0]);
  };
  shows(key('C1', '1.1'), { xw: 0.93 });
  shows(key('C2', '4.1'), { da: 1 });
  shows(key('C3', '5.1'), { xw: 0.9 });
  const notified = [];
  const ROOMS = {
    idFromName: (n) => n,
    get: (team) => ({
      fetch: async (u, init) => {
        notified.push({ team, ...JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      },
    }),
  };
  return {
    DB, CHANNELS: fakeBucket(), ROOMS, notified, STAFF_DOMAINS: 'staff.example',
  };
}

const followTeam = (e, team, tech) => e.DB.sqlite.prepare(`INSERT INTO team_follows (team, tech, added_at)
  VALUES (?, ?, ?)`).run(team, tech, AT);
const followPerson = (e, person, tech) => e.DB.sqlite.prepare(`INSERT INTO person_follows (person, tech,
  added_at) VALUES (?, ?, ?)`).run(person, tech, AT);

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: me });
  return { status: res.status, body: await res.json() };
}

const entries = (data) => data.threads.map((t) => t.thread).sort();

describe('following technologies', () => {
  it('fills thread_tech from the labels that have technologies', () => {
    const e = env();
    e.DB.sqlite.exec(`DELETE FROM thread_tech;
      INSERT INTO labels (thread, labeled_through, model, labeled_at, tech)
        VALUES ('old', '${AT}', 'x', '${AT}', NULL), ('none', '${AT}', 'x', '${AT}', '{}'),
          ('two', '${AT}', 'x', '${AT}', '{"ue":0.91,"eds":1}')`);
    const sql = readFileSync(new URL('../migrations/0072_tech_follows.sql', import.meta.url), 'utf8');
    e.DB.sqlite.exec(/INSERT OR IGNORE INTO thread_tech[^;]+;/.exec(sql)[0]);
    assert.deepEqual(e.DB.sqlite.prepare('SELECT thread, tech, p FROM thread_tech ORDER BY thread, tech').all()
      .map((r) => ({ ...r })), [
      { thread: key('C1', '1.1'), tech: 'xw', p: 0.93 },
      { thread: key('C2', '4.1'), tech: 'da', p: 1 },
      { thread: key('C3', '5.1'), tech: 'xw', p: 0.9 },
      { thread: 'two', tech: 'eds', p: 1 },
      { thread: 'two', tech: 'ue', p: 0.91 },
    ]);
  });

  it('writes what a label shows in place of what it showed', async () => {
    const e = env();
    await e.DB.batch(threadTechStatements(e.DB, key('C1', '1.1'), { da: 0.8, ue: 1 }));
    assert.deepEqual(e.DB.sqlite.prepare('SELECT tech FROM thread_tech WHERE thread = ? ORDER BY tech')
      .all(key('C1', '1.1')).map((r) => r.tech), ['da', 'ue']);
    await e.DB.batch(threadTechStatements(e.DB, key('C1', '1.1'), {}));
    assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM thread_tech WHERE thread = ?')
      .get(key('C1', '1.1')).n, 0);
  });

  it('puts the threads that show a technology a team follows in its inbox, and no others', async () => {
    const e = env();
    const ew = asMe(EW);
    assert.deepEqual(entries(await inbox(e, ew, 'ew')), []);
    followTeam(e, 'ew', 'xw');
    // Not the alert, which shows it too, nor the thread beside it in the channel.
    assert.deepEqual(entries(await inbox(e, ew, 'ew')), [key('C1', '1.1')]);
    followTeam(e, 'ew', 'da');
    // A group is in it when any of its posts shows it, as one entry.
    const data = await inbox(e, ew, 'ew');
    assert.deepEqual(entries(data), [key('C1', '1.1'), key('C2', '3.1')]);
    assert.equal(data.threads.find((t) => t.thread === key('C2', '3.1')).occurrences, 2);
    // The team that holds the channel has them all, once each.
    assert.deepEqual(entries(await inbox(e, asMe(ADA), 'helix')), [key('C1', '1.1'), key('C1', '2.1'), key('C2', '3.1'), key('C3', '5.1')]);
  });

  it('counts a thread once when the team follows it and its channel is shared with it', async () => {
    const e = env();
    followTeam(e, 'ew', 'xw');
    e.DB.sqlite.exec(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('slack', 'C1', 'ew', '${AT}')`);
    const data = await inbox(e, asMe(EW), 'ew');
    assert.deepEqual(entries(data), [key('C1', '1.1'), key('C1', '2.1')]);
    assert.ok(data.threads.every((t) => !t.occurrences));
  });

  it('lets the following team work the thread, and tells its room', async () => {
    const e = env();
    const ew = asMe(EW);
    const t = {
      thread: key('C2', '4.1'), team: 'helix', source: 'slack', channel_id: 'C2',
    };
    assert.equal(await thread(e, ew, key('C2', '3.1')), null);
    followTeam(e, 'ew', 'da');
    // The group's first post, which shows nothing, too: what the entry shows counts.
    assert.deepEqual(await followingTeams(e, key('C2', '3.1')), ['ew']);
    assert.deepEqual(await teamsOf(e, t), ['helix', 'ew']);
    assert.deepEqual(await teamsOf(e, { ...t, thread: undefined }), ['helix']);
    assert.ok(await mayWork(e, ew)(await teamsOf(e, t), t));
    const open = await thread(e, ew, key('C2', '3.1'));
    assert.ok(open);
    assert.deepEqual(open.thread.teams, ['helix', 'ew']);
    assert.deepEqual((await entryOf(e, key('C2', '3.1'))).teams, ['helix', 'ew']);
    assert.deepEqual((await entryOf(e, key('C2', '3.1'))).follows, ['ew']);
    // Not a channel's: starting a thread in it is not theirs.
    assert.deepEqual(await followingTeams(e, key('C1', '2.1')), []);
  });

  it('puts the threads that show a technology a person follows in their personal view', async () => {
    const e = env();
    const ew = asMe(EW);
    assert.deepEqual(entries(await inbox(e, ew, null, { personal: true })), []);
    followPerson(e, EW.id, 'xw');
    assert.deepEqual(entries(await inbox(e, ew, null, { personal: true })), [key('C1', '1.1')]);
    const t = {
      thread: key('C1', '1.1'), team: 'helix', source: 'slack', channel_id: 'C1',
    };
    assert.ok(await mayWork(e, ew)(['helix'], t));
    assert.ok(!await mayWork(e, ew)(['helix'], { ...t, thread: key('C1', '2.1') }));
    assert.ok(await thread(e, ew, key('C1', '1.1')));
    assert.equal(await thread(e, ew, key('C1', '2.1')), null);
    // Their inbox listens in the room of the team that holds it, and hears only of that thread.
    assert.deepEqual(await roomsOf(e, ew), ['ew', 'helix']);
    assert.deepEqual([...await followersOf(e, [EW.id, ADA.id], key('C1', '1.1'))], [EW.id]);
    const sockets = [{ person: EW.id, scoped: true }];
    assert.equal((await recipients(e, { thread: key('C1', '1.1') }, sockets)).length, 1);
    assert.equal((await recipients(e, { thread: key('C1', '2.1') }, sockets)).length, 0);
  });

  it('lets someone on no ops team follow, and work what they follow', async () => {
    const e = { ...env(), SIGNIN_DOMAINS: 'staff.example' };
    const solo = asMe(SOLO);
    assert.equal((await call(e, solo, 'PUT', '/api/follows', { tech: 'xw' })).status, 200);
    assert.deepEqual(entries(await inbox(e, solo, null, { personal: true })), [key('C1', '1.1')]);
    const t = {
      thread: key('C1', '1.1'), team: 'helix', source: 'slack', channel_id: 'C1',
    };
    assert.ok(await mayWork(e, solo)(['helix'], t));
    // On Slack they reply as themselves, and Slack decides whether they may post in the channel.
    const seen = await thread(e, solo, key('C1', '1.1'));
    assert.equal(seen.can_work, true);
    assert.equal(seen.can_post, true);
    // Not as the app, which takes the inbox's word for who may post.
    assert.ok(!await mayPost(e, solo)(['helix'], t));
    assert.deepEqual(await roomsOf(e, solo), ['helix']);
    const sockets = [{ person: SOLO.id, scoped: true }];
    assert.equal((await recipients(e, { thread: key('C1', '1.1') }, sockets)).length, 1);
    // They count as listening while they may sign in: on a team, or from SIGNIN_DOMAINS.
    assert.deepEqual(await entryFollowers(e, key('C1', '1.1')), [SOLO.id]);
    assert.deepEqual(await entryFollowers({ ...e, SIGNIN_DOMAINS: '' }, key('C1', '1.1')), []);
    // Customers, people and areas too.
    assert.equal((await call(e, solo, 'PUT', '/api/follows', { kind: 'org', target: 'globex' })).status, 200);
    assert.deepEqual(
      entries(await inbox(e, solo, null, { personal: true })),
      [key('C1', '1.1'), key('C2', '3.1')],
    );
  });

  it('lets a follow alone not post in the customer portal, where the inbox posts for them', async () => {
    const e = { ...env(), SIGNIN_DOMAINS: 'staff.example' };
    const k = 'portal:acme.example:P1:9.1';
    e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, title, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'portal', 'acme.example', 'P1', '9.1', 'acme', 'helix', 'channel', 'acme',
        'about 9.1', 'channels/acme/helix/portal-P1/9.1/', ?, ?, ?, 1, ?)`).run(k, AT, AT, AT, AT);
    e.DB.sqlite.prepare('INSERT INTO thread_tech (thread, tech, p) VALUES (?, ?, ?)').run(k, 'xw', 0.9);
    followPerson(e, SOLO.id, 'xw');
    const solo = asMe(SOLO);
    const seen = await thread(e, solo, k);
    assert.equal(seen.can_work, true);
    assert.equal(seen.can_post, false);
    const place = {
      thread: k, team: 'helix', source: 'portal', channel_id: 'P1',
    };
    assert.ok(!await mayReply(e, solo)(['helix'], place));
    const r = await call(e, solo, 'POST', '/api/post', { thread: k, text: 'hello' });
    assert.equal(r.status, 404);
    // The channel's team posts there.
    assert.ok(await mayReply(e, asMe(ADA))(['helix'], place));
    assert.equal((await thread(e, asMe(ADA), k)).can_post, true);
  });

  it('suggests what the person\'s channels are about, then what is trending, and finds by name', async () => {
    const e = { ...env(), SIGNIN_DOMAINS: 'staff.example' };
    forgetTrends();
    const now = Date.parse(AT) + 24 * 60 * 60 * 1000;
    // Solo posted in C2 (globex), whose group 3.1 + 4.1 shows da; xw is in two of C1's threads.
    e.DB.sqlite.prepare('UPDATE messages SET person = ? WHERE thread = ?').run(SOLO.id, key('C2', '3.1'));
    e.DB.sqlite.prepare('INSERT INTO thread_tech (thread, tech, p) VALUES (?, ?, ?)').run(key('C1', '2.1'), 'xw', 0.8);
    e.DB.sqlite.exec(`INSERT INTO areas (team, id, name, what, path) VALUES
      ('admin', 'seo', 'SEO', 'SEO', 'areas/seo.md'), ('admin', 'cdn', 'CDN and caching', 'CDN', 'areas/cdn.md')`);
    await e.DB.batch(threadAreaStatements(e.DB, key('C2', '4.1'), { seo: 0.9 }));
    followTeam(e, 'helix', 'xw');
    const s = await suggestFollows(e, SOLO, { now });
    assert.deepEqual(s.tech.map((t) => [t.id, t.mine, t.recent]), [['da', 1, 1], ['xw', 0, 2]]);
    assert.deepEqual(s.tech[1].teams, ['Helix']);
    assert.deepEqual(s.area.map((a) => a.id), ['seo']);
    assert.deepEqual(s.org.map((o) => [o.id, o.mine]), [['globex', 1]]);
    // Not what they follow already.
    followPerson(e, SOLO.id, 'da');
    assert.deepEqual((await suggestFollows(e, SOLO, { now })).tech.map((t) => t.id), ['xw']);
    // A query finds by name every product, topic and customer, followed or not.
    let q = await suggestFollows(e, SOLO, { q: 'document', now });
    assert.deepEqual(q.tech.map((t) => t.id), ['da']);
    q = await suggestFollows(e, SOLO, { q: 'caching', now });
    assert.deepEqual(q.area.map((a) => a.id), ['cdn']);
    q = await suggestFollows(e, SOLO, { q: 'acm', now });
    assert.deepEqual(q.org.map((o) => o.id), ['acme']);
    // Over the API, for anyone signed in.
    const r = await call(e, asMe(SOLO), 'GET', '/api/follows/suggest?q=workspace');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tech.map((t) => t.id), ['xw']);
  });

  it('tells a follower that a thread stopped showing what they follow, so it can go', async () => {
    const e = env();
    followPerson(e, EW.id, 'xw');
    const sockets = [{ person: EW.id, scoped: true }, { person: SOLO.id, scoped: true }];
    // Relabeled: it shows xw no more.
    await e.DB.batch(threadTechStatements(e.DB, key('C1', '1.1'), {}));
    assert.equal((await recipients(e, { thread: key('C1', '1.1') }, sockets)).length, 0);
    const heard = await recipients(e, { thread: key('C1', '1.1'), tech: ['xw'] }, sockets);
    assert.deepEqual(heard.map((s) => s.person), [EW.id]);
  });

  it('tells an area\'s follower that a thread left it, and keeps a target as it was stored', async () => {
    const e = env();
    const ew = asMe(EW);
    e.DB.sqlite.exec(`INSERT INTO areas (team, id, name, what, path) VALUES
      ('admin', 'seo', 'SEO', 'SEO', 'areas/seo.md')`);
    await e.DB.batch(threadAreaStatements(e.DB, key('C1', '2.1'), { seo: 0.9 }));
    await call(e, ew, 'PUT', '/api/follows', { kind: 'area', target: ' seo ' });
    const sockets = [{ person: EW.id, scoped: true }];
    assert.equal((await recipients(e, { thread: key('C1', '2.1') }, sockets)).length, 1);
    // Relabeled: it is in the area no more; the event naming it still reaches them.
    await e.DB.batch(threadAreaStatements(e.DB, key('C1', '2.1'), {}));
    assert.equal((await recipients(e, { thread: key('C1', '2.1') }, sockets)).length, 0);
    assert.equal((await recipients(e, { thread: key('C1', '2.1'), areas: ['seo'] }, sockets)).length, 1);
    // Unfollowed with what followed it, spaces and all.
    let r = await call(e, ew, 'PUT', '/api/follows', { kind: 'area', target: ' seo ', follow: false });
    assert.deepEqual(r.body.by.area, []);
    // A person's id is stored as the integer it is: "007" is 7, "1e1" no one.
    r = await call(e, ew, 'PUT', '/api/follows', { kind: 'person', target: `00${ADA.id}` });
    assert.deepEqual(r.body.by.person, [ADA.id]);
    assert.equal((await call(e, ew, 'PUT', '/api/follows', { kind: 'person', target: '1e0' })).status, 400);
    r = await call(e, ew, 'PUT', '/api/follows', { kind: 'person', target: ADA.id, follow: false });
    assert.deepEqual(r.body.by.person, []);
  });

  it('finds the threads a team follows when it searches', async () => {
    const e = env();
    const ew = asMe(EW);
    assert.deepEqual((await searchInbox(e, ew, 'ew', 'about')).threads, []);
    followTeam(e, 'ew', 'xw');
    assert.deepEqual(entries(await searchInbox(e, ew, 'ew', 'about')), [key('C1', '1.1')]);
  });

  it('lets a person follow technologies, and says what they and their teams follow', async () => {
    const e = env();
    const ew = asMe(EW);
    followTeam(e, 'ew', 'da');
    let r = await call(e, ew, 'PUT', '/api/follows', { tech: 'xw' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.me, ['xw']);
    assert.deepEqual(r.body.teams, { ew: ['da'] });
    assert.equal((await call(e, ew, 'PUT', '/api/follows', { tech: 'nothing-like-it' })).status, 400);
    assert.equal((await call(e, { ...ew, readonly: true }, 'PUT', '/api/follows', { tech: 'ue' })).status, 403);
    r = await call(e, ew, 'GET', '/api/follows');
    assert.deepEqual(r.body.me, ['xw']);
    assert.ok(r.body.tech.some((t) => t.tech === 'xw' && t.name));
    assert.deepEqual((await call(e, ew, 'GET', '/api/me')).body.follows, {
      me: ['xw'], teams: { ew: ['da'] }, by: { org: [], person: [], area: [] },
    });
    r = await call(e, ew, 'PUT', '/api/follows', { tech: 'xw', follow: false });
    assert.deepEqual(r.body.me, []);
  });

  it('puts the threads of a customer, a person or an area a person follows in their personal view', async () => {
    const e = env();
    const ew = asMe(EW);
    const personal = async () => entries(await inbox(e, ew, null, { personal: true })).sort();
    assert.deepEqual(await personal(), []);
    // A customer: its conversations, not its alerts.
    let r = await call(e, ew, 'PUT', '/api/follows', { kind: 'org', target: 'globex' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.by.org, ['globex']);
    assert.deepEqual(await personal(), [key('C2', '3.1')]);
    assert.deepEqual([...await followersOf(e, [EW.id, ADA.id], key('C2', '4.1'))], [EW.id]);
    await call(e, ew, 'PUT', '/api/follows', { kind: 'org', target: 'globex', follow: false });
    // A person: the threads they posted in.
    e.DB.sqlite.prepare('UPDATE messages SET person = ? WHERE thread = ?').run(ADA.id, key('C1', '2.1'));
    r = await call(e, ew, 'PUT', '/api/follows', { kind: 'person', target: ADA.id });
    assert.deepEqual(r.body.by.person, [ADA.id]);
    assert.deepEqual(await personal(), [key('C1', '2.1')]);
    await call(e, ew, 'PUT', '/api/follows', { kind: 'person', target: ADA.id, follow: false });
    // An area: the threads Clef puts in it (thread_areas, written with the label).
    e.DB.sqlite.exec(`INSERT INTO areas (team, id, name, what, path) VALUES
      ('admin', 'seo', 'SEO', 'SEO', 'areas/seo.md')`);
    await e.DB.batch(threadAreaStatements(e.DB, key('C2', '4.1'), { seo: 0.9 }));
    r = await call(e, ew, 'PUT', '/api/follows', { kind: 'area', target: 'seo' });
    assert.deepEqual(r.body.by.area, ['seo']);
    assert.deepEqual(await personal(), [key('C2', '3.1')]);
    assert.deepEqual([...await followersOf(e, [EW.id], key('C2', '3.1'))], [EW.id]);
    // What no one may follow, and who may not.
    assert.equal((await call(e, ew, 'PUT', '/api/follows', { kind: 'area', target: 'nope' })).status, 400);
    assert.equal((await call(e, ew, 'PUT', '/api/follows', { kind: 'team', target: 'ew' })).status, 400);
  });

  it('lets a team\'s managers and the admin team pick what the team follows', async () => {
    const e = env();
    assert.equal((await call(e, asMe(EW), 'PUT', '/api/admin/follows', { team: 'ew', tech: 'xw' })).status, 403);
    let r = await call(e, asMe(MANAGER, 'manager'), 'PUT', '/api/admin/follows', { team: 'ew', tech: 'xw' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.follows.map((f) => f.tech), ['xw']);
    assert.equal(r.body.follows[0].added_by, MANAGER.email);
    // Not another team's.
    assert.equal((await call(e, asMe(MANAGER, 'manager'), 'PUT', '/api/admin/follows', { team: 'helix', tech: 'xw' })).status, 403);
    assert.equal((await call(e, asMe(ADMIN), 'PUT', '/api/admin/follows', { team: 'ew', tech: 'nope' })).status, 400);
    r = await call(e, asMe(ADMIN), 'PUT', '/api/admin/follows', { team: 'ew', tech: 'da' });
    assert.deepEqual(r.body.follows.map((f) => f.tech), ['da', 'xw']);
    r = await call(e, asMe(MANAGER, 'manager'), 'GET', '/api/admin/team?slug=ew');
    assert.deepEqual(r.body.follows.map((f) => f.tech), ['da', 'xw']);
    assert.ok(r.body.followable.some((t) => t.tech === 'ue'));
    r = await call(e, asMe(MANAGER, 'manager'), 'PUT', '/api/admin/follows', { team: 'ew', tech: 'da', follow: false });
    assert.deepEqual(r.body.follows.map((f) => f.tech), ['xw']);
  });

  it('offers every technology that is on somewhere, by a team\'s own name first', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO tech_stack (team, tech, name, description) VALUES
      ('ew', 'xw', 'Workspace', 'x'), ('helix', 'own', 'Own thing', 'y')`);
    e.DB.sqlite.exec('UPDATE tech_stack SET enabled = 0 WHERE tech = \'ue\'');
    const list = await followable(e, 'ew');
    assert.equal(list.find((t) => t.tech === 'xw').name, 'Workspace');
    assert.ok(list.some((t) => t.tech === 'own'));
    assert.ok(!list.some((t) => t.tech === 'ue'));
  });

  it('gives a thread\'s agent the knowledge bases of the teams that follow it, to write', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO knowledge_bases (kind, slug, repo, created_at) VALUES
      ('team', 'helix', 'kb-team-helix', '${AT}'), ('team', 'ew', 'kb-team-ew', '${AT}'),
      ('team', 'admin', 'kb-team-admin', '${AT}')`);
    const target = {
      team: 'helix', org: 'acme', source: 'slack', channelId: 'C1',
    };
    const kb = async (follows) => (await accessibleRepos(e, { ...target, follows }))
      .filter((r) => r.kind === 'kb' && r.team)
      .map((r) => ({ team: r.team, writable: r.writable, scope: r.scope }));
    assert.deepEqual(await kb([]), [
      { team: 'admin', writable: false, scope: 'other' }, { team: 'ew', writable: false, scope: 'other' },
    ]);
    assert.deepEqual(await kb(['ew']), [
      { team: 'ew', writable: true, scope: 'shared' }, { team: 'admin', writable: false, scope: 'other' },
    ]);
  });
});

describe('rooms', () => {
  // Every team of the threads of their personal view, as asking each thread for its team did.
  const asked = async (e, me) => {
    const { results } = await e.DB.prepare(`SELECT DISTINCT team FROM threads t
      WHERE ${inPersonalInbox('t', '?1')} AND team IS NOT NULL ORDER BY team`).bind(me.id).all();
    return [...new Set([...me.teams.map((t) => t.slug), ...results.map((r) => r.team)])];
  };

  it("finds the teams of a person's channels one by one, as their threads have them", async () => {
    const e = env();
    const ew = asMe(EW);
    // EW posted in C1, which helix holds, but one of its threads went to admin, and one to ew.
    e.DB.sqlite.exec(`UPDATE threads SET team = 'admin' WHERE thread = '${key('C1', '2.1')}';
      INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, person)
        VALUES ('slack', 'E1', 'C1', '1.2', '${key('C1', '1.1')}', '${AT}', 1, 1, ${EW.id})`);
    e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'slack', 'E1', 'C1', '6.1', 'acme', 'ew', 'channel', 'p/', ?, ?, ?, 1, ?)`)
      .run(key('C1', '6.1'), AT, AT, AT, AT);
    // A channel of the same id on another platform is not theirs.
    e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, path, root_at, last_at, any_at, messages, updated_at)
      VALUES ('teams:T:G:C1:8', 'teams', 'T', 'C1', '8', 'acme', 'cdn', 'channel', 'p/', ?, ?, ?, 1, ?)`)
      .run(AT, AT, AT, AT);
    assert.deepEqual(await roomsOf(e, ew), ['ew', 'admin', 'helix']);
    // Mentioned in C3, an alert channel of a thousand threads: its team, once.
    const alert = e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id,
        root_id, org, team, kind, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'slack', 'E1', 'C3', ?, 'acme', ?, 'alert', 'p/', ?, ?, ?, 1, ?)`);
    for (let i = 0; i < 1000; i += 1) {
      alert.run(key('C3', `9.${i}`), `9.${i}`, i === 500 ? 'cdn' : 'helix', AT, AT, AT, AT);
    }
    e.DB.sqlite.prepare(`INSERT INTO mentions (thread, message, person, at, via)
      VALUES (?, ?, ?, ?, 'id')`).run(key('C3', '5.1'), 'slack:E1:C3:5.1', ADA.id, AT);
    const ada = asMe(ADA);
    assert.deepEqual(await roomsOf(e, ada), ['helix', 'cdn']);
    // And the teams of what they follow: C2's group shows da.
    e.DB.sqlite.exec(`UPDATE threads SET team = 'ew' WHERE thread = '${key('C2', '3.1')}'`);
    followPerson(e, ADA.id, 'da');
    assert.deepEqual(await roomsOf(e, ada), ['helix', 'cdn', 'ew']);
    for (const me of [ew, ada, asMe(SOLO)]) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual((await roomsOf(e, me)).sort(), (await asked(e, me)).sort(), me.email);
    }
    // One search of the index a team, not a row a thread.
    const plan = e.DB.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT MIN(x.team) FROM threads x
      WHERE x.channel_id = ? AND x.source = ? AND x.team > ?`).all('C3', 'slack', 'cdn');
    assert.match(plan.map((r) => r.detail).join(), /threads_channel_team/);
  });
});
