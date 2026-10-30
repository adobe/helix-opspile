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
  checkRule, extract, GLOBAL_TEAM, nestedRepeat, REGEX_MS, rulesFor, runScript, saveRule, saveTech,
  techFor, techNames, testRule,
} from '../src/extract.js';
import { kbAdmin } from '../src/kbadmin.js';
import { ADMIN_TEAM } from '../src/review.js';
import { d1 } from './d1.js';
import { quiet, regexLoader } from './fakes.js';

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
  return { DB, LOADER: regexLoader(), ...extra };
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

  it('change one of the admin team\'s for a team from what the admin team says, and show its name there', async () => {
    const e = env();
    let r = await saveTech(e, 'helix', { tech: 'gdrive', enabled: false }, 'Bo');
    assert.deepEqual([r.tech.name, r.tech.enabled], ['Google Drive', false]);
    assert.match(r.tech.description, /Google Drive or Google Docs/);
    r = await saveTech(e, 'helix', { tech: 'eds', name: 'Helix sites' }, 'Bo');
    assert.deepEqual([r.tech.name, r.tech.enabled], ['Helix sites', true]);
    assert.equal((await techNames(e, 'helix')).eds, 'Helix sites');
    assert.equal((await techNames(e, 'edge')).eds, 'Edge Delivery');
    assert.equal((await techNames(e)).eds, 'Edge Delivery');
    // A technology nobody has needs its name and description.
    assert.match((await saveTech(e, 'helix', { tech: 'nothing_yet' }, 'Bo')).error, /name/);
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

  it('refuse a group that repeats something that repeats, which backtracks without end', async () => {
    for (const p of ['(a+)+$', '(\\w*)*x', '(?:x|y+){2,}', '(?:(a+)b)+']) {
      assert.equal(nestedRepeat(p), true, p);
      assert.match(checkRule({ name: 'x', field: 'a', pattern: p }).error, /repeats a group/);
    }
    for (const p of ['a+b+', '(ab)+', '(a+)?', '[(a+)]+', '\\(a+\\)+', '(a{1,3})+']) {
      assert.equal(nestedRepeat(p), false, p);
    }
    assert.match(checkRule({
      name: 'x', field: 'a', pattern: 'a', exclude: '(b+)*',
    }).error, /repeats a group/);
    // The admin team's own rules pass.
    const e = env();
    for (const r of await rulesFor(e, 'helix')) {
      assert.equal(checkRule(r).error, undefined, r.name);
    }
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

describe('regex rules', () => {
  const rule = (id, pattern) => ({
    id, name: `Rule ${id}`, kind: 'regex', target: 'fact', field: `f${id}`, pattern,
  });
  const facts = async (e, rules, text = 'alpha beta gamma delta') => {
    const logged = [];
    const { log } = console;
    console.log = (line) => logged.push(JSON.parse(line));
    try {
      const out = await extract(e, rules, { thread: 'T1' }, msgs(text));
      return { ...out, logged };
    } finally {
      console.log = log;
    }
  };
  const rules = ['alpha', 'beta', 'gamma', 'delta'].map((p, i) => rule(i + 1, p));

  it('run in one Dynamic Worker per set of rules, without network access', async () => {
    const seen = [];
    const LOADER = regexLoader();
    const { get } = LOADER;
    LOADER.get = (id, make) => {
      seen.push({ id, code: make() });
      return get(id, make);
    };
    const { facts: found, skipped } = await facts({ LOADER }, rules);
    assert.deepEqual(found.map((f) => f.value), ['alpha', 'beta', 'gamma', 'delta']);
    assert.deepEqual(skipped, []);
    await facts({ LOADER }, rules, 'other text');
    await facts({ LOADER }, rules.slice(1));
    assert.equal(seen[0].code.globalOutbound, null);
    assert.equal(seen[0].code.limits.cpuMs > 0, true);
    assert.equal(seen[1].id, seen[0].id);
    assert.notEqual(seen[2].id, seen[0].id);
  });

  it('keep their value template, case, exclude pattern and flags in the Dynamic Worker', async () => {
    const r = {
      ...rule(1, '(h)ost-(\\d+)'), flags: 'i', value: '$2/$1$$', transform: 'upper', exclude: '^9',
    };
    const out = await facts({ LOADER: regexLoader() }, [r], 'HOST-1 host-1 Host-2 host-9');
    assert.deepEqual(out.facts.map((f) => f.value), ['1/H$', '2/H$']);
  });

  it('lose only the rule that does not finish, which is logged', async () => {
    const runs = [];
    const LOADER = regexLoader(({ rules: list }) => {
      runs.push(list.length);
      if (list.some((r) => r.pattern === 'gamma')) {
        throw new Error('Worker exceeded CPU time limit');
      }
    });
    const out = await facts({ LOADER }, rules);
    assert.deepEqual(out.facts.map((f) => f.value), ['alpha', 'beta', 'delta']);
    assert.deepEqual(out.skipped.map((r) => r.id), [3]);
    assert.deepEqual(out.logged, [{
      route: 'extract', action: 'regex rules skipped', thread: 'T1', rules: [3],
    }]);
    assert.deepEqual(runs, [4, 2, 2, 1, 1]);
  });

  it('stop waiting for a Dynamic Worker that does not answer', async () => {
    const LOADER = regexLoader(({ rules: list }) => (list.some((r) => r.pattern === 'beta')
      ? new Promise(() => {}) : undefined));
    const started = Date.now();
    const out = await facts({ LOADER }, rules.slice(0, 2));
    assert.deepEqual(out.facts.map((f) => f.value), ['alpha']);
    assert.deepEqual(out.skipped.map((r) => r.id), [2]);
    assert.ok(Date.now() - started >= REGEX_MS);
  });

  it('cost a thread a limited number of runs, however many fail', async () => {
    let runs = 0;
    const LOADER = regexLoader(() => {
      runs += 1;
      throw new Error('down');
    });
    const many = Array.from({ length: 200 }, (_, i) => rule(i + 1, `word${i}`));
    const out = await facts({ LOADER }, many);
    assert.equal(out.skipped.length, 200);
    assert.ok(runs <= 32, `${runs} runs`);
  });

  it('leave out rules refused since they were saved, and do not run without LOADER', async () => {
    const LOADER = regexLoader(({ rules: list }) => {
      assert.deepEqual(list.map((r) => r.pattern), ['alpha']);
    });
    const out = await facts({ LOADER }, [rule(1, 'alpha'), rule(2, '(a+)+$')]);
    assert.deepEqual(out.facts.map((f) => f.value), ['alpha']);
    assert.deepEqual(out.skipped, []);
    assert.deepEqual((await facts({}, rules)).facts, []);
  });

  it('say so when tested on text they do not finish on', async () => {
    const r = { name: 'Slow', field: 'slow', pattern: 'alpha' };
    const LOADER = regexLoader(() => {
      throw new Error('Worker exceeded CPU time limit');
    });
    assert.match((await quiet(() => testRule({ LOADER }, r, { text: 'alpha' }))).error, /did not finish/);
    assert.match((await testRule({}, r, { text: 'alpha' })).error, /LOADER/);
    assert.deepEqual(await testRule({ LOADER: regexLoader() }, r, { text: 'alpha' }), {
      facts: [{ field: 'slow', value: 'alpha' }], tech: [],
    });
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
