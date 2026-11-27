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
  mkdtempSync, readdirSync, copyFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { resetIdentityCache } from '../src/portal/integration-identity.js';
import { quiet } from './fakes.js';
import { d1, PORTAL } from './d1.js';
import {
  ADA, BO, MANAGER, ORG, OTHER_ORG, setup, viewer, world,
} from './integration-world.js';

setup();

// Made up, as everything here; the fixture's IMS names ORG this.
const IMS_NAME = 'Mill Paper Products International Inc. - Marketing (Prod)';

const named = (w, body, me = w.admin) => quiet(() => w.staff(me, 'PUT', '/api/admin/portal/integration/audience-name', body));
const shared = async (w, opts) => {
  const res = await w.list(opts);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.audience, 'shared');
  return res.body;
};

describe('the customer a shared channel is shared with (audienceName)', () => {
  it('names the organization as the identity provider did when its request was approved', async () => {
    const w = world();
    await w.list();
    const res = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', {
      id: 1, team: 'agents', org: 'mill', name: 'agents-mill',
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(w.db.rows('SELECT org_name FROM integration_customers')[0].org_name, IMS_NAME);
    assert.equal((await shared(w)).audienceName, IMS_NAME);
  });

  it('records the name for a channel made by hand on a member\'s call, and sends none unknown', async () => {
    const w = world();
    w.upstream.scope = false;
    w.handMade('panel', ORG, 'agents-mill', ADA);
    const body = await shared(w);
    assert.ok(!('audienceName' in body));
    assert.equal(w.db.rows('SELECT org_name FROM integration_customers')[0].org_name, null);
    // With the organizations scope (a miss is kept ten minutes), a later call records it, and
    // the one after says it.
    w.upstream.scope = true;
    resetIdentityCache();
    await shared(w);
    assert.equal((await shared(w)).audienceName, IMS_NAME);
  });

  it('never sends it for an individual channel', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
    w.db.sqlite.prepare('UPDATE integration_customers SET org_name = ? WHERE channel = ?').run(IMS_NAME, channel);
    w.db.sqlite.prepare(`INSERT INTO channel_audiences (channel, audience, set_by, set_at)
      VALUES (?, 'individual', 'x', 0)`).run(channel);
    const res = await w.list();
    assert.equal(res.body.audience, 'individual');
    assert.ok(!('audienceName' in res.body));
  });

  it('takes the admin team\'s name over the provider\'s, and back again', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
    await shared(w);
    const set = await named(w, { channel, name: '  Mill\n Paper  ' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(
      [set.body.channel.audienceName, set.body.channel.shownName, set.body.channel.orgName],
      ['Mill Paper', 'Mill Paper', IMS_NAME],
    );
    assert.equal(w.db.rows('SELECT audience_name_by FROM integration_customers')[0].audience_name_by, w.admin.email);
    assert.equal((await shared(w)).audienceName, 'Mill Paper');
    // Never the channel's own name, nor an organization ID; never too long.
    for (const name of ['agents-mill', 'Agents-Mill', ORG, OTHER_ORG, 'x'.repeat(121)]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await named(w, { channel, name })).status, 400, name);
    }
    assert.equal((await named(w, { channel, name: '' })).body.channel.audienceName, null);
    assert.equal((await shared(w)).audienceName, IMS_NAME);
    // On the channel's thread in the admin team's inbox too.
    const key = `request:embed:${channel}`;
    const done = await quiet(() => w.staff(w.admin, 'POST', '/api/requests/resolve', {
      key, action: 'audience-name', values: { name: 'Mill' },
    }));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await shared(w)).audienceName, 'Mill');
    // A manager of a team may not.
    const manager = viewer(MANAGER, 'manager');
    assert.equal((await named(w, { channel, name: 'Nope', team: 'agents' }, manager)).status, 403);
  });

  it('is each channel\'s: another host\'s channel of the same organization says its own', async () => {
    const w = world();
    const panel = w.handMade('panel', ORG, 'agents-mill', ADA);
    w.handMade('desk', ORG, 'agents-mill-desk', BO);
    w.upstream.scope = false;
    await named(w, { channel: panel, name: 'Mill' });
    assert.equal((await shared(w)).audienceName, 'Mill');
    const bo = await w.token({ user: BO });
    assert.ok(!('audienceName' in await shared(w, { host: 'desk', bearer: bo })));
  });
});

describe('portal migration 0010', () => {
  it('seeds the name of existing channels from what their tenants\' requests recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-migrations-'));
    const files = readdirSync(PORTAL).filter((f) => f.endsWith('.sql')).sort();
    files.filter((f) => f < '0010').forEach((f) => copyFileSync(new URL(f, PORTAL), join(dir, f)));
    const db = d1({ migrations: pathToFileURL(`${dir}/`) });
    db.sqlite.exec(`INSERT INTO integration_hosts (id, service_id, issuer, jwks, scopes)
        VALUES ('panel', 'panel.access', 'panel', '{"keys":[]}', '[]');
      INSERT INTO integration_customers (host, tenant, customer, name) VALUES
        ('panel', 'T1@AdobeOrg', 'one', 'agents-one'), ('panel', 'T2@AdobeOrg', 'two', 'agents-two');
      INSERT INTO integration_requests (host, tenant, subject, org_name, requested_at, seen_at) VALUES
        ('panel', 'T1@AdobeOrg', 'a', 'Older Name', 1, 1), ('panel', 'T1@AdobeOrg', 'b', 'One Corp', 2, 2),
        ('panel', 'T1@AdobeOrg', 'c', NULL, 3, 3)`);
    db.sqlite.exec(readFileSync(new URL('0010_audience_name.sql', PORTAL), 'utf8'));
    assert.deepEqual(db.rows('SELECT customer, org_name FROM integration_customers ORDER BY customer'), [
      { customer: 'one', org_name: 'One Corp' }, { customer: 'two', org_name: null },
    ]);
  });
});
