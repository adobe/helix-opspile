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
import { syncFollowRules } from '../src/followrules.js';
import {
  excluding, findRuleConflicts, intersecting, scanPattern,
} from '../src/ruleconflicts.js';
import { classify, followers } from '../src/rules.js';
import { d1 } from './d1.js';

// Made-up teams, channels and people only.
const ch = (channelId, name, extra = {}) => ({
  source: 'slack', channelId, name, groupName: null, connected: [], ...extra,
});
const rule = (id, value, pattern, extra = {}) => ({
  id, target: 'team', priority: 100, source: null, field: 'name', pattern, value, note: null, ...extra,
});
const pin = (id, value, channelId, priority = 10) => rule(id, value, `^${channelId}$`, {
  field: 'channel_id', priority, source: 'slack', note: 'manual assignment',
});

describe('rule conflicts: patterns', () => {
  it('reads a pattern: groups made non-capturing, top-level alternatives, back references', () => {
    assert.deepEqual(scanPattern('^(aem-live|da)-'), { out: '^(?:aem-live|da)-', alt: false, backref: false });
    assert.deepEqual(scanPattern('^a|b'), { out: '^a|b', alt: true, backref: false });
    assert.equal(scanPattern('[(|]x(?<n>y)').out, '[(|]x(?:y)');
    assert.equal(scanPattern('(?<=a)b(?!c)').out, '(?<=a)b(?!c)');
    assert.equal(scanPattern('^(a)\\1').backref, true);
    assert.equal(scanPattern('[\\1]').backref, false);
  });

  it('writes a pattern without what another matches, its groups numbered as before', () => {
    assert.equal(excluding('^aem-', '^(aem-live|da)-'), '^(?!(?:aem-live|da)-)aem-');
    assert.equal(excluding('^aem-(.+)$', '^aem-edge-'), '^(?!aem-edge-)aem-(.+)$');
    const cases = [
      ['^aem-', '^(aem-live|da)-'],
      ['^aem-(.+)$', 'edge'],
      ['support$', '^x|^aem-'],
      ['^(?:a|b)-', '-alerts$'],
    ];
    const names = ['aem-acme', 'aem-live-acme', 'da-acme', 'aem-edge', 'acme-support', 'x-support',
      'aem-support', 'a-alerts', 'b-thing', 'a-x', 'AEM-LIVE-x'];
    for (const [a, b] of cases) {
      const re = new RegExp(excluding(a, b), 'i');
      for (const n of names) {
        assert.equal(re.test(n), new RegExp(a, 'i').test(n) && !new RegExp(b, 'i').test(n), `${a} - ${b} on ${n}`);
      }
    }
    // The groups of the first pattern keep their numbers ($1).
    assert.equal(new RegExp(excluding('^aem-(.+)$', '^(aem-edge)-'), 'i').exec('aem-acme')[1], 'acme');
    assert.equal(excluding('^aem-', '^(a)\\1'), null);
    // And where both match, for a follow rule.
    assert.equal(intersecting('^(aem-live|da)-', '^aem-'), '^(?=aem-)(aem-live|da)-');
    for (const [a, b] of cases) {
      const re = new RegExp(intersecting(a, b), 'i');
      for (const n of names) {
        assert.equal(re.test(n), new RegExp(a, 'i').test(n) && new RegExp(b, 'i').test(n), `${a} & ${b} on ${n}`);
      }
    }
  });
});

describe('rule conflicts: finding them', () => {
  const CHANNELS = [
    ch('C1', 'aem-acme'), ch('C2', 'aem-live-acme'), ch('C3', 'aem-live-globex'),
    ch('C4', 'aem-live-initech'), ch('C5', 'random'), ch('C6', 'da-hooli'),
    ch('C7', 'aem-live-old', { archived: true }),
  ];
  const RULES = [
    rule(1, 'platform', '^aem-'),
    rule(2, 'edge', '^(aem-live|da)-', { priority: 50 }),
    // Assigned by hand: its channel is in no conflict, whatever the rules say.
    pin(3, 'search', 'C4'),
    // The fallback matches every channel: it conflicts with none.
    rule(6, 'admin', '.', { field: 'channel_id', priority: 1000 }),
    // The same team: no conflict.
    rule(7, 'platform', '^aem-acme$'),
    // Another target: not a team rule.
    rule(9, 'acme', '^aem-', { target: 'org' }),
  ];

  it('pairs two teams\' rules that match a channel no manual assignment decides', async () => {
    const list = await findRuleConflicts(RULES, CHANNELS);
    assert.deepEqual(list.map((c) => [
      c.key, c.section, c.a.team, c.b.team, c.channels.map((x) => x.channelId),
    ]), [['rule:1|rule:2', 'rules', 'platform', 'edge', ['C2', 'C3']]]);
    const [c] = list;
    const { a, b } = c;
    assert.deepEqual([a.wins, b.wins, a.matches, b.matches], [0, 2, 4, 4]);
    assert.deepEqual(c.channels.map((x) => x.winner), ['edge', 'edge']);
    // Either side can win; the other team follows what both match.
    assert.deepEqual(c.win.a, {
      ok: true,
      rule: 2,
      pattern: '^(?!aem-)(aem-live|da)-',
      empty: false,
      follow: { pattern: '^(?=aem-)(aem-live|da)-', source: null },
    });
    assert.deepEqual(c.win.b, {
      ok: true,
      rule: 1,
      pattern: '^(?!(?:aem-live|da)-)aem-',
      empty: false,
      follow: { pattern: '^(?=(?:aem-live|da)-)aem-', source: null },
    });
    assert.match(c.fingerprint, /^[0-9a-f]{64}$/);
  });

  it('says where a side cannot win: other fields, a platform, the admin team following', async () => {
    const list = await findRuleConflicts([
      rule(1, 'platform', '^aem-'),
      rule(2, 'edge', '^xyz-', { field: 'group_name', source: 'teams' }),
      rule(3, 'search', '^aem-l', { source: 'slack' }),
      rule(4, 'admin', '^aem-live-x$', { priority: 20 }),
    ], [
      ch('T1', 'aem-team', { source: 'teams', groupName: 'xyz-acme' }),
      ch('C1', 'aem-live-x'), ch('C2', 'aem-lake'), ch('C3', 'aem-other'), ch('C9', 'random'),
    ]);
    const by = Object.fromEntries(list.map((c) => [c.key, c]));
    const other = by['rule:1|rule:2'];
    assert.equal(other.section, 'other');
    assert.match(other.win.a.why, /different things/);
    // The slack-only rule can lose to the rule of every platform, not win over it.
    const slack = by['rule:1|rule:3'];
    assert.equal(slack.win.a.ok, true);
    assert.match(slack.win.b.why, /slack only/);
    // The admin team holds what no team has: it follows nothing; a rule left with nothing goes.
    const admin = by['rule:1|rule:4'];
    assert.deepEqual([admin.win.a.follow, admin.win.a.empty], [null, true]);
    assert.equal(admin.win.b.follow.pattern, '^(?=aem-live-x$)aem-');
  });
});

describe('follow rules', () => {
  it('share every channel they match with their team, but the ones filed under it', () => {
    const rules = [
      rule(1, 'platform', '^aem-'),
      rule(2, 'edge', '^aem-live-', { target: 'follow' }),
      rule(3, 'search', 'live', { target: 'follow' }),
      rule(4, 'search', '^aem-live-hooli$', { priority: 10 }),
    ];
    const c = ch('C1', 'aem-live-hooli');
    assert.equal(classify(rules, c).team, 'search');
    assert.deepEqual(followers(rules, c).map((f) => [f.rule.id, f.team]), [[2, 'edge'], [3, 'search']]);
  });
});

const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: [{ slug: 'admin' }],
};

function env() {
  const DB = d1({
    people: [{ ...ADA, teams: ['admin'] }],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'platform', name: 'Platform' }, { slug: 'edge', name: 'Edge' }],
    rules: [
      rule(1, 'platform', '^aem-'),
      rule(2, 'edge', '^(aem-live|da)-', { priority: 50 }),
      rule(4, 'edge', '^aem-cdn-'),
      rule(6, 'admin', '.', { field: 'channel_id', priority: 1000 }),
    ],
  });
  const at = '2026-10-22T00:00:00Z';
  for (const [id, name] of [['C1', 'aem-acme'], ['C2', 'aem-live-acme'], ['C3', 'aem-live-globex'], ['C4', 'da-initech'], ['C5', 'random'], ['C6', 'aem-cdn-hooli']]) {
    DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', ?, ?, ?)`).run(id, name, at);
  }
  const thread = (id, team) => DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant,
      channel_id, root_id, org, team, kind, channel_name, path, root_at, last_at, any_at, messages,
      updated_at) VALUES (?, 'slack', 'E1', ?, '1.1', '_unassigned', ?, 'channel', ?, ?, ?, ?, ?, 1, ?)`)
    .run(`slack:E1:${id}:1.1`, id, team, id, `channels/_unassigned/${team}/slack-${id}/1.1/`, at, at, at, at);
  thread('C2', 'edge');
  thread('C4', 'edge');
  thread('C6', 'platform');
  const queued = [];
  return { DB, queued, NORMALIZE: { send: async (body) => queued.push(body) } };
}

async function call(e, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: ADA });
  return { status: res.status, body: await res.json() };
}

describe('admin: rule conflicts', () => {
  const KEYS = ['rule:1|rule:2', 'rule:1|rule:4'];

  it('lists them for the admin team\'s inbox and counts them, and keeps one while it stays as kept', async () => {
    const e = env();
    let r = await call(e, 'GET', '/api/admin/requests');
    assert.deepEqual(r.body.ruleConflicts.map((c) => c.key), KEYS);
    assert.equal(r.body.open, 2);
    assert.equal((await call(e, 'GET', '/api/admin/teams')).body.requests, 2);
    const [, cdn] = r.body.ruleConflicts;
    // Settled from what was shown: not after it changed.
    assert.equal((await call(e, 'POST', '/api/admin/rule-conflicts', {
      key: cdn.key, action: 'keep', fingerprint: 'stale',
    })).status, 409);
    r = await call(e, 'POST', '/api/admin/rule-conflicts', {
      key: cdn.key, action: 'keep', fingerprint: cdn.fingerprint, note: 'Edge runs it',
    });
    assert.equal(r.status, 200);
    const { kept } = r.body.ruleConflicts.find((c) => c.key === cdn.key);
    assert.deepEqual(kept, { by: 'ada@staff.example', at: kept.at, note: 'Edge runs it' });
    assert.equal((await call(e, 'GET', '/api/admin/requests')).body.open, 1);
    // Another channel for it: open again.
    e.DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C8', 'aem-cdn-wonka', '2026-10-22T00:00:00Z')`);
    assert.equal((await call(e, 'GET', '/api/admin/requests')).body.open, 2);
    // A manual assignment settles it for its channel: open again only if another channel is left.
    e.DB.sqlite.exec(`INSERT INTO rules (target, priority, source, field, pattern, value, note)
      VALUES ('team', 10, 'slack', 'channel_id', '^C8$', 'edge', 'manual assignment')`);
    assert.equal((await call(e, 'GET', '/api/admin/requests')).body.open, 1);
  });

  it('lets the broader side win: the other rule leaves it out, and its team follows what both match', async () => {
    const e = env();
    const [c] = (await call(e, 'GET', '/api/admin/requests')).body.ruleConflicts;
    const win = {
      key: c.key, action: 'win', side: 'a', follow: true, fingerprint: c.fingerprint,
    };
    let r = await call(e, 'POST', '/api/admin/rule-conflicts', { ...win, dryRun: true });
    // Only what both match moves; da- stays with edge.
    assert.deepEqual(r.body.moves.map((m) => [m.channel.channelId, m.from[0].team, m.to.team]), [['C2', 'edge', 'platform']]);
    assert.deepEqual(r.body.follows.map((x) => x.channelId).sort(), ['C2', 'C3']);
    assert.equal(e.DB.rows('SELECT pattern FROM rules WHERE id = 2')[0].pattern, '^(aem-live|da)-');
    r = await call(e, 'POST', '/api/admin/rule-conflicts', win);
    assert.equal(r.status, 200);
    assert.equal(e.queued.length, 1);
    assert.equal(e.DB.rows('SELECT pattern FROM rules WHERE id = 2')[0].pattern, '^(?!aem-)(aem-live|da)-');
    const [follow] = e.DB.rows("SELECT id, pattern, value, note FROM rules WHERE target = 'follow'");
    assert.deepEqual([follow.pattern, follow.value, follow.note], ['^(?=aem-)(aem-live|da)-', 'edge', 'what platform\'s rule #1 files (rule conflict)']);
    assert.deepEqual(e.DB.rows('SELECT channel_id, team, added_by FROM channel_teams ORDER BY channel_id'), [
      { channel_id: 'C2', team: 'edge', added_by: `rule:${follow.id}` },
      { channel_id: 'C3', team: 'edge', added_by: `rule:${follow.id}` },
    ]);
    assert.deepEqual(r.body.ruleConflicts.map((x) => x.key), ['rule:1|rule:4']);
    // A share a rule made is the rule's: not taken away by hand.
    const un = await call(e, 'DELETE', '/api/admin/share', { source: 'slack', channelId: 'C2', team: 'edge' });
    assert.equal(un.status, 409);
    // The team page lists its follow rule.
    const page = await call(e, 'GET', '/api/admin/team?slug=edge');
    assert.deepEqual(page.body.rules.map((x) => x.target).sort(), ['follow', 'team', 'team']);
    // A channel filed under the team is not shared with it; deleted, the rule takes its shares.
    e.DB.sqlite.exec(`INSERT INTO rules (target, priority, field, pattern, value)
      VALUES ('team', 10, 'name', '^aem-live-globex$', 'edge')`);
    await syncFollowRules(e);
    assert.deepEqual(e.DB.rows('SELECT channel_id FROM channel_teams'), [{ channel_id: 'C2' }]);
    await call(e, 'DELETE', '/api/admin/rules', { id: follow.id });
    assert.deepEqual(e.DB.rows('SELECT channel_id FROM channel_teams'), []);
  });

  it('lets the narrower side win, and a rule left with nothing goes or becomes the follow rule', async () => {
    const e = env();
    const [prefix, cdn] = (await call(e, 'GET', '/api/admin/requests')).body.ruleConflicts;
    let r = await call(e, 'POST', '/api/admin/rule-conflicts', {
      key: prefix.key, action: 'win', side: 'b', fingerprint: prefix.fingerprint,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moves, []);
    assert.equal(e.DB.rows('SELECT pattern FROM rules WHERE id = 1')[0].pattern, '^(?!(?:aem-live|da)-)aem-');
    assert.deepEqual(e.DB.rows("SELECT id FROM rules WHERE target = 'follow'"), []);
    // The cdn rule matches nothing the prefix does not: won over, it becomes the follow rule.
    [r] = (await call(e, 'GET', '/api/admin/requests')).body.ruleConflicts;
    assert.equal(r.key, cdn.key);
    assert.equal(r.win.a.empty, true);
    r = await call(e, 'POST', '/api/admin/rule-conflicts', {
      key: cdn.key, action: 'win', side: 'a', follow: true,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moves, []);
    assert.deepEqual(e.DB.rows('SELECT target, pattern FROM rules WHERE id = 4'), [{ target: 'follow', pattern: '^aem-cdn-' }]);
    assert.deepEqual(e.DB.rows('SELECT channel_id, team FROM channel_teams'), [{ channel_id: 'C6', team: 'edge' }]);
    assert.deepEqual(r.body.ruleConflicts, []);
    assert.equal((await call(e, 'POST', '/api/admin/rule-conflicts', { key: cdn.key, action: 'keep' })).status, 404);
    assert.equal((await call(e, 'POST', '/api/admin/rule-conflicts', { key: 'rule:1|rule:2', action: 'follow' })).status, 404);
  });
});
