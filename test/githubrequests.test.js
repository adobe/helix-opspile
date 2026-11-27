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
import { generateKeyPairSync } from 'node:crypto';
import {
  after, before, beforeEach, describe, it,
} from 'node:test';
import { api } from '../src/api.js';
import { forgetGithub, pkcs8Pem } from '../src/github.js';
import {
  adobeOrgHint, adobeOrgs, isAdobeOrg, MIN_THREADS, namedOrgs, syncGithubRequests, WINDOW_DAYS,
} from '../src/githubrequests.js';
import { seal } from '../src/post.js';
import { requestKey } from '../src/requestkeys.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, orgs, channels, GitHub accounts, repositories and keys only. `labs-sites` and
// `labs-demos` stand for Adobe's organizations, `globex-web` for a customer's.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo Ops', staff: 1, teams: ['helix'],
};
const viewer = (p) => ({
  id: p.id, email: p.email, name: p.name, teams: p.teams.map((slug) => ({ slug, role: 'member' })),
});
const NOW = new Date();
const ago = (days) => new Date(NOW.getTime() - days * 86400_000).toISOString();
const KEY = Buffer.alloc(32, 5).toString('base64url');
const { privateKey: PKCS1 } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// GitHub's API, as far as the app's installations go: the app is on labs-demos, not allowed yet.
const GH = { down: false };
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.host !== 'api.github.com') {
      return realFetch(input, init);
    }
    if (url.pathname === '/app/installations') {
      return GH.down ? Response.json({ message: 'Server Error' }, { status: 502 })
        : Response.json([
          { id: 51, account: { login: 'labs-core', type: 'Organization' }, repository_selection: 'all' },
          { id: 52, account: { login: 'Labs-Demos', type: 'Organization' }, repository_selection: 'selected' },
        ]);
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  GH.down = false;
  forgetGithub();
});

/**
 * Threads that name repositories: labs-sites in six recent ones (two of them one entry, folded),
 * and one old; labs-demos in five; globex-web, a customer's, in eight; labs-core, whose
 * installation is allowed, in six.
 */
async function env({ orgs = 'labs-sites, labs-demos,labs-core , bad_login!' } = {}) {
  const DB = d1({
    people: [ADA, BO],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  const sql = DB.sqlite;
  const thread = sql.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
      team, kind, channel_name, title, path, root_at, last_at, any_at, messages, updated_at,
      logical_thread) VALUES (?, 'slack', 'E1', 'C1', ?, 'globex', 'helix', 'channel', 'aem-globex',
      ?, 'p/', ?, ?, ?, 1, ?, ?)`);
  const fact = sql.prepare(`INSERT INTO facts (thread, source, field, value)
    VALUES (?, 'rule', ?, ?)`);
  const post = sql.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, deleted, person, preview) VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, 1, 0, ?, ?)`);
  let n = 0;
  const add = (values, { days = 3, folded = null } = {}) => {
    n += 1;
    const key = `slack:E1:C1:${n}.1`;
    thread.run(key, `${n}.1`, `Thread ${n}`, ago(days), ago(days), ago(days), ago(days), folded);
    for (const [field, value] of values) {
      fact.run(key, field, value);
    }
    post.run(`${n}.1`, key, ago(days), 0, null, `The build of thread ${n} fails`);
    post.run(`${n}.2`, key, ago(days), 1, BO.id, 'Looking at it');
    return key;
  };
  const first = add([['site', 'labs-sites/www'], ['repo', 'labs-sites/www']]);
  add([['site', 'labs-sites/www']], { folded: first });
  for (let i = 0; i < 4; i += 1) {
    add([['site', i % 2 ? 'labs-sites/blog' : 'labs-sites/www']], { days: 10 + i });
  }
  add([['repo', 'labs-sites/shop']], { days: 20 });
  add([['repo', 'labs-sites/old']], { days: WINDOW_DAYS + 5 });
  for (let i = 0; i < 5; i += 1) {
    add([['repo', `labs-demos/demo-${i}`]], { days: 5 });
  }
  for (let i = 0; i < 8; i += 1) {
    add([['site', 'globex-web/www']], { days: 2 });
  }
  for (let i = 0; i < 6; i += 1) {
    add([['repo', 'labs-core/tools']], { days: 2 });
  }
  const e = {
    DB,
    CHANNELS: fakeBucket(),
    STAFF_DOMAINS: 'staff.example',
    NORMALIZE: { send: async () => {} },
    TOKEN_KEY: KEY,
    PUBLIC_ORIGIN: 'https://opspile.example',
    ADOBE_GITHUB_ORGS: orgs,
  };
  sql.prepare(`INSERT INTO github_apps (id, slug, name, owner, html_url, client_id, private_key,
      created_by, created_at) VALUES (7, 'opspile-test', 'opspile test', 'labs-core',
      'https://github.com/apps/opspile-test', 'Iv1.test', ?, 'ada@staff.example', ?)`)
    .run(await seal(e, pkcs8Pem(PKCS1)), ago(30));
  sql.prepare(`INSERT INTO github_installations (id, app_id, account, approved_by, approved_at)
    VALUES (51, 7, 'labs-core', 'ada@staff.example', ?)`).run(ago(30));
  return e;
}

const call = async (e, who, method, path, body) => {
  const res = await api(
    new Request(`https://opspile.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    e,
    new URL(`https://opspile.test${path}`),
    { viewer: viewer(who) },
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const rowsOf = (e) => e.DB.sqlite.prepare('SELECT * FROM github_install_requests ORDER BY id').all();
const threadOf = async (e, id) => (await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(requestKey('github', id))}`))).body;

describe('Adobe\'s GitHub organizations', () => {
  it('are the ones ADOBE_GITHUB_ORGS lists, and nothing else', () => {
    const e = { ADOBE_GITHUB_ORGS: 'Labs-Sites, labs-demos labs-sites,,bad_login' };
    assert.deepEqual(adobeOrgs(e), ['labs-sites', 'labs-demos']);
    assert.ok(isAdobeOrg(e, 'LABS-SITES'));
    assert.ok(!isAdobeOrg(e, 'globex-web'));
    assert.deepEqual(adobeOrgs({}), []);
  });

  it('are counted by the recent entries whose repo and site facts name them', async () => {
    const e = await env();
    const named = await namedOrgs(e, ['labs-sites', 'labs-demos'], NOW);
    const sites = named.get('labs-sites');
    // Seven recent threads, two of them one entry; the old one does not count.
    assert.equal(sites.threads, 6);
    assert.equal(sites.repoCount, 3);
    assert.deepEqual(sites.repos, [
      { repo: 'labs-sites/www', threads: 3 },
      { repo: 'labs-sites/blog', threads: 2 },
      { repo: 'labs-sites/shop', threads: 1 },
    ]);
    assert.equal(named.get('labs-demos').threads, 5);
    // A customer's is never read.
    assert.equal(named.has('globex-web'), false);
  });
});

describe('a request to install the GitHub App', () => {
  it('is filed for Adobe\'s organizations that enough threads name and no allowed installation reads', async () => {
    const e = await env();
    const r = await quiet(() => syncGithubRequests(e, NOW));
    assert.deepEqual(r, {
      orgs: 3, filed: 2, updated: 0, installed: 0, withdrawn: 0,
    });
    const rows = rowsOf(e);
    // Not the customer's, however many threads name it; not labs-core, which the app reads.
    assert.deepEqual(rows.map((x) => [x.account, x.threads, x.repo_count, x.status]), [
      ['labs-sites', 6, 3, 'open'], ['labs-demos', 5, 5, 'open']]);
    // Asked again, nothing new.
    assert.equal((await quiet(() => syncGithubRequests(e, NOW))).filed, 0);
    assert.equal(rowsOf(e).length, 2);
    assert.ok(MIN_THREADS <= 5);
  });

  it('waits until MIN_THREADS threads name the organization', async () => {
    const e = await env();
    e.DB.sqlite.exec("DELETE FROM facts WHERE value LIKE 'labs-demos/demo-4'");
    await quiet(() => syncGithubRequests(e, NOW));
    assert.deepEqual(rowsOf(e).map((x) => x.account), ['labs-sites']);
  });

  it('is a thread of the admin team\'s inbox, with the threads, the repositories and the install link', async () => {
    const e = await env();
    await quiet(() => syncGithubRequests(e, NOW));
    const [sites, demos] = rowsOf(e);
    const { body } = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    const entry = body.threads.find((t) => t.thread === requestKey('github', sites.id));
    assert.equal(entry.title, 'Install the GitHub App on labs-sites');
    assert.equal(entry.org_name, 'GitHub App installations');
    assert.equal(entry.resolution.verdict, 'open');
    // Only the admin team's.
    const theirs = await quiet(() => call(e, BO, 'GET', '/api/requests'));
    assert.ok(!theirs.body.threads.some((t) => t.thread.startsWith('request:github:')));
    const t = await threadOf(e, sites.id);
    const text = t.messages[0].body;
    assert.match(text, /\*\*labs-sites\*\* is one of Adobe's GitHub organizations \(`ADOBE_GITHUB_ORGS`\), and 6 threads of the last 90 days name 3 repositories and sites of it/);
    assert.match(text, /`labs-sites\/www` \(3 threads\), `labs-sites\/blog` \(2 threads\), `labs-sites\/shop` \(1 thread\)/);
    assert.match(text, /\[Install opspile-test\]\(https:\/\/github\.com\/apps\/opspile-test\/installations\/new\) on \*\*labs-sites\*\*/);
    assert.match(text, /closes itself once an installation on labs-sites is allowed/);
    // The threads behind it, and who of Adobe works them.
    assert.match(text, /\*\*The latest threads that name labs-sites' repositories\*\*\n- \[Thread /);
    assert.match(text, /Who could know:\*\* Bo Ops/);
    assert.deepEqual(t.request.actions.map((a) => a.id), ['dismiss', 'ask']);
    // Installed on labs-demos and not allowed yet: Allow is offered.
    const d = await threadOf(e, demos.id);
    assert.match(d.messages[0].body, /installed there, but not allowed yet/);
    assert.match(d.messages[0].body, /installed on \*\*labs-demos\*\* \(a selection of its repositories\) and waits to be allowed/);
    assert.deepEqual(d.request.actions.map((a) => a.id), ['allow', 'dismiss', 'ask']);
  });

  it('says where to make the app when there is none, and goes on when GitHub does not answer', async () => {
    const e = await env();
    await quiet(() => syncGithubRequests(e, NOW));
    const [, demos] = rowsOf(e);
    GH.down = true;
    const down = await threadOf(e, demos.id);
    assert.match(down.messages[0].body, /GitHub did not say just now where the app is installed/);
    assert.deepEqual(down.request.actions.map((a) => a.id), ['dismiss', 'ask']);
    e.DB.sqlite.exec('DELETE FROM github_apps');
    const none = await threadOf(e, demos.id);
    assert.match(none.messages[0].body, /There is no opspile GitHub App yet: create it in \[the admin team's tools and MCP servers\]\(\/inbox\/admin\?tab=teams&team=admin&view=mcp\)/);
  });

  it('closes itself once an installation on the account is allowed, from the thread', async () => {
    const e = await env();
    await quiet(() => syncGithubRequests(e, NOW));
    const [, demos] = rowsOf(e);
    const key = requestKey('github', demos.id);
    const res = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'allow' }));
    assert.equal(res.status, 200);
    assert.match(res.body.done, /Allowed/);
    const row = rowsOf(e).find((x) => x.id === demos.id);
    assert.equal(row.status, 'installed');
    assert.equal(row.decided_by, ADA.email);
    const allowed = e.DB.sqlite.prepare('SELECT account FROM github_installations WHERE id = 52').get();
    assert.equal(allowed.account, 'Labs-Demos');
    assert.equal(res.body.thread.request.open, false);
    assert.match(res.body.thread.messages.find((m) => m.id === 'decision').body, /\*\*Installed\*\*: an installation on labs-demos is allowed \(by ada@staff\.example\)/);
    // Not asked again while it is allowed.
    assert.equal((await quiet(() => syncGithubRequests(e, NOW))).filed, 0);
  });

  it('closes itself once the installation is allowed in the tools and MCP servers, or on the sync', async () => {
    const e = await env();
    await quiet(() => syncGithubRequests(e, NOW));
    const [sites, demos] = rowsOf(e);
    const res = await quiet(() => call(e, ADA, 'PUT', '/api/kb/github/installation', { id: 52, approved: true }));
    assert.equal(res.status, 200);
    assert.equal(rowsOf(e).find((x) => x.id === demos.id).status, 'installed');
    // Allowed some other way (a row written by hand): the next sync closes it.
    e.DB.sqlite.exec(`INSERT INTO github_installations (id, app_id, account, approved_by, approved_at)
      VALUES (53, 7, 'labs-sites', 'cy@staff.example', '${NOW.toISOString()}')`);
    assert.equal((await quiet(() => syncGithubRequests(e, NOW))).installed, 1);
    const row = rowsOf(e).find((x) => x.id === sites.id);
    assert.equal(row.status, 'installed');
    assert.equal(row.decided_by, 'cy@staff.example');
  });

  it('dismissed, does not come back while it is quiet, and is asked again after', async () => {
    const e = await env();
    await quiet(() => syncGithubRequests(e, NOW));
    const [sites] = rowsOf(e);
    const key = requestKey('github', sites.id);
    const res = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', {
      key, action: 'dismiss', values: { days: '30', reason: 'Archived sites' },
    }));
    assert.equal(res.status, 200);
    assert.match(res.body.done, /not asked about again before/);
    const row = rowsOf(e).find((x) => x.id === sites.id);
    assert.equal(row.status, 'dismissed');
    assert.equal(row.reason, 'Archived sites');
    assert.equal(row.quiet_until.slice(0, 10), ago(-30).slice(0, 10));
    const shown = res.body.thread.messages.find((m) => m.id === 'decision');
    assert.match(shown.body, /\*\*Dismissed\*\* by ada@staff\.example: not asked again before .*: Archived sites/);
    // Dismissed twice: the second finds it decided.
    assert.equal((await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'dismiss' }))).status, 409);
    assert.equal((await quiet(() => syncGithubRequests(e, NOW))).filed, 0);
    const later = (days) => new Date(NOW.getTime() + days * 86400_000);
    assert.equal((await quiet(() => syncGithubRequests(e, later(20)))).filed, 0);
    // Quiet for 30 days: then asked again, a new request.
    e.DB.sqlite.exec(`UPDATE threads SET last_at = '${ago(-31)}' WHERE thread IN
      (SELECT thread FROM facts WHERE value LIKE 'labs-sites/%')`);
    assert.equal((await quiet(() => syncGithubRequests(e, later(31)))).filed, 1);
    assert.deepEqual(rowsOf(e).filter((x) => x.account === 'labs-sites').map((x) => x.status), ['dismissed', 'open']);
  });

  it('keeps its counts, and is taken back once nothing names it or it is no longer Adobe\'s', async () => {
    const e = await env();
    await quiet(() => syncGithubRequests(e, NOW));
    e.DB.sqlite.exec("DELETE FROM facts WHERE value = 'labs-sites/shop'");
    const r = await quiet(() => syncGithubRequests(e, NOW));
    assert.equal(r.updated, 1);
    const [sites] = rowsOf(e);
    assert.equal(sites.threads, 5);
    assert.equal(sites.repo_count, 2);
    assert.equal(sites.status, 'open');
    // Under MIN_THREADS it stays: it was asked, and the threads are there still.
    e.DB.sqlite.exec("DELETE FROM facts WHERE value = 'labs-sites/blog'");
    await quiet(() => syncGithubRequests(e, NOW));
    assert.equal(rowsOf(e)[0].status, 'open');
    e.DB.sqlite.exec("DELETE FROM facts WHERE value LIKE 'labs-sites/%'");
    assert.equal((await quiet(() => syncGithubRequests(e, NOW))).withdrawn, 1);
    assert.match(rowsOf(e)[0].reason, /no thread of the last 90 days names labs-sites's repositories any more/);
    e.ADOBE_GITHUB_ORGS = 'labs-sites';
    assert.equal((await quiet(() => syncGithubRequests(e, NOW))).withdrawn, 1);
    const demos = rowsOf(e).find((x) => x.account === 'labs-demos');
    assert.equal(demos.status, 'withdrawn');
    assert.match(demos.reason, /no longer listed as one of Adobe's GitHub organizations/);
    const t = await threadOf(e, demos.id);
    assert.match(t.messages.find((m) => m.id === 'decision').body, /\*\*Withdrawn\*\*: labs-demos is no longer listed/);
  });

  it('asks nobody without ADOBE_GITHUB_ORGS', async () => {
    const e = await env({ orgs: '' });
    assert.deepEqual(await quiet(() => syncGithubRequests(e, NOW)), {
      orgs: 0, filed: 0, updated: 0, installed: 0, withdrawn: 0,
    });
    assert.equal(rowsOf(e).length, 0);
  });

  it('is counted on the Inbox of the header', async () => {
    const e = await env();
    const before0 = (await quiet(() => call(e, ADA, 'GET', '/api/admin/requests?count=1'))).body.open;
    await quiet(() => syncGithubRequests(e, NOW));
    const after0 = (await quiet(() => call(e, ADA, 'GET', '/api/admin/requests?count=1'))).body.open;
    assert.equal(after0 - before0, 2);
  });

  it('is what an agent that cannot read the organization is pointed to', async () => {
    const e = await env();
    assert.equal(await adobeOrgHint(e, 'globex-web'), '');
    assert.match(await adobeOrgHint(e, 'labs-sites'), /installs the app there once enough threads name it/);
    await quiet(() => syncGithubRequests(e, NOW));
    assert.match(await adobeOrgHint(e, 'Labs-Sites'), /the admin team is asked to install the app there \(a request in its inbox\)/);
  });
});
