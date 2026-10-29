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
import { AGENT_TOOLS } from '../src/agent/agenttools.js';
import { agentToolsExtension } from '../src/agent/tools.js';
import {
  checkRule, extract, GLOBAL_TEAM, rulesFor, runScript, saveRule, saveTech, techFor, techNames,
  testRule,
} from '../src/extract.js';
import { kbAdmin } from '../src/kbadmin.js';
import { ADMIN_TEAM } from '../src/review.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, teams, hosts and ids only.
const ADA = { id: 1, email: 'ada@staff.example', name: 'Ada' };
const BO = { id: 2, email: 'bo@staff.example', name: 'Bo' };
const CY = { id: 3, email: 'cy@staff.example', name: 'Cy' };
const admin = { ...ADA, teams: [{ slug: 'admin', role: 'member' }] };
const manager = { ...BO, teams: [{ slug: 'helix', role: 'manager' }] };
const member = { ...CY, teams: [{ slug: 'helix', role: 'member' }] };
const outsider = { ...CY, teams: [{ slug: 'edge', role: 'manager' }] };

function env(extra = {}) {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }],
  });
  DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
    ('kb-team-helix', 'team', 'helix', 'x', '2026-10-20T09:00:00Z'),
    ('kb-team-admin', 'team', 'admin', 'x', '2026-10-20T09:00:00Z'),
    ('kb-org-acme', 'org', 'acme', 'x', '2026-10-20T09:00:00Z')`);
  return { DB, ...extra };
}
const msgs = (...bodies) => bodies.map((body) => ({ body, author: { kind: 'person' } }));
const by = (facts, field) => facts.filter((f) => f.field === field).map((f) => f.value);

async function call(e, me, method, path, body) {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await quiet(() => kbAdmin(req, e, url, me));
  return { status: res.status, body: await res.json() };
}

describe('the admin team\'s extraction rules', () => {
  it('is the admin team of src/review.js', () => {
    assert.equal(GLOBAL_TEAM, ADMIN_TEAM);
  });

  it('find CVEs, tickets, Edge Delivery sites, repos and URLs, as the rules in code did', async () => {
    const e = env();
    const { facts } = await extract(e, await rulesFor(e, 'helix'), null, msgs(
      'see https://main--my-site--acme-corp.aem.page/x and site--org.aem.live',
      'CVE-2026-12345, ticket SITES-1234, https://jira.example.com/browse/ABC-99, github.com/acme/repo.git.',
      'ABC-1 alone is not a ticket',
    ));
    assert.deepEqual(by(facts, 'cve'), ['CVE-2026-12345']);
    assert.deepEqual(by(facts, 'ticket'), ['ABC-99', 'SITES-1234']);
    assert.deepEqual(by(facts, 'site'), ['acme-corp/my-site', 'org/site']);
    assert.deepEqual(by(facts, 'repo'), ['acme/repo']);
    assert.equal(by(facts, 'url').length, 2);
  });

  it('find sites in da.live, admin API and aem.network links, and what else the data asked for', async () => {
    const e = env();
    const { facts, tech } = await extract(e, await rulesFor(e, 'helix'), null, msgs(
      'Edit it in https://da.live/edit#/acme/web/drafts/nav and preview on https://main--shop--acme.aem.network/',
      'curl https://admin.hlx.page/preview/acme/blog/main/index returned 403 Forbidden',
      'and https://admin.hlx.page/config/acme/sites/docs.json',
      'The author is at https://author-p1234-e5678.adobeaemcloud.com/ui and see https://www.aem.live/docs/byo-cdn-akamai-setup',
      'We changed cdn.yaml and redirects.xlsx; x-error: moved permanently',
      'Akamai says Reference #18.1a2b3c4d.1792584000.5e6f7a8b',
      'Screenshot https://files.slack.com/files-pri/T1-F1/image.png and https://acme.slack.com/archives/C1/p1',
    ));
    assert.deepEqual(by(facts, 'site'), ['acme/shop', 'acme/web', 'acme/blog', 'acme/docs']);
    assert.deepEqual(by(facts, 'admin_api'), ['preview', 'config']);
    assert.deepEqual(by(facts, 'aemcs_env'), ['p1234-e5678']);
    assert.deepEqual(by(facts, 'doc'), ['docs/byo-cdn-akamai-setup']);
    assert.deepEqual(by(facts, 'config_file'), ['cdn.yaml', 'redirects.xlsx']);
    assert.deepEqual(by(facts, 'http_status'), ['403']);
    assert.deepEqual(by(facts, 'header'), ['x-error: moved']);
    // Chat links and attachments are no URL facts.
    assert.ok(!by(facts, 'url').some((u) => /slack\.com/.test(u)));
    assert.deepEqual(tech.sort(), ['aemcs', 'akamai', 'da', 'eds']);
  });
});

describe('a team\'s rules and tech stack', () => {
  it('apply to its channels, on top of the admin team\'s, and a team\'s technology replaces the admin team\'s', async () => {
    const e = env();
    const { rule } = await saveRule(e, 'helix', {
      name: 'Order ids', field: 'order', pattern: '\\bORD-(\\d{6})\\b', value: '$1',
    }, 'Bo');
    assert.equal(rule.team, 'helix');
    assert.deepEqual(by((await extract(e, await rulesFor(e, 'helix'), null, msgs('ORD-123456'))).facts, 'order'), ['123456']);
    assert.deepEqual(by((await extract(e, await rulesFor(e, 'edge'), null, msgs('ORD-123456'))).facts, 'order'), []);

    await saveTech(e, 'helix', {
      tech: 'akamai', name: 'Akamai', description: 'Akamai, as CDN or for media', enabled: true,
    }, 'Bo');
    await saveTech(e, 'helix', {
      tech: 'gdrive', name: 'Google Drive', description: 'x', enabled: false,
    }, 'Bo');
    await saveTech(e, 'helix', { tech: 'sitecore', name: 'Sitecore', description: 'Sitecore as the old CMS' }, 'Bo');
    const helix = await techFor(e, 'helix');
    const edge = await techFor(e, 'edge');
    assert.equal(helix.find((t) => t.tech === 'akamai').description, 'Akamai, as CDN or for media');
    assert.equal(edge.find((t) => t.tech === 'akamai').description, 'Akamai as CDN');
    assert.ok(!helix.some((t) => t.tech === 'gdrive'));
    assert.ok(edge.some((t) => t.tech === 'gdrive'));
    assert.ok(helix.some((t) => t.tech === 'sitecore') && !edge.some((t) => t.tech === 'sitecore'));
    assert.equal((await techNames(e)).akamai, 'Akamai');
  });

  it('are checked: a pattern that is no regular expression, matches nothing, or names no field', () => {
    assert.match(checkRule({ name: 'x', field: 'a', pattern: '(' }).error, /not a regular expression/);
    assert.match(checkRule({ name: 'x', field: 'a', pattern: 'a*' }).error, /matches empty text/);
    assert.match(checkRule({ name: 'x', field: 'Not A Field', pattern: 'a' }).error, /field/);
    assert.match(checkRule({
      name: 'x', field: 'a', pattern: 'a', flags: 'gx',
    }).error, /flags/);
    assert.match(checkRule({ name: 'x', kind: 'script', script: 'return 1' }).error, /default-exports/);
    assert.equal(checkRule({ name: 'x', field: 'a', pattern: 'a' }).rule.kind, 'regex');
  });

  it('can be scripts, which run in a Dynamic Worker without network access', async () => {
    const loaded = [];
    const LOADER = {
      get(id, make) {
        const cfg = make();
        loaded.push(cfg);
        return {
          getEntrypoint: () => ({
            fetch: async (url, init) => {
              const thread = JSON.parse(init.body);
              // The made-up script: one fact per message by a customer, and a technology.
              const results = thread.messages.filter((m) => !m.staff).map((m) => ({ field: 'said', value: m.text }));
              return Response.json({ results: [...results, { tech: 'akamai' }, { tech: 'Not An Id' }] });
            },
          }),
        };
      },
    };
    const rule = { name: 'Customer words', kind: 'script', script: 'export default (t) => [];' };
    const out = await runScript({ LOADER }, rule, {
      messages: [{ text: 'hi', staff: false }, { text: 'ok', staff: true }],
    });
    assert.deepEqual(out, { facts: [{ field: 'said', value: 'hi' }], tech: ['akamai'] });
    assert.equal(loaded[0].globalOutbound, null);
    assert.equal(loaded[0].modules['rule.js'], rule.script);
    assert.match((await runScript({}, rule, {})).error, /LOADER/);
    // Tested before it is saved: the same as a run.
    const tested = await testRule({ LOADER }, rule, { text: 'hello' });
    assert.deepEqual(tested.facts, [{ field: 'said', value: 'hello' }]);
  });
});

describe('/api/kb/extraction', () => {
  it('shows a team\'s members its rules and the admin team\'s, and lets its managers change them', async () => {
    const e = env();
    let res = await call(e, member, 'GET', '/api/kb/extraction?repo=kb-team-helix');
    assert.equal(res.status, 200);
    assert.equal(res.body.may, false);
    assert.deepEqual(res.body.rules, []);
    assert.ok(res.body.inherited.rules.some((r) => r.field === 'site'));
    assert.ok(res.body.inherited.tech.some((t) => t.tech === 'eds'));
    res = await call(e, admin, 'GET', '/api/kb/extraction?repo=kb-team-admin');
    assert.equal(res.body.global, true);
    assert.equal(res.body.inherited, null);

    res = await call(e, outsider, 'GET', '/api/kb/extraction?repo=kb-team-helix');
    assert.equal(res.status, 404);
    res = await call(e, admin, 'GET', '/api/kb/extraction?repo=kb-org-acme');
    assert.equal(res.status, 404);
    res = await call(e, member, 'POST', '/api/kb/extraction/rule', {
      repo: 'kb-team-helix', name: 'x', field: 'x', pattern: 'x',
    });
    assert.equal(res.status, 403);

    const add = {
      repo: 'kb-team-helix', name: 'Order ids', field: 'order', pattern: 'ORD-\\d+',
    };
    res = await call(e, manager, 'POST', '/api/kb/extraction/rule', add);
    assert.equal(res.status, 200);
    assert.equal(res.body.rule.by, 'Bo');
    const { id } = res.body.rule;
    res = await call(e, manager, 'POST', '/api/kb/extraction/rule', { repo: 'kb-team-helix', id, enabled: false });
    assert.equal(res.body.rule.enabled, false);
    assert.equal(res.body.rule.pattern, 'ORD-\\d+');
    res = await call(e, manager, 'POST', '/api/kb/extraction/rule', { repo: 'kb-team-helix', id, pattern: '(' });
    assert.equal(res.status, 400);
    res = await call(e, manager, 'POST', '/api/kb/extraction/test', {
      repo: 'kb-team-helix', rule: { ...add, value: '$0', transform: 'lower' }, text: 'see ORD-12 and ORD-12',
    });
    assert.deepEqual(res.body.facts, [{ field: 'order', value: 'ord-12' }]);
    res = await call(e, manager, 'POST', '/api/kb/extraction/tech', {
      repo: 'kb-team-helix', tech: 'sitecore', name: 'Sitecore', description: 'Sitecore as the old CMS',
    });
    assert.equal(res.body.tech.tech, 'sitecore');
    res = await call(e, manager, 'DELETE', '/api/kb/extraction/tech', { repo: 'kb-team-helix', tech: 'sitecore' });
    assert.equal(res.status, 200);
    res = await call(e, manager, 'DELETE', '/api/kb/extraction/rule', { repo: 'kb-team-helix', id });
    assert.equal(res.status, 200);
    res = await call(e, manager, 'DELETE', '/api/kb/extraction/rule', { repo: 'kb-team-helix', id });
    assert.equal(res.status, 404);
    // The admin team's rules are not a team's to change.
    const global = (await rulesFor(e, 'helix'))[0];
    res = await call(e, manager, 'POST', '/api/kb/extraction/rule', { repo: 'kb-team-helix', id: global.id, enabled: false });
    assert.equal(res.status, 404);
  });
});

describe('the agent\'s extraction tools', () => {
  it('are off by default, and change the rules of the agent\'s own team only', async () => {
    assert.ok(AGENT_TOOLS.some((t) => t.tool === 'extraction_rules'));
    const e = env();
    let team = 'helix';
    const ctx = { env: e, hasThread: true, target: async () => ({ key: null, team }) };
    assert.deepEqual((agentToolsExtension(ctx, []).tools || []).map((t) => t.name), []);
    const tools = Object.fromEntries(agentToolsExtension(ctx, ['extraction_rules']).tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(tools).sort(), ['delete_extraction_rule', 'delete_tech', 'list_extraction_rules',
      'save_extraction_rule', 'save_tech', 'test_extraction_rule']);
    const tested = await tools.test_extraction_rule.execute({
      name: 'Order ids', field: 'order', pattern: 'ORD-\\d+', text: 'ORD-7',
    });
    assert.match(tested.output[0].text, /"value": "ORD-7"/);
    const saved = await tools.save_extraction_rule.execute({ name: 'Order ids', field: 'order', pattern: 'ORD-\\d+' });
    assert.equal(saved.isError, undefined);
    const [rule] = (await rulesFor(e, 'helix')).filter((r) => r.team === 'helix');
    assert.match(rule.by, /^opspile-agent\//);
    team = ADMIN_TEAM;
    const refused = await tools.save_tech.execute({ tech: 'x', name: 'X', description: 'x' });
    assert.equal(refused.isError, true);
  });
});
