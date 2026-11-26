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
import {
  beforeEach, describe, it, mock,
} from 'node:test';
import { api } from '../src/api.js';
import {
  DERIVED_MS, derive, derivedDomains, domainOf, forgetPartnerDomains, iconDomain, namesOrg,
  partnerDomains,
} from '../src/partners.js';
import { profiles } from '../src/profiles.js';
import { d1 } from './d1.js';

// Made-up orgs, people and domains only.
const ENV = { STAFF_DOMAINS: 'staff.example' };
const row = (org, type, domain, people, threads = people, name = null) => ({
  org, type, name, domain, people, threads,
});

describe('derive', () => {
  it('finds the usual mail domains of a partner\'s people, named by the partner', () => {
    const { found, left } = derive(ENV, [
      row('agency', 'partner', 'agency.example', 6, 20, 'The Agency'),
      row('agency', 'partner', 'agency.co.uk', 1),
      row('agency', 'partner', 'parent.example', 3),
      row('agency', 'partner', 'stray.example', 2),
      row('agency', 'partner', 'gmail.com', 9),
      row('agency', 'partner', 'staff.example', 9),
      row('agency', 'partner', 'tenant.onmicrosoft.com', 9),
    ]);
    assert.deepEqual(found.map((f) => [f.domain, f.org, f.name]), [
      ['agency.co.uk', 'agency', 'The Agency'],
      ['agency.example', 'agency', 'The Agency'],
      ['parent.example', 'agency', 'The Agency'],
    ]);
    assert.deepEqual(left, []);
  });

  it('puts the domain that names the partner first, however few write from it', () => {
    const { found } = derive(ENV, [
      row('agency', 'partner', 'agency.example', 1, 1),
      row('agency', 'partner', 'holding.example', 1, 3),
      row('agency', 'partner', 'client.example', 1, 9),
    ]);
    assert.deepEqual(found.map((f) => f.domain), ['agency.example', 'client.example', 'holding.example']);
    // Of a customer, the client's domain is not the partner's.
    const again = derive(ENV, [
      row('agency', 'partner', 'agency.example', 1, 1),
      row('agency', 'partner', 'holding.example', 1, 3),
      row('agency', 'partner', 'client.example', 1, 9),
      row('client', 'customer', 'client.example', 4),
    ]);
    assert.deepEqual(again.found.map((f) => f.domain), ['agency.example', 'holding.example']);
    assert.deepEqual(again.left.map((f) => [f.domain, f.org, f.customer]), [['client.example', 'agency', 'client']]);
  });

  it('leaves out a customer\'s own domain, not one only the partner\'s people post from', () => {
    const { found, left } = derive(ENV, [
      // A `<partner>-<customer>` channel filed under the partner: the customer's people in it.
      row('agency', 'partner', 'agency.example', 8, 40),
      row('agency', 'partner', 'acme.example', 5, 9),
      row('acme', 'customer', 'acme.example', 1),
      // A customer whose channel only the partner's people post in.
      row('globex', 'customer', 'agency.example', 3),
      // One that names the partner's first domain is its own, though.
      row('solo', 'partner', 'initech.example', 2),
      row('initech', 'customer', 'initech.example', 1, 1, 'Initech'),
    ]);
    assert.deepEqual(found.map((f) => f.domain), ['agency.example']);
    assert.deepEqual(left.map((f) => [f.domain, f.customer]), [['acme.example', 'acme'], ['initech.example', 'initech']]);
  });

  it('leaves out the domain of a customer\'s icon, a subsidiary\'s parent\'s', () => {
    const rows = [
      row('agency', 'partner', 'agency.example', 3),
      // A subsidiary's people write from its parent's domain, in the partner's threads too.
      row('agency', 'partner', 'mail.parent.example', 3),
      row('subsidiary', 'customer', 'subsidiary.example', 5),
      row('subsidiary', 'customer', 'mail.parent.example', 2),
      row('solo', 'partner', 'holding.example', 2),
    ];
    const icons = [
      { slug: 'subsidiary', icon: 'https://www.parent.example/logo.png' },
      { slug: 'other', icon: 'holding.example' },
    ];
    const { found, left } = derive(ENV, rows, icons);
    assert.deepEqual(found.map((f) => f.domain), ['agency.example']);
    assert.deepEqual(left.map((f) => [f.domain, f.customer]), [
      ['mail.parent.example', 'subsidiary'], ['holding.example', 'other'],
    ]);
    // Without the icons, both would be partners'.
    assert.equal(derive(ENV, rows).found.length, 3);
  });

  it('reads the domain of an icon', () => {
    const env = { PUBLIC_ORIGIN: 'https://inbox.example' };
    assert.equal(iconDomain(env, 'www.Acme.example'), 'acme.example');
    assert.equal(iconDomain(env, 'https://cdn.acme.co.uk/a.png'), 'acme.co.uk');
    assert.equal(iconDomain(env, 'https://favicons.example/s2?domain=globex.example&sz=64'), 'globex.example');
    assert.equal(iconDomain(env, 'https://inbox.example/api/portal/logo/x.example'), null);
    assert.equal(iconDomain(env, 'not an icon'), null);
    assert.equal(iconDomain(env, null), null);
  });

  it('gives a domain two partners have to the one with more of its people', () => {
    const { found } = derive(ENV, [
      row('agency', 'partner', 'agency.example', 6),
      row('bigco', 'partner', 'bigco.example', 4),
      row('bigco', 'partner', 'agency.example', 4),
    ]);
    assert.deepEqual(found.map((f) => [f.domain, f.org]), [['agency.example', 'agency'], ['bigco.example', 'bigco']]);
  });

  it('tells which names a domain has', () => {
    assert.ok(namesOrg('mail.acme.co.uk', { slug: 'acme' }));
    assert.ok(namesOrg('acmeus.example', { slug: 'acme' }));
    assert.ok(namesOrg('theagency.example', { slug: 'x', name: 'The Agency' }));
    assert.ok(!namesOrg('acme.example', { slug: 'globex', name: 'Globex Inc.' }));
  });

  it('reads a domain as typed', () => {
    assert.equal(domainOf(' @Agency.Example '), 'agency.example');
    assert.equal(domainOf('https://agency.example/about'), 'agency.example');
    assert.equal(domainOf('pat@eu.agency.example'), 'eu.agency.example');
    assert.equal(domainOf('not a domain'), null);
  });
});

/** A database with an agency (a partner) working on acme's (a customer's) threads. */
function world() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
      },
    ],
  });
  const db = DB.sqlite;
  db.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES
      ('agency', 'The Agency', 'partner', '2026-10-01'), ('acme', 'Acme', 'customer', '2026-10-01'),
      ('other', 'Other Partner', 'partner', '2026-10-01');
    INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at) VALUES
      ('slack', 'E1', 'U1', 'person', 'Pat', 'pat@agency.example', '2026-10-21'),
      ('slack', 'E1', 'U2', 'person', 'Quinn', 'quinn@agency.example', '2026-10-21'),
      ('slack', 'E1', 'U3', 'person', 'Cy', 'cy@acme.example', '2026-10-21'),
      ('slack', 'E1', 'U4', 'person', 'Dee', 'dee@acme.example', '2026-10-21')`);
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
      team, kind, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, ?, ?, 'helix', 'channel', 'p/', '2026-10-20', '2026-10-20',
      '2026-10-20', 1, '2026-10-20')`);
  const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, deleted, author_key) VALUES ('slack', 'E1', ?, ?, ?, '2026-10-20', 0, 1, 0, ?)`);
  let n = 0;
  const post = (key, user) => {
    n += 1;
    msg.run(key.split(':')[2], `m${n}`, key, `slack:E1:${user}`);
  };
  thread.run('slack:E1:C1:1', 'C1', '1', 'agency');
  thread.run('slack:E1:C2:2', 'C2', '2', 'acme');
  post('slack:E1:C1:1', 'U1');
  post('slack:E1:C1:1', 'U2');
  post('slack:E1:C2:2', 'U1');
  post('slack:E1:C2:2', 'U3');
  post('slack:E1:C2:2', 'U4');
  return { ...ENV, DB };
}

const asMe = (p) => ({ ...p, teams: p.teams.map((slug) => ({ slug })) });
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: asMe(me) });
  return { status: res.status, body: await res.json() };
}

describe('partnerDomains', () => {
  beforeEach(() => forgetPartnerDomains());

  it('finds the partners\' domains in the threads, with nobody listing them', async () => {
    const e = world();
    assert.deepEqual([...await partnerDomains(e)], [['agency.example', { name: 'The Agency', org: 'agency' }]]);
    const cards = await profiles(e, ['slack:E1:U1', 'slack:E1:U3']);
    assert.equal(cards['slack:E1:U1'].relation, 'partner');
    assert.equal(cards['slack:E1:U1'].partner, 'The Agency');
    assert.equal(cards['slack:E1:U3'].relation, 'customer');
  });

  it('keeps what it found for the isolate, until it is forgotten', async () => {
    const e = world();
    await derivedDomains(e);
    e.DB.sqlite.exec('UPDATE orgs SET name = \'Agency Co\' WHERE slug = \'agency\'');
    assert.equal((await partnerDomains(e)).get('agency.example').name, 'The Agency');
    forgetPartnerDomains();
    assert.equal((await partnerDomains(e)).get('agency.example').name, 'Agency Co');
  });

  it('is found again in the isolate once an org changes there', async () => {
    const e = world();
    assert.ok((await partnerDomains(e)).has('agency.example'));
    // Its type, on its page.
    const put = await call(e, ADA, 'PUT', '/api/admin/orgs', { slug: 'agency', name: 'The Agency', type: 'customer' });
    assert.equal(put.status, 200);
    assert.equal((await partnerDomains(e)).has('agency.example'), false);
    await call(e, ADA, 'PUT', '/api/admin/orgs', { slug: 'agency', name: 'Agency Co', type: 'partner' });
    assert.equal((await partnerDomains(e)).get('agency.example').name, 'Agency Co');
    // A customer's icon.
    await call(e, ADA, 'PUT', '/api/admin/orgs', {
      slug: 'acme', name: 'Acme', type: 'customer', icon: 'agency.example',
    });
    assert.equal((await partnerDomains(e)).has('agency.example'), false);
  });

  it('shows an edit of the admin team\'s at once', async () => {
    const e = world();
    assert.equal((await profiles(e, ['slack:E1:U1']))['slack:E1:U1'].relation, 'partner');
    await call(e, ADA, 'PUT', '/api/admin/partner-domains', { domain: 'agency.example', excluded: true });
    assert.equal((await profiles(e, ['slack:E1:U1']))['slack:E1:U1'].relation, 'customer');
    await call(e, ADA, 'DELETE', '/api/admin/partner-domains', { domain: 'agency.example' });
    assert.equal((await profiles(e, ['slack:E1:U1']))['slack:E1:U1'].partner, 'The Agency');
  });

  it('waits for the look after the hour, and looks again after one that failed', async () => {
    const e = world();
    const quiet = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    const now = Date.now();
    const clock = mock.method(Date, 'now', () => now);
    try {
      assert.equal((await partnerDomains(e)).get('agency.example').name, 'The Agency');
      // The hour is up and looking fails: what was found before, and no new hour of it.
      e.DB.sqlite.exec(`UPDATE orgs SET name = 'Agency Co' WHERE slug = 'agency';
        ALTER TABLE org_merges RENAME TO org_merges_gone`);
      clock.mock.mockImplementation(() => now + DERIVED_MS + 1);
      assert.equal((await partnerDomains(e)).get('agency.example').name, 'The Agency');
      assert.equal(errors.length, 1);
      // The next request looks again, and waits for it.
      e.DB.sqlite.exec('ALTER TABLE org_merges_gone RENAME TO org_merges');
      assert.equal((await partnerDomains(e)).get('agency.example').name, 'Agency Co');
      // Then it holds for the hour.
      e.DB.sqlite.exec('UPDATE orgs SET name = \'Agency Inc\' WHERE slug = \'agency\'');
      assert.equal((await partnerDomains(e)).get('agency.example').name, 'Agency Co');
    } finally {
      clock.mock.restore();
      console.error = quiet;
    }
  });

  it('has none found when looking fails, and the admin team\'s rows still', async () => {
    const e = world();
    e.DB.sqlite.exec(`INSERT INTO partner_domains (domain, name) VALUES ('hand.example', 'By Hand');
      DROP TABLE org_merges`);
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.deepEqual([...await partnerDomains(e)], [['hand.example', { name: 'By Hand', org: null }]]);
    } finally {
      console.error = quiet;
    }
  });

  it('takes the admin team\'s rows over what it found', async () => {
    const e = world();
    e.DB.sqlite.exec(`INSERT INTO partner_domains (domain, name, org, excluded) VALUES
      ('agency.example', 'Renamed', NULL, 0), ('hand.example', NULL, 'other', 0),
      ('eu.agency.example', NULL, NULL, 1)`);
    const found = await partnerDomains(e);
    assert.deepEqual(found.get('agency.example'), { name: 'Renamed', org: 'agency' });
    assert.deepEqual(found.get('hand.example'), { name: 'Other Partner', org: 'other' });
    assert.equal(found.get('eu.agency.example'), null);
    e.DB.sqlite.exec('UPDATE partner_domains SET excluded = 1 WHERE domain = \'agency.example\'');
    assert.equal((await profiles(e, ['slack:E1:U1']))['slack:E1:U1'].relation, 'customer');
  });
});

describe('the admin team\'s partner domains', () => {
  beforeEach(() => forgetPartnerDomains());

  it('lists what was found and what was said, and changes it', async () => {
    const e = world();
    const list = await call(e, ADA, 'GET', '/api/admin/partner-domains');
    assert.equal(list.status, 200);
    const listed = list.body.domains.map((d) => [d.domain, d.name, d.org, d.state, d.found.people]);
    assert.deepEqual(listed, [
      ['agency.example', 'The Agency', 'agency', 'found', 2],
    ]);
    assert.deepEqual(list.body.partners, [{ slug: 'other', name: 'Other Partner' }, { slug: 'agency', name: 'The Agency' }]);

    assert.equal((await call(e, ADA, 'PUT', '/api/admin/partner-domains', { domain: 'https://Hand.example/', org: 'other' })).status, 200);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/partner-domains', { domain: 'agency.example', excluded: true })).status, 200);
    const after = await call(e, ADA, 'GET', '/api/admin/partner-domains');
    assert.deepEqual(after.body.domains.map((d) => [d.domain, d.name, d.state]), [
      ['hand.example', 'Other Partner', 'manual'],
      ['agency.example', 'The Agency', 'excluded'],
    ]);
    assert.equal(after.body.domains[1].manual.by, 'ada@staff.example');

    const gone = await call(e, ADA, 'DELETE', '/api/admin/partner-domains', { domain: 'agency.example' });
    assert.equal(gone.body.removed, 1);
    assert.equal((await partnerDomains(e)).get('agency.example').name, 'The Agency');
  });

  it('takes no staff domain, nor an org that is no partner, and is the admin team\'s', async () => {
    const e = world();
    const put = (body, me = ADA) => call(e, me, 'PUT', '/api/admin/partner-domains', body);
    assert.equal((await put({ domain: 'eu.staff.example', name: 'X' })).status, 400);
    assert.equal((await put({ domain: 'x.example', org: 'acme' })).status, 400);
    assert.equal((await put({ domain: 'x.example' })).status, 400);
    assert.equal((await put({ domain: 'x', name: 'X' })).status, 400);
    assert.equal((await put({ domain: 'x.example', name: 'X' }, BO)).status, 403);
    assert.equal((await call(e, BO, 'GET', '/api/admin/partner-domains')).status, 403);
  });
});
