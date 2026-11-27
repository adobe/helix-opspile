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
import { evidenceItem, requestPartnerLink } from '../src/agent/partnerrequest.js';
import { forgetFacts } from '../src/orgmerge.js';
import {
  AGAIN_DAYS, conflictOf, customersOf, ENDED_P, forgetEvidence, GOING_ON_DAYS, LAPSED_DAYS,
  partnersOf, partnerWants, quietOf, standingOf, standingWords, UNSURE_HIGH, UNSURE_LOW,
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
    const wants = (more) => partnerWants([pair(more)], orgs, seen);
    // The band's edges ask; what is above or below it does not.
    const edges = [0.34, UNSURE_LOW, 0.5, UNSURE_HIGH, 0.66];
    assert.deepEqual(edges.map((p) => wants({ p }).length), [0, 1, 1, 1, 0]);
    assert.equal(wants({ p: UNSURE_LOW })[0].fingerprint, 'f');
    // Nobody asked Clef yet, or not on what it is shown now: no request.
    assert.deepEqual(wants({ p: null }), []);
    assert.deepEqual(partnerWants([pair({ p: 0.5 })], orgs, new Map()), []);
    // Sure, on one kind alone that is no posting together.
    const [alone] = wants({ signals: [sig('owners')] });
    assert.deepEqual([alone.action, alone.fingerprint], ['link', 'f']);
    assert.match(alone.note, /^Clef is sure, 90%, that The Agency works for Globex, from one kind of evidence alone: owners found\.$/);
    assert.equal(wants({ signals: [sig('members')] }).length, 1);
    assert.deepEqual(wants({ signals: [sig('posters')] }), []);
    assert.deepEqual(wants({ signals: [sig('channel')] }), []);
    // Sure, and quiet: no request on silence alone, nor on one kind of evidence; an end only
    // where Clef judged it ended, on this quiet.
    const day0 = '2026-08-01';
    assert.deepEqual(wants({ quiet: day0 }), []);
    assert.deepEqual(wants({ quiet: day0, signals: [sig('owners')] }), []);
    assert.deepEqual(wants({ quiet: day0, endedP: 0.7, endedFor: day0 }), []);
    assert.deepEqual(wants({ quiet: day0, endedP: 0.9, endedFor: '2026-07-01' }), []);
    // Nobody confirmed it: a review, for ending it would confirm it too, the admin team's call.
    const [review] = wants({ quiet: day0, endedP: ENDED_P, endedFor: day0 });
    assert.deepEqual([review.action, review.until, review.fingerprint], ['review', undefined, `ended:${day0}`]);
    assert.match(review.note, /^Clef judges 80% that The Agency stopped working for Globex.*Nobody confirmed it/);
    // Confirmed, an end.
    const [ended] = wants({
      quiet: day0, endedP: ENDED_P, endedFor: day0, confirmed: { by: 'ada', at: AT }, candidate: false,
    });
    assert.deepEqual([ended.action, ended.until, ended.fingerprint], ['end', day0, `end:${day0}`]);
    assert.match(ended.note, /^Clef judges 80% that The Agency stopped working for Globex/);
    // A conflict is a sure pair's: the unsure one is asked as unsure.
    assert.match(wants({ p: 0.6, signals: [sig('owners')] })[0].note, /^Clef is unsure, 60%/);
    assert.deepEqual(conflictOf(pair({})), null);
  });

  it('say how a pair stands, in words for the agents', () => {
    const at = { by: 'ada', at: AT };
    const said = (x) => standingOf(x).status;
    assert.deepEqual([
      said(null), said({ p: null }), said({ p: 0.2 }), said({ p: 0.4 }), said({ p: 0.55 }),
      said({ p: 0.9 }),
      said({ confirmed: at, p: 0.2 }), said({ confirmed: at, until: '2026-06' }), said({ dismissed: at, p: 0.9 }),
      said({ confirmed: at, quiet: '2026-06-01' }), said({ p: 0.9, quiet: '2026-06-01' }),
      said({ p: 0.4, quiet: '2026-06-01' }), said({ confirmed: at, until: '2026-06', quiet: '2026-06-01' }),
    ], ['none', 'unknown', 'unlikely', 'unsure', 'likely', 'sure', 'confirmed', 'former', 'dismissed',
      'quiet', 'quiet', 'unsure', 'former']);
    assert.equal(standingWords(standingOf({ confirmed: at, quiet: '2026-06-01' })), 'confirmed by the admin team, but quiet: none of its people posted in the customer\'s threads since 2026-06-01, which is no end');
    assert.match(standingWords(standingOf({ p: 0.9, quiet: '2026-06-01' })), /^not decided; a partner as Clef says \(90%\), but quiet/);
    assert.equal(standingWords(standingOf({ p: 0.4 })), 'not decided and not linked; Clef is unsure (40%)');
    assert.equal(standingWords(standingOf({ confirmed: at, until: '2026-06' })), 'a former partner, until 2026-06, as the admin team said');
    assert.equal(standingWords(standingOf({ p: 0.92 })), 'not decided; Clef is sure (92%), so it counts as a partner');
  });

  it('call a partner quiet whose people stopped posting, and one again who posts again', () => {
    const day = 24 * 3600 * 1000;
    const now = Date.parse('2026-11-26T00:00:00Z');
    const iso = (ms) => new Date(ms).toISOString();
    const orgs = new Map([['globex', { slug: 'globex', name: 'Globex', latest: iso(now - day) }],
      ['agency', { slug: 'agency', name: 'The Agency' }]]);
    const pair = (more) => ({
      customer: 'globex', partner: 'agency', signals: [], p: null, candidate: false, confirmed: { by: 'ada', at: AT }, dismissed: null, until: null, first: null, last: null, seen: null, ...more,
    });
    const lapsed = iso(now - (LAPSED_DAYS + 1) * day);
    assert.equal(quietOf(pair({ last: lapsed }), orgs, now), lapsed.slice(0, 10));
    // Quiet alone asks nothing: a confirmed partner of now, whatever its silence.
    const quietPair = pair({ last: lapsed, quiet: lapsed.slice(0, 10) });
    assert.deepEqual(partnerWants([quietPair], orgs, new Map()), []);
    // Not while it posts, nor while the customer is as quiet, nor after an agent saw them at work.
    assert.equal(quietOf(pair({ last: iso(now - 10 * day) }), orgs, now), null);
    const quietCustomer = new Map([...orgs, ['globex', {
      slug: 'globex', latest: iso(Date.parse(lapsed) + (GOING_ON_DAYS - 1) * day),
    }]]);
    assert.equal(quietOf(pair({ last: lapsed }), quietCustomer, now), null);
    assert.equal(quietOf(pair({ last: lapsed, seen: { by: 'agent', at: iso(now - 5 * day) } }), orgs, now), null);
    // Nor a former partner, nor a pair nobody counts as partners.
    assert.equal(quietOf(pair({ last: lapsed, until: '2026-06' }), orgs, now), null);
    assert.equal(quietOf(pair({ last: lapsed, confirmed: null, p: 0.4 }), orgs, now), null);
    const sure = pair({ last: lapsed, confirmed: null, p: 0.9 });
    assert.equal(quietOf(sure, orgs, now), lapsed.slice(0, 10));
    // Ended, and its people post again: a partner again?
    const [again] = partnerWants([pair({ until: '2026-09', last: iso(Date.parse('2026-09-28T23:59:59Z') + (AGAIN_DAYS + 1) * day) })], orgs, new Map());
    assert.deepEqual([again.action, again.fingerprint], ['link', 'again:2026-09']);
    // A dismissed pair, or one Clef finds unlikely, is no request.
    const seen = new Map([['globex\nagency', 'f']]);
    const dismissed = pair({
      confirmed: null, dismissed: { by: 'ada' }, p: 0.9, candidate: true,
    });
    assert.deepEqual(partnerWants([dismissed], orgs, seen), []);
    const unlikely = pair({ confirmed: null, p: 0.3, candidate: true });
    assert.deepEqual(partnerWants([unlikely], orgs, seen), []);
  });

  it('end a quiet partner only where Clef judges it ended, from its last posts and the customer\'s threads', async () => {
    const e = env();
    const sql = e.DB.sqlite;
    const old = new Date(Date.now() - 200 * 86400000).toISOString();
    const recent = new Date(Date.now() - 86400000).toISOString();
    // The agency's people last posted 200 days ago; Globex's threads went on since.
    sql.exec(`UPDATE messages SET at = '${old}' WHERE author_key IN ('slack:E1:U1', 'slack:E1:U2') AND channel_id = 'C1';
      UPDATE messages SET at = '${recent}' WHERE author_key = 'slack:E1:U3';
      UPDATE threads SET last_at = '${recent}', any_at = '${recent}' WHERE thread = 'slack:E1:C1:1.1'`);
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' }));
    // Clef's end request of before, filed on silence alone.
    sql.exec(`INSERT INTO org_partner_requests (customer, partner, action, until, fingerprint, requested_by,
      requested_at) VALUES ('globex', 'agency', 'end', '2026-05-01', 'end:2026-05-01', 'clef', '${AT}')`);
    const asked = [];
    let ended = 0.3;
    e.AI = {
      async run(model, input) {
        if (input.questions.ended) {
          asked.push(input.state);
          return { answers: { ended: { type: 'noul', noul: ended } } };
        }
        return { answers: { works: { type: 'noul', noul: 0.2 } } };
      },
    };
    const sync = () => quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    await sync();
    const day = old.slice(0, 10);
    assert.deepEqual(rows(e, "SELECT quiet_since, ended_p, ended_fingerprint FROM org_partners WHERE partner = 'agency'"), [{ quiet_since: day, ended_p: 0.3, ended_fingerprint: day }]);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /P's last posts in C's threads:\n- \[/);
    assert.match(asked[0], /C's latest threads:\n- /);
    // Quiet is no end: Clef's request of before is taken back, saying why.
    assert.deepEqual(rows(e, "SELECT status, reason FROM org_partner_requests WHERE action = 'end'"), [{
      status: 'withdrawn', reason: `Clef does not judge it ended, 30% that it ended: its people are only quiet since ${day}`,
    }]);
    // Everyone reads it quiet, and an agent hears so.
    const [agency] = await partnersOf(e, 'globex');
    assert.equal(agency.quiet, day);
    // Judged again only after a week, or a new quiet: then it asks to end it.
    await sync();
    assert.equal(asked.length, 1);
    ended = 0.9;
    sql.exec("UPDATE org_partners SET ended_checked_at = '2020-01-01T00:00:00Z'");
    await sync();
    assert.equal(asked.length, 2);
    const [q] = rows(e, "SELECT * FROM org_partner_requests WHERE status = 'open'");
    assert.deepEqual([q.action, q.until, q.fingerprint], ['end', day, `end:${day}`]);
    assert.match(q.note, /^Clef judges 90% that The Agency stopped working for Globex/);
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
      key: 'slack:E1:C1:1.1', org: 'globex', orgType: 'customer', orgName: 'Globex', channelName: 'aem-globex', team: 'helix', channelId: 'C1', kind: 'channel', source: 'slack',
    };
    const here = [{ why: 'Hank says Studio takes over the site in November' }];
    assert.match((await requestPartnerLink(e, t, null, { action: 'link', note: 'x', evidence: here })).error, /give the partner/);
    assert.match((await requestPartnerLink(e, t, null, { action: 'link', partner: 'studio', evidence: here })).error, /say why/);
    // Never without evidence, each item with why, and only of what it may read.
    assert.match((await requestPartnerLink(e, t, null, { action: 'link', partner: 'studio', note: 'x' })).error, /give `evidence`/);
    assert.match((await requestPartnerLink(e, t, null, {
      action: 'link', partner: 'studio', note: 'x', evidence: [{}],
    })).error, /say `why`/);
    assert.match((await requestPartnerLink(e, t, null, {
      action: 'link', partner: 'studio', note: 'x', evidence: [{ ref: 'slack:E1:C9:9.9', why: 'x' }],
    })).error, /no thread has/);
    assert.match((await requestPartnerLink(e, t, null, {
      action: 'link', partner: 'studio', note: 'x', evidence: [{ ref: 'slack:E1:C1:1.1|nope', why: 'x' }],
    })).error, /no message nope/);
    // A message link resolves by its channel and ids, as the agents' links do.
    e.DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key)
      VALUES ('slack', 'E1', 'C1', '1761000000.000100', 'slack:E1:C1:1.3', '${AT}', 0, 1, 'slack:E1:U3')`);
    const link = await evidenceItem(e, t, {
      ref: 'https://acme.slack.com/archives/C1/p1761000000000100?thread_ts=1.3', why: 'Hank says so',
    });
    assert.deepEqual([link.thread, link.message], ['slack:E1:C1:1.3', '1761000000.000100']);
    // A reply's link whose root the inbox has too: the reply, not its root.
    e.DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key)
      VALUES ('slack', 'E1', 'C1', '1761000000.000050', 'slack:E1:C1:1.3', '${AT}', 0, 1, 'slack:E1:U3')`);
    const reply = await evidenceItem(e, t, {
      ref: 'https://acme.slack.com/archives/C1/p1761000000000100?thread_ts=1761000000.000050', why: 'Hank replies',
    });
    assert.deepEqual([reply.thread, reply.message], ['slack:E1:C1:1.3', '1761000000.000100']);
    // A link to the root alone is the root.
    const root = await evidenceItem(e, t, { ref: 'https://acme.slack.com/archives/C1/p1761000000000050', why: 'x' });
    assert.equal(root.message, '1761000000.000050');
    const elsewhere = await evidenceItem(e, t, {
      ref: 'https://acme.slack.com/archives/C9/p1761000000000100', why: 'x',
    });
    assert.match(elsewhere.error, /no thread has/);
    const own = await quiet(() => requestPartnerLink(e, t, null, {
      action: 'link',
      partner: 'studio',
      since: '2026-11',
      note: 'Hank says Studio takes over the site in November',
      evidence: [...here, { ref: 'slack:E1:C1:1.2|m4', why: 'Road asks Studio for the handover' }],
    }));
    assert.deepEqual([own.request.customer, own.request.partner, own.request.requestedBy.kind, own.request.thread, own.evidence], ['globex', 'studio', 'agent', t.key, 2]);
    assert.equal(own.request.requestedBy.name, 'The agent of a thread in #aem-globex');
    assert.deepEqual(own.request.evidence.map((x) => [x.thread, x.message, x.why]), [
      [t.key, null, 'Hank says Studio takes over the site in November'],
      ['slack:E1:C1:1.2', 'm4', 'Road asks Studio for the handover'],
    ]);
    const th = await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(requestKey('partner', own.request.id))}`);
    assert.match(th.body.messages[0].body, /The agent read it in \[a thread\]\(\/inbox\?team=helix&t=slack%3AE1%3AC1%3A1\.1\)/);
    assert.match(th.body.messages[0].body, /- Evidence:\n {2}- \[a thread\]\(\/inbox\?team=helix&t=slack%3AE1%3AC1%3A1\.1\): Hank says Studio takes over the site in November — The agent of a thread in #aem-globex/);
    // Asked again, its evidence goes to the request that waits, and the answer says so.
    const again = await quiet(() => requestPartnerLink(e, t, null, {
      action: 'review', partner: 'studio', note: 'Looks uncertain', evidence: [{ why: 'Hank is not sure' }],
    }));
    assert.deepEqual(
      [again.added, again.request.id, again.request.evidence.length],
      [true, own.request.id, 3],
    );
    assert.equal(rows(e, 'SELECT * FROM org_partner_requests').length, 1);
    // Bo is no admin: he reads none of the agent's evidence.
    const bo = await call(e, BO, 'GET', '/api/admin/org-partners?pair=globex:studio');
    assert.deepEqual(bo.body.requests[0].evidence, []);
    // In a partner's thread, the partner is its own; for the person who asked, theirs.
    const theirs = {
      key: 'slack:E1:C2:2.1', org: 'agency', orgType: 'partner', channelName: 'aem-agency',
    };
    const asked = await quiet(() => requestPartnerLink(e, theirs, { email: 'bo@staff.example', name: 'Bo' }, {
      action: 'end', customer: 'globex', until: '2026-10', note: 'Bo says the contract ended', evidence: [{ why: 'Bo says so' }],
    }));
    assert.deepEqual([asked.request.partner, asked.request.customer, asked.request.requestedBy.email, asked.request.viaAgent], ['agency', 'globex', 'bo@staff.example', true]);
  });

  it('are an agent\'s review of a pair, with its own actions in the admin inbox', async () => {
    const e = env();
    const t = {
      key: 'slack:E1:C1:1.1', org: 'globex', orgType: 'customer', channelName: 'aem-globex', team: 'helix', channelId: 'C1', kind: 'channel', source: 'slack',
    };
    const r = await quiet(() => requestPartnerLink(e, t, null, {
      action: 'review', partner: 'agency', note: 'Hank says the agency works for another customer here', evidence: [{ why: 'Hank corrects it in the thread' }],
    }));
    assert.equal(r.request.action, 'review');
    const key = requestKey('partner', r.request.id);
    const th = await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`);
    assert.equal(th.body.thread.title, 'The Agency and Globex: please look');
    assert.deepEqual(th.body.request.actions.map((a) => a.id), ['confirm', 'end', 'dismiss', 'decline']);
    // Not partners settles it.
    await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'dismiss', values: {} }));
    assert.deepEqual(rows(e, `SELECT status FROM org_partner_requests WHERE id = ${r.request.id}`), [{ status: 'dismissed' }]);
  });

  it('are taken back where an agent sees a quiet pair still working together, which decides nothing', async () => {
    const e = env();
    const sql = e.DB.sqlite;
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' }));
    sql.exec(`UPDATE org_partners SET quiet_since = '2026-05-01' WHERE partner = 'agency';
      INSERT INTO org_partner_requests (customer, partner, action, until, fingerprint, requested_by,
        requested_at) VALUES ('globex', 'agency', 'end', '2026-05-01', 'end:2026-05-01', 'clef', '${AT}')`);
    const t = {
      key: 'slack:E1:C2:2.1', org: 'agency', orgType: 'partner', channelName: 'aem-agency', team: 'helix', channelId: 'C2', kind: 'channel', source: 'slack',
    };
    const res = await quiet(() => requestPartnerLink(e, t, null, {
      action: 'active', customer: 'globex', note: 'They plan Globex\'s next release here', evidence: [{ why: 'Wile plans the Globex release in this thread' }],
    }));
    assert.equal(res.active.withdrawn.length, 1);
    const [pair] = rows(e, "SELECT confirmed_at IS NOT NULL AS c, quiet_since, seen_by, until FROM org_partners WHERE partner = 'agency'");
    assert.deepEqual(pair, {
      c: 1, quiet_since: null, seen_by: 'agent', until: null,
    });
    assert.deepEqual(rows(e, "SELECT status, decided_by FROM org_partner_requests WHERE action = 'end'"), [{ status: 'withdrawn', decided_by: 'agent' }]);
    assert.deepEqual(rows(e, 'SELECT kind, request IS NOT NULL AS r, why FROM org_partner_evidence'), [{ kind: 'active', r: 1, why: 'Wile plans the Globex release in this thread' }]);
    // Seen again, with no request to go to: kept with the pair alone, and no request is opened.
    const again = await quiet(() => requestPartnerLink(e, t, null, {
      action: 'active', customer: 'globex', note: 'Still at it', evidence: [{ why: 'Road ships the Globex fix here' }],
    }));
    assert.deepEqual(again.active.withdrawn, []);
    assert.equal(rows(e, "SELECT * FROM org_partner_requests WHERE status = 'open'").length, 0);
    assert.deepEqual(rows(e, 'SELECT request FROM org_partner_evidence ORDER BY id DESC LIMIT 1'), [{ request: null }]);
    // The pair's page shows the latest, when and who to everyone, what and where to the admin team.
    const today = new Date().toISOString().slice(0, 10);
    const bo = (await call(e, BO, 'GET', '/api/admin/org-partners?pair=globex:agency')).body.pairs[0];
    assert.deepEqual([bo.active.at.slice(0, 10), bo.active.addedBy.name, bo.active.why], [today, 'The agent of a thread in #aem-agency', undefined]);
    assert.equal(bo.standing.seen, today);
    const ada = (await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?pair=globex:agency'))).body.pairs[0];
    assert.deepEqual([ada.active.why, ada.active.thread], ['Road ships the Globex fix here', 'slack:E1:C2:2.1']);
    assert.match(standingWords(ada.standing), /; a thread's agent saw them working together on \d{4}-\d{2}-\d{2}$/);
    // A pair the admin team said is none, or ended, stays so.
    await quiet(() => call(e, ADA, 'POST', '/api/admin/org-partners/end', { customer: 'globex', partner: 'agency', until: '2026-10' }));
    const ended = await requestPartnerLink(e, t, null, {
      action: 'active', customer: 'globex', note: 'x', evidence: [{ why: 'x' }],
    });
    assert.match(ended.error, /former partner/);
    assert.equal(rows(e, "SELECT until FROM org_partners WHERE partner = 'agency'")[0].until, '2026-10');
  });
});
