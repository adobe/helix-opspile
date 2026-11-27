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
import { requestPartnerLink } from '../src/agent/partnerrequest.js';
import { forgetFacts } from '../src/orgmerge.js';
import {
  AGAIN_DAYS, conflictOf, customersOf, forgetEvidence, GOING_ON_DAYS, LAPSED_DAYS, partnersOf,
  partnerWants, standingOf, standingWords, UNSURE_HIGH, UNSURE_LOW,
} from '../src/orgpartners.js';
import { dateOf } from '../src/partnerrequests.js';
import { forgetPartnerDomains } from '../src/partners.js';
import { requestKey } from '../src/requestkeys.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, orgs, channels and domains only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: [],
};
const viewer = (p) => ({
  id: p.id, email: p.email, name: p.name, teams: p.teams.map((slug) => ({ slug })),
});
const AT = '2026-10-22T00:00:00Z';

/** Clef, made up: the agency works for Globex (as sure as `p`), the studio for nobody. */
const fakeAI = (p) => ({
  async run(model, input) {
    const yes = /C: slug globex,/.test(input.state) && /P: slug agency,/.test(input.state);
    return { answers: { works: { type: 'noul', noul: yes ? p : 0.2 } } };
  },
});

/**
 * Globex, a customer, and two partners: two of the agency's people post in three of Globex's
 * threads, and the studio has a channel of its own and nothing in Globex's.
 */
function env({ p = 0.9 } = {}) {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  const sql = DB.sqlite;
  sql.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at) VALUES
      ('slack', 'E1', 'C1', 'aem-globex', '${AT}'), ('slack', 'E1', 'C2', 'aem-agency', '${AT}'),
      ('slack', 'E1', 'C3', 'aem-studio', '${AT}');
    INSERT INTO orgs (slug, name, type, updated_at) VALUES
      ('globex', 'Globex', 'customer', '${AT}'), ('agency', 'The Agency', 'partner', '${AT}'),
      ('studio', 'Studio', 'partner', '${AT}');
    INSERT INTO identities (source, tenant, user_id, kind, email, fetched_at) VALUES
      ('slack', 'E1', 'U1', 'person', 'wile@agency.example', '${AT}'),
      ('slack', 'E1', 'U2', 'person', 'road@agency.example', '${AT}'),
      ('slack', 'E1', 'U3', 'person', 'hank@globex.example', '${AT}')`);
  const thread = sql.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
      team, kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, ?, ?, 'helix', 'channel', '', ?, ?, ?, ?, 1, ?)`);
  const post = sql.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, author_key) VALUES ('slack', 'E1', ?, ?, ?, ?, 0, 1, ?)`);
  const roots = [['C1', '1.1', 'globex'], ['C1', '1.2', 'globex'], ['C1', '1.3', 'globex'],
    ['C2', '2.1', 'agency'], ['C3', '3.1', 'studio']];
  for (const [ch, root, org] of roots) {
    thread.run(`slack:E1:${ch}:${root}`, ch, root, org, `channels/${org}/helix/slack-${ch}/${root}/`, AT, AT, AT, AT);
  }
  let n = 0;
  for (const [ch, root, user, at] of [['C2', '2.1', 'U1', AT], ['C1', '1.1', 'U3', AT],
    ['C1', '1.1', 'U1', '2026-09-01T10:00:00Z'], ['C1', '1.2', 'U2', AT], ['C1', '1.3', 'U1', AT]]) {
    n += 1;
    post.run(ch, `m${n}`, `slack:E1:${ch}:${root}`, at, `slack:E1:${user}`);
  }
  return {
    DB, AI: fakeAI(p), STAFF_DOMAINS: 'staff.example', CHANNELS: fakeBucket(), NORMALIZE: { send: async () => {} },
  };
}

async function call(e, who, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: viewer(who) });
  return { status: res.status, body: await res.json() };
}

const rows = (e, sql) => e.DB.sqlite.prepare(sql).all().map((r) => ({ ...r }));

beforeEach(() => {
  forgetFacts();
  forgetEvidence();
  forgetPartnerDomains();
});

describe('partner requests', () => {
  it('reads a day, a month, or an ISO time\'s day', () => {
    assert.equal(dateOf('2026-10'), '2026-10');
    assert.equal(dateOf(' 2026-10-24 '), '2026-10-24');
    assert.equal(dateOf('2026-10-24T09:00:00Z'), '2026-10-24');
    assert.equal(dateOf(''), null);
    assert.equal(dateOf('October'), undefined);
    assert.equal(dateOf('2026-13'), undefined);
  });

  it('are asked by anyone on a team, once, and decided in the admin team\'s inbox', async () => {
    // Clef is unsure of the agency: it asks the admin team too.
    const e = env({ p: 0.6 });
    // Nobody but an ops team's people asks; a partner must be one.
    assert.equal((await call(e, CY, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'studio', action: 'link' })).status, 403);
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'studio', partner: 'globex', action: 'link' })).status, 409);
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-partner-requests', {
      customer: 'globex', partner: 'studio', action: 'link', since: 'last spring',
    })).status, 400);
    const r = await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', {
      customer: 'globex', partner: 'studio', action: 'link', since: '2026-09', note: 'Their new agency, says the kick-off',
    }));
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.request.action, r.body.request.since, r.body.request.requestedBy.email], ['link', '2026-09', 'bo@staff.example']);
    // Bo is no admin: what he is answered has none of the admin team's evidence.
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners'));
    const agency = await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'agency', action: 'link' }));
    assert.equal(agency.status, 409);
    assert.equal(agency.body.request.requestedBy.name, 'Clef');
    assert.ok(agency.body.request.pair && agency.body.request.pair.p === 0.6);
    assert.ok(!('signals' in agency.body.request.pair) && !('fingerprint' in agency.body.request));
    assert.equal(agency.body.request.note, null);
    assert.ok(!JSON.stringify(agency.body).includes('agency.example'));
    const admin = await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'agency', action: 'link' }));
    assert.ok(admin.body.request.pair.signals.length);
    const again = await call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'studio', action: 'link' });
    assert.equal(again.status, 409);
    assert.equal(again.body.request.id, r.body.request.id);
    // A thread of the admin team's inbox, with what it asks and the other partners.
    const key = requestKey('partner', r.body.request.id);
    const t = await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`);
    assert.equal(t.status, 200);
    assert.equal(t.body.thread.title, 'Studio works for Globex?');
    assert.match(t.body.messages[0].body, /works for \*\*Globex\*\* `globex`, since 2026-09/);
    assert.match(t.body.messages[0].body, /> Their new agency, says the kick-off/);
    assert.deepEqual(t.body.request.actions.map((a) => a.id), ['confirm', 'dismiss', 'decline']);
    assert.equal(t.body.request.actions[0].fields[0].value, '2026-09-01');
    // Bo sees it as his own, not the admin team's inbox.
    assert.equal((await call(e, BO, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).status, 404);
    // Confirmed there, with its date: the pair is a partner's since then, and the request closed.
    const done = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'confirm', values: { since: '2026-09-15' } }));
    assert.equal(done.status, 200);
    assert.match(done.body.done, /Confirmed Studio as a partner of Globex, since 2026-09-15/);
    assert.equal(done.body.thread.request.open, false);
    assert.match(done.body.thread.messages.at(-1).body, /\*\*Confirmed\*\* by ada@staff.example/);
    const [studio] = (await partnersOf(e, 'globex')).filter((x) => x.slug === 'studio');
    assert.deepEqual([studio.confirmed, studio.current, studio.since, studio.until], [true, true, '2026-09-15', null]);
  });

  it('end a partner, which lists it as a former one, last', async () => {
    const e = env();
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency', since: '2025-01' }));
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'studio' }));
    // The span of the agency's people, as the pairs' sync writes it.
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners'));
    // A link is asked of a partner of now no more; an end, with its date.
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'agency', action: 'link' })).status, 409);
    const r = await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', {
      customer: 'globex', partner: 'agency', action: 'end', until: '2026-10',
    }));
    const key = requestKey('partner', r.body.request.id);
    const t = await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`);
    assert.equal(t.body.thread.title, 'The Agency no longer works for Globex?');
    assert.deepEqual(t.body.request.actions.map((a) => [a.id, a.label]), [['end', 'End'], ['dismiss', 'Not partners'], ['decline', 'Still a partner']]);
    // Its other partner, and the agency's people's span.
    assert.match(t.body.messages[0].body, /Globex's other partners:\n {2}- \*\*Studio\*\* `studio`: confirmed/);
    assert.match(t.body.messages[0].body, /The Agency's people in Globex's threads/);
    assert.match(t.body.messages[0].body, /first 2026-09-01, last 2026-10-22/);
    assert.equal((await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'end', values: {} }))).status, 400);
    const done = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'end', values: { until: '2026-10-20' } }));
    assert.equal(done.status, 200);
    const list = await partnersOf(e, 'globex');
    assert.deepEqual(list.map((x) => [x.slug, x.current, x.until]), [['studio', true, null], ['agency', false, '2026-10-20']]);
    assert.deepEqual((await customersOf(e, 'agency')).map((x) => [x.slug, x.since, x.until]), [['globex', '2025-01', '2026-10-20']]);
    // An end is asked once; confirming it again makes it a partner of now, its end gone.
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'agency', action: 'end' })).status, 409);
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' }));
    const [agency] = (await partnersOf(e, 'globex')).filter((x) => x.slug === 'agency');
    assert.deepEqual([agency.current, agency.since, agency.until], [true, '2025-01', null]);
    // Undone, an end is no more; dismissed, a pair has no dates.
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/end', { customer: 'globex', partner: 'agency', until: '2026-11' }));
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/end', { customer: 'globex', partner: 'agency', undo: true }));
    assert.equal((await partnersOf(e, 'globex')).find((x) => x.slug === 'agency').until, null);
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/dismiss', { customer: 'globex', partner: 'agency' }));
    assert.deepEqual(rows(e, "SELECT since, until FROM org_partners WHERE partner = 'agency'"), [{ since: null, until: null }]);
  });

  it('are declined or taken back, and the pair stays as it is', async () => {
    const e = env();
    const ask = () => quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'studio', action: 'link' }));
    let r = await ask();
    // Only whoever asked takes it back (or the admin team).
    assert.equal((await call(e, CY, 'DELETE', '/api/admin/org-partner-requests', { id: r.body.request.id })).status, 403);
    assert.equal((await quiet(() => call(e, BO, 'DELETE', '/api/admin/org-partner-requests', { id: r.body.request.id }))).body.request.status, 'withdrawn');
    r = await ask();
    const key = requestKey('partner', r.body.request.id);
    const done = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'decline', values: { reason: 'Not theirs' } }));
    assert.equal(done.status, 200);
    assert.match(done.body.thread.messages.at(-1).body, /\*\*Declined\*\* by ada@staff.example: Not theirs/);
    assert.deepEqual(rows(e, "SELECT * FROM org_partners WHERE partner = 'studio'"), []);
    // A dismissal closes every request of the pair.
    r = await ask();
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/dismiss', { customer: 'globex', partner: 'studio' }));
    assert.deepEqual(rows(e, `SELECT status, decided_by FROM org_partner_requests WHERE id = ${r.body.request.id}`), [{ status: 'dismissed', decided_by: 'ada@staff.example' }]);
  });

  it('are Clef\'s for a pair it is unsure of, not again once declined', async () => {
    const e = env({ p: 0.6 });
    const load = () => quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    let list = await load();
    const pair = list.body.pairs.find((x) => x.partner === 'agency');
    assert.deepEqual([pair.p, pair.standing.status, pair.first, pair.last], [0.6, 'likely', '2026-09-01T10:00:00Z', AT]);
    assert.deepEqual(list.body.unsure, [UNSURE_LOW, UNSURE_HIGH]);
    const [q] = rows(e, 'SELECT * FROM org_partner_requests');
    assert.deepEqual([q.customer, q.partner, q.action, q.since, q.requested_by], ['globex', 'agency', 'link', '2026-09-01', 'clef']);
    assert.match(q.note, /^Clef is unsure, 60%, that The Agency works for Globex: 2 people from agency\.example/);
    assert.deepEqual(pair.open, [{ id: q.id, action: 'link' }]);
    // Its thread is Clef's, not a person's.
    const t = await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(requestKey('partner', q.id))}`);
    assert.equal(t.body.messages[0].author.name, 'Clef');
    // Loaded again, it is not asked twice; declined, not again on the same evidence.
    await load();
    assert.equal(rows(e, 'SELECT * FROM org_partner_requests').length, 1);
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partner-requests/decline', { id: q.id }));
    list = await load();
    assert.equal(rows(e, "SELECT * FROM org_partner_requests WHERE status = 'open'").length, 0);
    // Confirmed on its page instead, a request of Clef's that waits is closed with it.
    e.DB.sqlite.exec('DELETE FROM org_partner_requests');
    await load();
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' }));
    assert.deepEqual(rows(e, 'SELECT status FROM org_partner_requests'), [{ status: 'confirmed' }]);
  });

  it('are none for a pair Clef is sure of, which counts as a partner, and its own are taken back', async () => {
    const e = env({ p: 0.9 });
    // What the first syncs filed for a likely pair, before Clef asked only when unsure.
    e.DB.sqlite.exec(`INSERT INTO org_partner_requests (customer, partner, action, note, fingerprint,
        requested_by, requested_at) VALUES ('globex', 'agency', 'link', 'Clef says 90%', 'f0', 'clef', '${AT}')`);
    const list = await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    const pair = list.body.pairs.find((x) => x.partner === 'agency');
    assert.deepEqual([pair.p, pair.standing.status, pair.confirmed], [0.9, 'sure', null]);
    assert.deepEqual(rows(e, 'SELECT status, decided_by, reason FROM org_partner_requests'), [{
      status: 'withdrawn', decided_by: 'clef', reason: 'Clef is sure of it, 90%: it counts as a partner without a decision',
    }]);
    // Linked without a decision, as a likely one is; and asked about no more.
    assert.deepEqual((await partnersOf(e, 'globex')).map((x) => [x.slug, x.confirmed]), [['agency', false]]);
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    assert.equal(rows(e, "SELECT * FROM org_partner_requests WHERE status = 'open'").length, 0);
    // Below the band, none either: an open one is taken back as unlikely.
    const low = env({ p: 0.2 });
    low.DB.sqlite.exec(`INSERT INTO org_partner_requests (customer, partner, action, fingerprint,
        requested_by, requested_at) VALUES ('globex', 'agency', 'link', 'f0', 'clef', '${AT}')`);
    await quiet(() => call(low, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    assert.deepEqual(rows(low, 'SELECT status, reason FROM org_partner_requests'), [{ status: 'withdrawn', reason: 'Clef finds it unlikely now, 20%' }]);
    // A person's request is theirs to take back, whatever Clef says.
    const asked = await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', {
      customer: 'globex', partner: 'agency', action: 'link', note: 'Hank says so',
    }));
    assert.equal(asked.status, 200);
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    assert.equal(rows(e, `SELECT status FROM org_partner_requests WHERE id = ${asked.body.request.id}`)[0].status, 'open');
  });

  it('are Clef\'s for a sure pair only where its signals conflict', () => {
    const day = 24 * 3600 * 1000;
    const now = Date.parse('2026-11-26T00:00:00Z');
    const iso = (ms) => new Date(ms).toISOString();
    const orgs = new Map([['globex', { slug: 'globex', name: 'Globex', latest: iso(now - day) }],
      ['agency', { slug: 'agency', name: 'The Agency' }]]);
    const seen = new Map([['globex\nagency', 'f']]);
    const sig = (kind) => ({
      kind, weight: 2, n: 3, text: `${kind} found`,
    });
    const pair = (more) => ({
      customer: 'globex', partner: 'agency', signals: [sig('posters'), sig('members')], p: 0.9, candidate: true, confirmed: null, dismissed: null, until: null, first: iso(now - 30 * day), last: iso(now - 2 * day), ...more,
    });
    const wants = (more) => partnerWants([pair(more)], orgs, seen, now);
    // The band's edges ask; what is above or below it does not.
    const edges = [0.34, UNSURE_LOW, 0.5, UNSURE_HIGH, 0.66];
    assert.deepEqual(edges.map((p) => wants({ p }).length), [0, 1, 1, 1, 0]);
    assert.equal(wants({ p: UNSURE_LOW })[0].fingerprint, 'f');
    // Nobody asked Clef yet, or not on what it is shown now: no request.
    assert.deepEqual(wants({ p: null }), []);
    assert.deepEqual(partnerWants([pair({ p: 0.5 })], orgs, new Map(), now), []);
    // Sure, on one kind alone that is no posting together.
    const [alone] = wants({ signals: [sig('owners')] });
    assert.deepEqual([alone.action, alone.fingerprint], ['link', 'f']);
    assert.match(alone.note, /^Clef is sure, 90%, that The Agency works for Globex, from one kind of evidence alone: owners found\.$/);
    assert.equal(wants({ signals: [sig('members')] }).length, 1);
    assert.deepEqual(wants({ signals: [sig('posters')] }), []);
    assert.deepEqual(wants({ signals: [sig('channel')] }), []);
    // Sure, and its people stopped posting while the customer's threads went on.
    const lapsed = iso(now - (LAPSED_DAYS + 1) * day);
    const [quietly] = wants({ last: lapsed });
    assert.deepEqual([quietly.action, quietly.since, quietly.fingerprint], ['link', iso(now - 30 * day).slice(0, 10), `quiet:${lapsed.slice(0, 10)}`]);
    assert.match(quietly.note, /but nobody of The Agency posted in Globex's threads since/);
    const still = new Map([...orgs, ['globex', { slug: 'globex', name: 'Globex', latest: lapsed }]]);
    assert.deepEqual(partnerWants([pair({ last: lapsed })], still, seen, now), []);
    // A conflict is a sure pair's: the unsure one is asked as unsure.
    assert.match(wants({ p: 0.6, signals: [sig('owners')] })[0].note, /^Clef is unsure, 60%/);
    assert.deepEqual(conflictOf(pair({}), orgs, now), null);
  });

  it('say how a pair stands, in words for the agents', () => {
    const at = { by: 'ada', at: AT };
    const said = (x) => standingOf(x).status;
    assert.deepEqual([
      said(null), said({ p: null }), said({ p: 0.2 }), said({ p: 0.4 }), said({ p: 0.55 }),
      said({ p: 0.9 }),
      said({ confirmed: at, p: 0.2 }), said({ confirmed: at, until: '2026-06' }), said({ dismissed: at, p: 0.9 }),
    ], ['none', 'unknown', 'unlikely', 'unsure', 'likely', 'sure', 'confirmed', 'former', 'dismissed']);
    assert.equal(standingWords(standingOf({ p: 0.4 })), 'not decided and not linked; Clef is unsure (40%)');
    assert.equal(standingWords(standingOf({ confirmed: at, until: '2026-06' })), 'a former partner, until 2026-06, as the admin team said');
    assert.equal(standingWords(standingOf({ p: 0.92 })), 'not decided; Clef is sure (92%), so it counts as a partner');
  });

  it('are Clef\'s for a partner whose people stopped posting, and one who posts again', () => {
    const day = 24 * 3600 * 1000;
    const now = Date.parse('2026-11-26T00:00:00Z');
    const iso = (ms) => new Date(ms).toISOString();
    const orgs = new Map([['globex', { slug: 'globex', name: 'Globex', latest: iso(now - day) }],
      ['agency', { slug: 'agency', name: 'The Agency' }]]);
    const pair = (more) => ({
      customer: 'globex', partner: 'agency', signals: [], p: null, candidate: false, confirmed: { by: 'ada', at: AT }, dismissed: null, until: null, first: null, last: null, ...more,
    });
    const lapsed = iso(now - (LAPSED_DAYS + 1) * day);
    const [end] = partnerWants([pair({ last: lapsed })], orgs, new Map(), now);
    assert.deepEqual([end.action, end.until, end.fingerprint], ['end', lapsed.slice(0, 10), `end:${lapsed.slice(0, 10)}`]);
    // Not while it posts, nor while the customer is as quiet.
    assert.deepEqual(partnerWants([pair({ last: iso(now - 10 * day) })], orgs, new Map(), now), []);
    const quietCustomer = new Map([...orgs, ['globex', {
      slug: 'globex', latest: iso(Date.parse(lapsed) + (GOING_ON_DAYS - 1) * day),
    }]]);
    assert.deepEqual(partnerWants([pair({ last: lapsed })], quietCustomer, new Map(), now), []);
    // Ended, and its people post again: a partner again?
    const [again] = partnerWants([pair({ until: '2026-09', last: iso(Date.parse('2026-09-28T23:59:59Z') + (AGAIN_DAYS + 1) * day) })], orgs, new Map(), now);
    assert.deepEqual([again.action, again.fingerprint], ['link', 'again:2026-09']);
    // A dismissed pair, or one Clef finds unlikely, is no request.
    const seen = new Map([['globex\nagency', 'f']]);
    const dismissed = pair({
      confirmed: null, dismissed: { by: 'ada' }, p: 0.9, candidate: true,
    });
    assert.deepEqual(partnerWants([dismissed], orgs, seen, now), []);
    const unlikely = pair({ confirmed: null, p: 0.3, candidate: true });
    assert.deepEqual(partnerWants([unlikely], orgs, seen, now), []);
  });

  it('follow a merge: its dates go with the decision, its requests are taken back', async () => {
    const e = env();
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'studio', since: '2025-03' }));
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/end', { customer: 'globex', partner: 'studio', until: '2026-06' }));
    const r = await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', { customer: 'globex', partner: 'studio', action: 'link' }));
    assert.equal((await quiet(() => call(e, ADA, 'POST', '/api/admin/org-merge', { from: 'studio', into: 'agency' }))).status, 200);
    assert.deepEqual(rows(e, "SELECT since, until, merged_from FROM org_partners WHERE partner = 'agency'"), [{ since: '2025-03', until: '2026-06', merged_from: 'studio' }]);
    assert.deepEqual(rows(e, `SELECT status, reason FROM org_partner_requests WHERE id = ${r.body.request.id}`), [{ status: 'withdrawn', reason: 'studio was merged into agency: ask again of agency' }]);
    // Undone, the decision it wrote goes, dates and all.
    await quiet(() => call(e, ADA, 'DELETE', '/api/admin/org-merge', { slug: 'studio' }));
    assert.deepEqual(rows(e, "SELECT * FROM org_partners WHERE partner = 'agency'"), []);
  });

  it('are an agent\'s, on its own or for the person in its sidebar, from its thread', async () => {
    const e = env();
    const t = {
      key: 'slack:E1:C1:1.1', org: 'globex', orgType: 'customer', orgName: 'Globex', channelName: 'aem-globex',
    };
    assert.match((await requestPartnerLink(e, t, null, { action: 'link', note: 'x' })).error, /give the partner/);
    assert.match((await requestPartnerLink(e, t, null, { action: 'link', partner: 'studio' })).error, /say why/);
    const own = await quiet(() => requestPartnerLink(e, t, null, {
      action: 'link', partner: 'studio', since: '2026-11', note: 'Hank says Studio takes over the site in November',
    }));
    assert.deepEqual([own.request.customer, own.request.partner, own.request.requestedBy.kind, own.request.thread], ['globex', 'studio', 'agent', t.key]);
    assert.equal(own.request.requestedBy.name, 'The agent of a thread in #aem-globex');
    const th = await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(requestKey('partner', own.request.id))}`);
    assert.match(th.body.messages[0].body, /The agent read it in \[a thread\]\(\/inbox\?team=helix&t=slack%3AE1%3AC1%3A1\.1\)/);
    // In a partner's thread, the partner is its own; for the person who asked, theirs.
    const theirs = {
      key: 'slack:E1:C2:2.1', org: 'agency', orgType: 'partner', channelName: 'aem-agency',
    };
    const asked = await quiet(() => requestPartnerLink(e, theirs, { email: 'bo@staff.example', name: 'Bo' }, {
      action: 'end', customer: 'globex', until: '2026-10', note: 'Bo says the contract ended',
    }));
    assert.deepEqual([asked.request.partner, asked.request.customer, asked.request.requestedBy.email, asked.request.viaAgent], ['agency', 'globex', 'bo@staff.example', true]);
  });
});
