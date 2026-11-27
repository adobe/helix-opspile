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
import { forgetFacts } from '../src/orgmerge.js';
import { forgetPartnerDomains } from '../src/partners.js';
import {
  contextOf, customersOf, forgetEvidence, ownerOf, partnerCandidates, partnersOf, partnerSignals,
  refreshPartners,
} from '../src/orgpartners.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels, sites and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: [],
};
const asMe = (p) => ({ ...p, teams: p.teams.map((t) => (typeof t === 'string' ? { slug: t } : t)) });
const AT = '2026-10-22T00:00:00Z';

/** Clef, made up: the agency works for Globex, and for nobody else. */
function fakeAI() {
  const asked = [];
  return {
    asked,
    async run(model, input) {
      asked.push(input.state);
      const yes = /C: slug globex,/.test(input.state) && /P: slug agency,/.test(input.state);
      return { answers: { works: { type: 'noul', noul: yes ? 0.9 : 0.2 } } };
    },
  };
}

/**
 * Globex and Initech are customers, the agency a partner. Two of the agency's people post in
 * Globex's threads, one is in Initech's channel, and both the agency's and Globex's threads name
 * the site owner `globex-web`.
 */
function env() {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  const sql = DB.sqlite;
  const channel = (id, name) => sql.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
    VALUES ('slack', 'E1', ?, ?, ?)`).run(id, name, AT);
  const thread = (id, root, org) => sql.prepare(`INSERT INTO threads (thread, source, tenant, channel_id,
      root_id, org, team, kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, ?, ?, 'helix', 'channel', '', ?, ?, ?, ?, 1, ?)`)
    .run(`slack:E1:${id}:${root}`, id, root, org, `channels/${org}/helix/slack-${id}/${root}/`, AT, AT, AT, AT);
  const person = (user, email) => sql.prepare(`INSERT INTO identities (source, tenant, user_id, kind, email,
    fetched_at) VALUES ('slack', 'E1', ?, 'person', ?, ?)`).run(user, email, AT);
  let n = 0;
  const post = (id, root, user) => {
    n += 1;
    sql.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted,
        author_key) VALUES ('slack', 'E1', ?, ?, ?, ?, 0, 1, ?)`)
      .run(id, `m${n}`, `slack:E1:${id}:${root}`, AT, `slack:E1:${user}`);
  };
  const member = (id, user, email) => sql.prepare(`INSERT INTO channel_members
    (source, tenant, channel_id, user_id, email) VALUES ('slack', 'E1', ?, ?, ?)`).run(id, user, email);
  const fact = (id, root, field, value) => sql.prepare(`INSERT INTO facts (thread, source, field, value)
    VALUES (?, 'rule', ?, ?)`).run(`slack:E1:${id}:${root}`, field, value);
  channel('C1', 'aem-globex');
  channel('C2', 'aem-agency');
  channel('C3', 'aem-initech');
  for (const root of ['1.1', '1.2', '1.3']) {
    thread('C1', root, 'globex');
  }
  thread('C2', '2.1', 'agency');
  thread('C3', '3.1', 'initech');
  sql.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES
    ('globex', 'Globex', 'customer', '${AT}'), ('agency', 'The Agency', 'partner', '${AT}'),
    ('initech', NULL, 'customer', '${AT}')`);
  person('U1', 'wile@agency.example');
  person('U2', 'road@agency.example');
  person('U3', 'hank@globex.example');
  person('U4', 'bill@initech.example');
  post('C2', '2.1', 'U1');
  post('C2', '2.1', 'U2');
  post('C1', '1.1', 'U3');
  post('C1', '1.1', 'U1');
  post('C1', '1.2', 'U2');
  post('C1', '1.3', 'U1');
  post('C3', '3.1', 'U4');
  member('C3', 'U1', 'wile@agency.example');
  member('C3', 'U4', 'bill@initech.example');
  fact('C1', '1.1', 'site', 'globex-web/www');
  fact('C2', '2.1', 'url', 'https://main--www--globex-web.aem.page/');
  return {
    DB, AI: fakeAI(), STAFF_DOMAINS: 'staff.example',
  };
}

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: asMe(me) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  forgetFacts();
  forgetEvidence();
  forgetPartnerDomains();
});

describe('partner owners', () => {
  it('reads the owner a site, a repository or a URL names', () => {
    assert.equal(ownerOf('site', 'Acme-Web/www'), 'acme-web');
    assert.equal(ownerOf('repo', 'acme/site-repo'), 'acme');
    assert.equal(ownerOf('url', 'https://main--www--acme-web.aem.live/en/'), 'acme-web');
    assert.equal(ownerOf('url', 'https://www--acme.hlx.page/'), 'acme');
    assert.equal(ownerOf('url', 'https://github.com/acme/www/pull/3'), 'acme');
    assert.equal(ownerOf('url', 'https://admin.hlx.page/preview/acme/www/main/index'), 'acme');
    assert.equal(ownerOf('url', 'https://www.acme.example/'), null);
    assert.equal(ownerOf('url', 'https://github.com/orgs/acme'), null);
    assert.equal(ownerOf('site', 'not a site'), null);
    assert.equal(ownerOf('cve', 'acme/www'), null);
  });
});

describe('partner signals', () => {
  const org = (slug, type, more = {}) => ({
    slug, name: null, type, icon: null, domains: [], channels: [], ...more,
  });
  const evidence = (more = {}) => ({
    posters: new Map(),
    members: new Map(),
    owners: new Map(),
    kb: new Map(),
    ...more,
  });
  const kinds = (c, p, ev, orgs = new Map([[c.slug, c], [p.slug, p]])) => partnerSignals(
    c,
    p,
    ev,
    contextOf(orgs, ev),
  ).map((s) => [s.kind, s.weight, s.n]);

  it('weighs the partner\'s people in the customer\'s threads and channels', () => {
    const ev = evidence({
      posters: new Map([
        ['agency', [{ domain: 'agency.example', threads: 30, people: 6 }]],
        ['globex', [{ domain: 'globex.example', threads: 40, people: 9 },
          { domain: 'agency.example', threads: 12, people: 3 }]],
      ]),
      members: new Map([['globex', new Map([['agency.example', 5]])]]),
    });
    assert.deepEqual(kinds(org('globex', 'customer'), org('agency', 'partner'), ev), [
      ['posters', 3, 12], ['members', 2, 5],
    ]);
    // And the customer's in the partner's.
    const back = evidence({
      posters: new Map([
        ['agency', [{ domain: 'agency.example', threads: 30, people: 6 },
          { domain: 'globex.example', threads: 4, people: 1 }]],
        ['globex', [{ domain: 'globex.example', threads: 40, people: 9 }]],
      ]),
    });
    assert.deepEqual(kinds(org('globex', 'customer'), org('agency', 'partner'), back), [['guests', 2, 4]]);
  });

  it('counts an owner only a few customers\' threads name', () => {
    const owners = (m) => evidence({
      owners: new Map(m.map(([o, list]) => [o, new Map(list.map((x) => [x, 1]))])),
    });
    const c = org('globex', 'customer');
    const p = org('agency', 'partner');
    const ev = owners([['globex', ['globex-web', 'adobe']], ['agency', ['globex-web', 'adobe']],
      ['initech', ['adobe']], ['hooli', ['adobe']]]);
    const orgs = new Map([['globex', c], ['agency', p], ['initech', org('initech', 'customer')],
      ['hooli', org('hooli', 'internal')]]);
    assert.deepEqual(kinds(c, p, ev, orgs), [['owners', 2.5, 1]]);
    // Named by two customers, it says less.
    ev.owners.get('initech').set('globex-web', 1);
    assert.deepEqual(kinds(c, p, ev, orgs), [['owners', 1.5, 1]]);
  });

  it('reads the partner\'s knowledge base for the customer\'s sites and name', () => {
    const entry = (path, body = '', title = '') => ({ path, head: `${path}\n${title}`.toLowerCase(), body });
    const c = org('globex', 'customer', { name: 'Globex Corp' });
    const p = org('agency', 'partner');
    const ev = (entries, owners = new Map()) => evidence({ kb: new Map([['agency', entries]]), owners });
    assert.deepEqual(kinds(c, p, ev([entry('sites/globex-main.md')])), [['kb', 3, 1]]);
    assert.deepEqual(kinds(c, p, ev([entry('issues/a.md', '', 'Globex Corp checkout')])), [['kb', 2, 1]]);
    const owned = new Map([['globex', new Map([['gx-web', 2]])]]);
    const site = entry('issues/b.md', 'see https://main--www--gx-web.aem.live/');
    assert.deepEqual(kinds(c, p, ev([site], owned)), [['kb', 2, 1]]);
    // A word in the text is not a name: a one-word slug, an owner outside an owner's place.
    assert.deepEqual(kinds(org('public', 'customer'), p, ev([entry('issues/c.md', '', 'public holidays')])), []);
    assert.deepEqual(kinds(c, p, ev([entry('issues/d.md', 'the gx-web team')], owned)), []);
  });

  it('sees a Slack Connect team both share, and a channel named for both', () => {
    const c = org('globex', 'customer', { channels: [{ label: '#aem-globex', places: ['connect:T1'] }] });
    const p = org('agency', 'partner', { channels: [{ label: '#agency-globex', places: ['connect:T1'] }] });
    assert.deepEqual(kinds(c, p, evidence()), [['place', 2, 1], ['channel', 3, 1]]);
  });

  it('lists the pairs of a customer and a partner whose signals add up', () => {
    const orgs = new Map([
      ['globex', org('globex', 'customer')], ['agency', org('agency', 'partner')],
      ['initech', org('initech', 'customer')], ['vendor', org('vendor', 'vendor')],
    ]);
    const ev = evidence({
      posters: new Map([
        ['agency', [{ domain: 'agency.example', threads: 5, people: 2 }]],
        ['globex', [{ domain: 'agency.example', threads: 3, people: 2 }]],
        ['initech', [{ domain: 'agency.example', threads: 1, people: 1 }]],
        ['vendor', [{ domain: 'agency.example', threads: 9, people: 3 }]],
      ]),
    });
    assert.deepEqual(partnerCandidates({ orgs }, ev).map((x) => [x.customer, x.partner, x.score]), [
      ['globex', 'agency', 2],
    ]);
  });

  it('takes a knowledge-base entry or a shared team alone for no candidate', () => {
    const c = org('globex', 'customer', { channels: [{ label: '#aem-globex', places: ['connect:T1'] }] });
    const p = org('agency', 'partner', { channels: [{ label: '#aem-agency', places: ['connect:T1'] }] });
    const orgs = new Map([['globex', c], ['agency', p]]);
    const pairs = (ev) => partnerCandidates({ orgs }, ev).map((x) => x.signals.map((s) => s.kind));
    const entry = { path: 'sites/globex-www.md', head: 'sites/globex-www.md', body: '' };
    // A shared team (2) and an entry about it (3) weigh enough, but say nothing alone.
    assert.deepEqual(pairs(evidence()), []);
    c.channels = [{ label: '#aem-globex', places: [] }];
    assert.deepEqual(pairs(evidence({ kb: new Map([['agency', [entry]]]) })), []);
    // With a second signal, they do.
    assert.deepEqual(pairs(evidence({
      kb: new Map([['agency', [entry]]]),
      posters: new Map([['agency', [{ domain: 'agency.example', threads: 5, people: 2 }]],
        ['globex', [{ domain: 'agency.example', threads: 1, people: 1 }]]]),
    })), [['posters', 'kb']]);
  });

  it('counts the people of every mail domain of the partner', () => {
    const c = org('globex', 'customer');
    const p = org('agency', 'partner');
    const orgs = new Map([['globex', c], ['agency', p]]);
    const ev = evidence({
      posters: new Map([['globex', [{ domain: 'agency.example', threads: 4, people: 1 },
        { domain: 'agency-group.example', threads: 6, people: 2 }]]]),
      members: new Map([['globex', new Map([['agency.example', 1], ['agency-group.example', 2]])]]),
    });
    // The threads show none of the partner's own (it posts nowhere itself); its domains are given.
    assert.deepEqual(partnerSignals(c, p, ev, contextOf(orgs, ev)), []);
    const ctx = contextOf(orgs, ev, new Map([['agency.example', 'agency'], ['agency-group.example', 'agency']]));
    assert.deepEqual(partnerSignals(c, p, ev, ctx).map((s) => [s.kind, s.n, s.people ?? null]), [
      ['posters', 6, 3], ['members', 3, null],
    ]);
  });
  it('takes no partner\'s domain for the customer\'s usual one', () => {
    // An integrator's people outnumber the customer's in its channel, and post in a studio's too.
    const c = org('globex', 'customer');
    const si = org('integrator', 'partner');
    const studio = org('studio', 'partner');
    const orgs = new Map([['globex', c], ['integrator', si], ['studio', studio]]);
    const ev = evidence({
      posters: new Map([
        ['globex', [{ domain: 'integrator.example', threads: 30, people: 5 },
          { domain: 'globex.example', threads: 6, people: 2 }]],
        ['studio', [{ domain: 'studio.example', threads: 200, people: 8 },
          { domain: 'integrator.example', threads: 70, people: 3 }]],
      ]),
    });
    const domains = new Map([['integrator.example', 'integrator'], ['studio.example', 'studio']]);
    const ctx = contextOf(orgs, ev, domains);
    assert.equal(ctx.usual.get('globex'), 'globex.example');
    // The integrator's people are no guests of the studio's from the customer.
    assert.deepEqual(partnerSignals(c, studio, ev, ctx), []);
    assert.deepEqual(partnerSignals(c, si, ev, ctx).map((s) => [s.kind, s.n]), [['posters', 30]]);
    // A domain that is no partner's (excluded) may be its usual one.
    const excluded = contextOf(orgs, ev, new Map([['integrator.example', null]]));
    assert.equal(excluded.usual.get('globex'), 'integrator.example');
  });
});

describe('admin: partners', () => {
  it('tells Clef the customer\'s confirmed partners, and shows the customer\'s own mail only', async () => {
    const e = env();
    const sql = e.DB.sqlite;
    // A studio: one of its people posts in two of Globex's threads and is in its channel.
    sql.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('studio', 'Studio', 'partner', '${AT}');
      INSERT INTO channels (source, tenant, channel_id, name, fetched_at) VALUES ('slack', 'E1', 'C4', 'aem-studio', '${AT}');
      INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name, path, root_at,
        last_at, any_at, messages, updated_at) VALUES ('slack:E1:C4:4.1', 'slack', 'E1', 'C4', '4.1', 'studio', 'helix',
        'channel', '', 'channels/studio/helix/slack-C4/4.1/', '${AT}', '${AT}', '${AT}', 1, '${AT}');
      INSERT INTO identities (source, tenant, user_id, kind, email, fetched_at)
        VALUES ('slack', 'E1', 'U5', 'person', 'sue@studio.example', '${AT}');
      INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key) VALUES
        ('slack', 'E1', 'C4', 's1', 'slack:E1:C4:4.1', '${AT}', 0, 1, 'slack:E1:U5'),
        ('slack', 'E1', 'C1', 's2', 'slack:E1:C1:1.1', '${AT}', 0, 1, 'slack:E1:U5'),
        ('slack', 'E1', 'C1', 's3', 'slack:E1:C1:1.2', '${AT}', 0, 1, 'slack:E1:U5');
      INSERT INTO channel_members (source, tenant, channel_id, user_id, email)
        VALUES ('slack', 'E1', 'C1', 'U5', 'sue@studio.example')`);
    const r = await call(e, ADA, 'GET', '/api/admin/org-partners');
    assert.deepEqual(r.body.pairs.map((x) => x.partner).sort(), ['agency', 'studio']);
    const told = () => e.AI.asked.filter((x) => /P: slug studio,/.test(x)).at(-1);
    assert.ok(!/confirmed/.test(told()));
    // Globex's mail is its own: the partners' domains are theirs.
    assert.deepEqual(r.body.orgs.globex.domains, ['globex.example']);
    // The agency confirmed, Clef is asked about the studio again, told of the agency.
    await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' });
    await call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1');
    assert.match(told(), /C's partners the admin team confirmed: "The Agency" \(a few of its people posted in a few of C's threads\)\./);
    // Nobody is told of themselves.
    assert.ok(!e.AI.asked.some((x) => /P: slug agency,/.test(x) && /confirmed/.test(x)));
  });

  it('lists the candidates with Clef, keeps what it said, and asks again only on a change', async () => {
    const e = env();
    assert.equal((await call(e, BO, 'GET', '/api/admin/org-partners')).status, 403);
    const r = await call(e, ADA, 'GET', '/api/admin/org-partners');
    assert.equal(r.status, 200);
    const [pair, ...rest] = r.body.pairs;
    assert.deepEqual([pair.customer, pair.partner, pair.p], ['globex', 'agency', 0.9]);
    assert.deepEqual(pair.signals.map((s) => [s.kind, s.n]), [['posters', 3], ['owners', 1]]);
    assert.deepEqual(rest.map((x) => [x.customer, x.partner]), []);
    assert.equal(r.body.orgs.agency.name, 'The Agency');
    assert.equal(r.body.unchecked, 0);
    const asked = e.AI.asked.length;
    await call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1');
    assert.equal(e.AI.asked.length, asked);
    // Clef does not see the message text, nor counts that grow with every thread.
    assert.ok(!/3 threads/.test(e.AI.asked[0]));
    // One pair, whatever its signals: Initech has one of the agency's people in its channel.
    const one = await call(e, ADA, 'GET', '/api/admin/org-partners?pair=initech:agency');
    assert.deepEqual(one.body.pairs.map((x) => [x.customer, x.candidate]), [['initech', false]]);
    assert.deepEqual(one.body.pairs[0].signals.map((s) => s.kind), ['members']);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/org-partners?pair=initech:nobody')).status, 404);
  });

  it('confirms and dismisses a pair, and everyone at Adobe reads the confirmed and likely ones', async () => {
    const e = env();
    await call(e, ADA, 'GET', '/api/admin/org-partners');
    // Likely, says Clef: everyone at Adobe sees it, with counts and no text.
    let r = await call(e, BO, 'GET', '/api/customers/partners?org=globex');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.partners, [{
      slug: 'agency',
      name: 'The Agency',
      type: 'partner',
      icon: null,
      confirmed: false,
      current: true,
      since: '2026-10-22',
      until: null,
      last: AT,
      quiet: null,
      p: 0.9,
      score: 4.5,
      signals: { posters: 3, owners: 1 },
    }]);
    assert.deepEqual(r.body.customers, []);
    assert.deepEqual((await customersOf(e, 'agency')).map((x) => x.slug), ['globex']);
    assert.equal((await call(e, BO, 'POST', '/api/admin/org-partners/confirm', { customer: 'initech', partner: 'agency' })).status, 403);
    // Initech's is no candidate; the admin team confirms it all the same.
    r = await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'initech', partner: 'agency' });
    assert.equal(r.body.pair.confirmed.by, 'ada@staff.example');
    r = await call(e, ADA, 'POST', '/api/admin/org-partners/dismiss', { customer: 'globex', partner: 'agency' });
    assert.equal(r.body.pair.dismissed.by, 'ada@staff.example');
    assert.deepEqual((await customersOf(e, 'agency')).map((x) => [x.slug, x.confirmed]), [['initech', true]]);
    // Clef is not asked about a decided pair, and the list shows the decided last.
    const asked = e.AI.asked.length;
    const list = await call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1');
    assert.equal(e.AI.asked.length, asked);
    const said = (x) => [x.customer, Boolean(x.confirmed), Boolean(x.dismissed)];
    assert.deepEqual(list.body.pairs.map(said), [
      ['globex', false, true], ['initech', true, false],
    ]);
    // Undone, Clef's verdict is what is said again; confirming replaces a dismissal.
    await call(e, ADA, 'POST', '/api/admin/org-partners/dismiss', { customer: 'globex', partner: 'agency', undo: true });
    assert.deepEqual((await partnersOf(e, 'globex')).map((x) => [x.slug, x.confirmed]), [['agency', false]]);
    r = await call(e, ADA, 'POST', '/api/admin/org-partners/dismiss', { customer: 'globex', partner: 'agency' });
    r = await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' });
    assert.deepEqual([Boolean(r.body.pair.confirmed), r.body.pair.dismissed], [true, null]);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'globex' })).status, 400);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'nobody' })).status, 404);
  });

  it('opens a pair\'s page to the ops teams, its evidence as counts, and leaves deciding to the admin team', async () => {
    const e = env();
    // A request of Clef's, and one of an agent's, whose notes say what they found.
    e.DB.sqlite.exec(`INSERT INTO org_partner_requests (customer, partner, action, note, fingerprint,
        requested_by, requested_at) VALUES
      ('globex', 'agency', 'link', 'wile@agency.example posted about globex-web/www', 'f', 'clef', '${AT}'),
      ('globex', 'agency', 'end', 'Hank wrote: our agency.example contract ends', NULL, 'agent', '${AT}')`);
    // The list is the admin team's; one pair anyone's on an ops team, nobody's else.
    assert.equal((await call(e, BO, 'GET', '/api/admin/org-partners')).status, 403);
    assert.equal((await call(e, CY, 'GET', '/api/admin/org-partners?pair=globex:agency')).status, 403);
    const page = await quiet(() => call(e, BO, 'GET', '/api/admin/org-partners?pair=globex:agency'));
    assert.equal(page.status, 200);
    const [pair] = page.body.pairs;
    assert.deepEqual(pair.signals, [{ kind: 'posters', n: 3, people: 2 }, { kind: 'owners', n: 1 }]);
    assert.deepEqual([pair.p, pair.standing.status], [0.9, 'sure']);
    assert.deepEqual([page.body.orgs.globex.domains, page.body.orgs.agency.domain], [[], null]);
    assert.equal(page.body.requests.length, 2);
    assert.ok(page.body.requests.every((r) => r.note === null && !('fingerprint' in r)));
    // No domain, site owner, entry path or message text.
    const text = JSON.stringify(page.body);
    for (const secret of ['agency.example', 'globex.example', 'globex-web', 'Hank', 'wrote']) {
      assert.ok(!text.includes(secret), secret);
    }
    // The admin team reads all of it.
    const admin = await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?pair=globex:agency'));
    assert.match(admin.body.pairs[0].signals[0].text, /agency\.example/);
    assert.ok(admin.body.requests.some((r) => r.note));
    // Bo asks from it, and decides nothing.
    for (const what of ['confirm', 'dismiss', 'end']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await call(e, BO, 'POST', `/api/admin/org-partners/${what}`, { customer: 'globex', partner: 'agency', until: '2026-10' })).status, 403);
    }
    assert.equal((await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', {
      customer: 'initech', partner: 'agency', action: 'link', note: 'Bill said',
    }))).status, 200);
    const mine = await quiet(() => call(e, BO, 'GET', '/api/admin/org-partners?pair=initech:agency'));
    assert.equal(mine.body.requests[0].note, 'Bill said');
  });

  it('reads one pair for its page, asking Clef of that pair at most, and files nothing', async () => {
    const e = env();
    // A second candidate, the studio's: a sync would ask Clef about it too.
    e.DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('studio', 'Studio', 'partner', '${AT}');
      INSERT INTO identities (source, tenant, user_id, kind, email, fetched_at)
        VALUES ('slack', 'E1', 'U5', 'person', 'sue@studio.example', '${AT}');
      INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key) VALUES
        ('slack', 'E1', 'C1', 's2', 'slack:E1:C1:1.1', '${AT}', 0, 1, 'slack:E1:U5'),
        ('slack', 'E1', 'C1', 's3', 'slack:E1:C1:1.2', '${AT}', 0, 1, 'slack:E1:U5');
      INSERT INTO channel_members (source, tenant, channel_id, user_id, email)
        VALUES ('slack', 'E1', 'C1', 'U5', 'sue@studio.example')`);
    // Clef is unsure of every pair: a sync would file a request for each.
    const asked = [];
    e.AI = {
      async run(model, input) {
        asked.push(input.state);
        return { answers: { works: { type: 'noul', noul: 0.6 } } };
      },
    };
    const requests = () => e.DB.rows('SELECT customer, partner FROM org_partner_requests');
    const page = await quiet(() => call(e, BO, 'GET', '/api/admin/org-partners?pair=globex:agency'));
    assert.equal(page.status, 200);
    assert.equal(asked.length, 1);
    assert.ok(/C: slug globex,/.test(asked[0]) && /P: slug agency,/.test(asked[0]));
    const [pair] = page.body.pairs;
    assert.deepEqual([pair.p, pair.standing.status, pair.candidate, page.body.unchecked], [0.6, 'likely', true, 0]);
    assert.deepEqual(e.DB.rows('SELECT customer, partner, p FROM org_partners'), [{ customer: 'globex', partner: 'agency', p: 0.6 }]);
    assert.deepEqual(requests(), []);
    // Its verdict is kept: read again, Clef is not asked; nor of a pair that is no candidate.
    await quiet(() => call(e, BO, 'GET', '/api/admin/org-partners?pair=globex:agency'));
    await quiet(() => call(e, BO, 'GET', '/api/admin/org-partners?pair=initech:agency'));
    assert.equal(asked.length, 1);
    assert.equal(e.DB.rows('SELECT * FROM org_partners').length, 1);
    // The admin team's read of a pair files nothing either; its list load does.
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?pair=globex:agency'));
    assert.deepEqual(requests(), []);
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners'));
    assert.equal(asked.length, 2);
    assert.deepEqual(requests().map((r) => r.partner).sort(), ['agency', 'studio']);
  });

  it('does not ask Clef again on every view of a pair\'s page after it did not answer', async () => {
    const e = env();
    let calls = 0;
    e.AI = {
      async run() {
        calls += 1;
        throw new Error('timeout');
      },
    };
    const read = () => quiet(() => call(e, BO, 'GET', '/api/admin/org-partners?pair=globex:agency'));
    const first = await read();
    assert.equal(calls, 1);
    assert.equal(first.body.pairs[0].p, null);
    assert.ok(first.body.pairs[0].unanswered);
    const again = await read();
    assert.equal(calls, 1);
    assert.ok(again.body.pairs[0].unanswered);
    assert.deepEqual(e.DB.rows('SELECT * FROM org_partners'), []);
    // The list's sync asks as ever.
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners'));
    assert.equal(calls, 2);
  });

  it('lets the admin team dismiss a pair and undo its last decision, directly', async () => {
    const e = env();
    const post = (what, body) => quiet(() => call(e, ADA, 'POST', `/api/admin/org-partners/${what}`, { customer: 'globex', partner: 'agency', ...body }));
    const row = () => e.DB.rows('SELECT confirmed_at IS NOT NULL AS c, dismissed_at IS NOT NULL AS d, since, until FROM org_partners')[0];
    const ask = (action) => e.DB.sqlite.prepare(`INSERT INTO org_partner_requests (customer, partner, action,
      requested_by, requested_at) VALUES ('globex', 'agency', ?, 'bo@staff.example', ?) RETURNING id`).get(action, AT).id;
    const status = (id) => e.DB.rows(`SELECT status FROM org_partner_requests WHERE id = ${id}`)[0].status;
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners'));
    // Confirmed, then undone: Clef's verdict again, and its dates gone.
    await post('confirm', { since: '2025-03' });
    assert.deepEqual(row(), {
      c: 1, d: 0, since: '2025-03', until: null,
    });
    await post('confirm', { undo: true });
    assert.deepEqual(row(), {
      c: 0, d: 0, since: null, until: null,
    });
    // Ended, then undone: confirmed again; undone again, not confirmed.
    await post('end', { until: '2026-06' });
    await post('end', { undo: true });
    assert.deepEqual(row(), {
      c: 1, d: 0, since: null, until: null,
    });
    await post('end', { until: '2026-06' });
    await post('confirm', { undo: true });
    assert.deepEqual(row(), {
      c: 0, d: 0, since: null, until: null,
    });
    // Dismissed directly: every request of the pair that waits is closed; undone, none opens.
    const link = ask('link');
    const end = ask('end');
    await post('dismiss', {});
    assert.deepEqual([status(link), status(end), row().d], ['dismissed', 'dismissed', 1]);
    assert.equal((await partnersOf(e, 'globex')).length, 0);
    await post('dismiss', { undo: true });
    assert.deepEqual([status(link), row().d], ['dismissed', 0]);
    assert.deepEqual((await partnersOf(e, 'globex')).map((x) => x.slug), ['agency']);
  });

  it('keeps a candidate until it is none, and a decided pair after', async () => {
    const e = env();
    assert.deepEqual(await refreshPartners(e), { pairs: 1, likely: 1, unchecked: 0 });
    e.DB.sqlite.exec("DELETE FROM messages WHERE author_key IN ('slack:E1:U1', 'slack:E1:U2') AND channel_id = 'C1'");
    e.DB.sqlite.exec("DELETE FROM facts WHERE value = 'globex-web/www'");
    await refreshPartners(e);
    assert.deepEqual(e.DB.rows('SELECT customer FROM org_partners'), []);
    await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex', partner: 'agency' });
    await refreshPartners(e);
    assert.deepEqual(e.DB.rows('SELECT customer, confirmed_by FROM org_partners'), [
      { customer: 'globex', confirmed_by: 'ada@staff.example' },
    ]);
    assert.equal((await call(e, BO, 'GET', '/api/customers/partners?org=globex')).body.partners[0].confirmed, true);
  });

  it('takes a partner\'s mail domains from the partner domains, the admin team\'s rows over them', async () => {
    const e = env();
    const kinds = async () => {
      forgetPartnerDomains();
      await refreshPartners(e);
      return e.DB.rows('SELECT customer, signals FROM org_partners').map((r) => [r.customer,
        JSON.parse(r.signals).map((x) => `${x.kind}:${x.n}`)]);
    };
    assert.deepEqual(await kinds(), [['globex', ['posters:3', 'owners:1']]]);
    // Said not to be a partner's, its people are nobody's: only the shared owner is left. (Globex's
    // usual domain is the agency's, most of the people in its threads being the agency's: their
    // posts in the agency's own threads are no guests' while the domain is the agency's.)
    const row = e.DB.sqlite.prepare(`INSERT OR REPLACE INTO partner_domains (domain, name, org, excluded,
      updated_by, updated_at) VALUES (?, NULL, ?, ?, 'ada@staff.example', '${AT}')`);
    row.run('agency.example', null, 1);
    assert.deepEqual(await kinds(), [['globex', ['guests:1', 'owners:1']]]);
    // Initech's domain given to the agency by hand: Initech's own people count as the agency's.
    row.run('agency.example', 'agency', 0);
    row.run('initech.example', 'agency', 0);
    const [initech] = (await kinds()).filter(([c]) => c === 'initech');
    assert.deepEqual(initech, ['initech', ['posters:1', 'members:2']]);
  });

  it('writes, deletes and asks nothing without the partner domains', async () => {
    const e = env();
    await refreshPartners(e);
    const before = e.DB.rows('SELECT * FROM org_partners');
    assert.equal(before.length, 1);
    // Every look for the partner domains fails (D1 overloaded), from the isolate's first.
    forgetPartnerDomains();
    forgetEvidence();
    const prepare = e.DB.prepare.bind(e.DB);
    e.DB.prepare = (sql) => {
      if (sql.includes('COUNT(DISTINCT LOWER(i.email)) AS people, COUNT(DISTINCT m.thread)')) {
        throw new Error('D1 DB is overloaded');
      }
      return prepare(sql);
    };
    const asked = e.AI.asked.length;
    assert.deepEqual(await quiet(() => refreshPartners(e)), { skipped: true });
    // An admin team's load shows the pairs as they were, and says so.
    const r = await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    assert.equal(r.body.skipped, true);
    assert.deepEqual(r.body.pairs.map((x) => [x.customer, x.p]), [['globex', 0.9]]);
    assert.deepEqual(e.DB.rows('SELECT * FROM org_partners'), before);
    assert.equal(e.AI.asked.length, asked);
    // Found again, it goes on as before.
    e.DB.prepare = prepare;
    forgetPartnerDomains();
    assert.deepEqual(await refreshPartners(e), { pairs: 1, likely: 1, unchecked: 0 });
  });

  it('stores no verdict when Clef times out, and asks again the next time', async () => {
    const e = env();
    const row = () => e.DB.rows("SELECT p, fingerprint FROM org_partners WHERE customer = 'globex'")[0];
    // Clef never answers: the ask gives up after its timeout, made short here. (Fake timers hung
    // the run where the ask set its timer after the last tick.)
    const never = { run: () => new Promise(() => {}) };
    const silent = () => {
      e.AI = never;
      return refreshPartners(e, { wait: 20 });
    };
    assert.deepEqual(await silent(), { pairs: 1, likely: 0, unchecked: 1 });
    assert.deepEqual(row(), { p: null, fingerprint: null });
    e.AI = fakeAI();
    assert.deepEqual(await refreshPartners(e), { pairs: 1, likely: 1, unchecked: 0 });
    assert.equal(row().p, 0.9);
    // Shown something else, a timeout keeps the verdict it had, stale, for the next ask.
    e.DB.sqlite.exec("UPDATE org_partners SET fingerprint = 'before'");
    assert.deepEqual(await silent(), { pairs: 1, likely: 1, unchecked: 1 });
    assert.deepEqual(row(), { p: 0.9, fingerprint: 'before' });
    e.AI = fakeAI();
    await refreshPartners(e);
    assert.notEqual(row().fingerprint, 'before');
  });

  it('writes only the decision on a pair the org kept had, and an undo leaves its row', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('globex-two', NULL, 'customer', '${AT}')`);
    // Globex's pair with the agency is a candidate Clef judged; Globex Two's was confirmed.
    await refreshPartners(e);
    const before = e.DB.rows("SELECT score, signals, fingerprint, p FROM org_partners WHERE customer = 'globex'")[0];
    assert.equal(before.p, 0.9);
    await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex-two', partner: 'agency' });
    assert.equal((await call(e, ADA, 'POST', '/api/admin/org-merge', { from: 'globex-two', into: 'globex' })).status, 200);
    const merged = e.DB.rows(`SELECT score, signals, fingerprint, p, confirmed_by, merged_from, merged_new
      FROM org_partners WHERE customer = 'globex'`)[0];
    assert.deepEqual(merged, {
      ...before, confirmed_by: 'ada@staff.example', merged_from: 'globex-two', merged_new: 0,
    });
    await call(e, ADA, 'DELETE', '/api/admin/org-merge', { slug: 'globex-two' });
    assert.deepEqual(e.DB.rows(`SELECT score, signals, fingerprint, p, confirmed_at, merged_from, merged_new
      FROM org_partners WHERE customer = 'globex'`), [{
      ...before, confirmed_at: null, merged_from: null, merged_new: null,
    }]);
    // The merged org's own decision counts again.
    assert.ok((await customersOf(e, 'agency')).some((x) => x.slug === 'globex-two' && x.confirmed));
  });

  it('moves a merged org\'s decisions to the org kept, and back with an undo', async () => {
    const e = env();
    // Globex Two is Globex: its decisions go along, unless Globex has its own.
    e.DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('globex-two', NULL, 'customer', '${AT}')`);
    await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex-two', partner: 'agency' });
    await call(e, ADA, 'POST', '/api/admin/org-partners/confirm', { customer: 'globex-two', partner: 'initech' });
    await call(e, ADA, 'POST', '/api/admin/org-partners/dismiss', { customer: 'globex', partner: 'initech' });
    const r = await call(e, ADA, 'POST', '/api/admin/org-merge', { from: 'globex-two', into: 'globex' });
    assert.equal(r.status, 200);
    assert.deepEqual(e.DB.rows(`SELECT customer, partner, confirmed_at IS NOT NULL AS confirmed,
      dismissed_at IS NOT NULL AS dismissed, merged_from FROM org_partners ORDER BY customer, partner`), [
      {
        customer: 'globex', partner: 'agency', confirmed: 1, dismissed: 0, merged_from: 'globex-two',
      },
      {
        customer: 'globex', partner: 'initech', confirmed: 0, dismissed: 1, merged_from: null,
      },
      {
        customer: 'globex-two', partner: 'agency', confirmed: 1, dismissed: 0, merged_from: null,
      },
      {
        customer: 'globex-two', partner: 'initech', confirmed: 1, dismissed: 0, merged_from: null,
      },
    ]);
    assert.deepEqual((await customersOf(e, 'agency')).map((x) => x.slug), ['globex']);
    await call(e, ADA, 'DELETE', '/api/admin/org-merge', { slug: 'globex-two' });
    assert.deepEqual(e.DB.rows('SELECT customer, partner FROM org_partners WHERE merged_from IS NOT NULL'), []);
    assert.deepEqual((await customersOf(e, 'agency')).map((x) => x.slug), ['globex-two']);
  });
});
