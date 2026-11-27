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
import { forgetEvidence } from '../src/orgpartners.js';
import { forgetPartnerDomains } from '../src/partners.js';
import {
  evidenceText, markSeen, quoteLines, withQuotes,
} from '../src/requestevidence.js';
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
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['helix'],
};
const viewer = (p) => ({
  id: p.id, email: p.email, name: p.name, teams: p.teams.map((slug) => ({ slug })),
});
const AT = '2026-10-22T00:00:00Z';

/** Clef, made up: the agency works for Globex. What it is shown is kept (`asked`). */
const fakeAI = () => {
  const asked = [];
  return {
    asked,
    async run(model, input) {
      asked.push(input.state);
      const yes = /C: slug globex,/.test(input.state) && /P: slug agency,/.test(input.state);
      return { answers: { works: { type: 'noul', noul: yes ? 0.9 : 0.2 } } };
    },
  };
};

/**
 * Globex, a customer, and the agency, a partner. Two of the agency's people post in three of
 * Globex's threads: one says they run Globex's site. In the agency's own channel, Bo (Adobe) asks
 * when Globex goes live; Cy (Adobe) answers in Globex's threads.
 */
function env() {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  const sql = DB.sqlite;
  sql.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at) VALUES
      ('slack', 'E1', 'C1', 'aem-globex', '${AT}'), ('slack', 'E1', 'C2', 'aem-agency', '${AT}');
    INSERT INTO orgs (slug, name, type, updated_at) VALUES
      ('globex', 'Globex', 'customer', '${AT}'), ('agency', 'The Agency', 'partner', '${AT}');
    INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at) VALUES
      ('slack', 'E1', 'U1', 'person', 'Wile', 'wile@agency.example', '${AT}'),
      ('slack', 'E1', 'U2', 'person', 'Road', 'road@agency.example', '${AT}'),
      ('slack', 'E1', 'U3', 'person', 'Hank', 'hank@globex.example', '${AT}')`);
  const thread = sql.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
      team, kind, channel_name, title, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, ?, ?, 'helix', 'channel', ?, ?, ?, ?, ?, ?, 1, ?)`);
  const roots = [['C1', '1.1', 'globex', 'Site migration'], ['C1', '1.2', 'globex', 'Search index'],
    ['C1', '1.3', 'globex', 'Fonts'], ['C2', '2.1', 'agency', 'Go-live dates']];
  for (const [ch, root, org, title] of roots) {
    thread.run(`slack:E1:${ch}:${root}`, ch, root, org, `aem-${org}`, title, `channels/${org}/helix/slack-${ch}/${root}/`, AT, AT, AT, AT);
  }
  const post = sql.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, author_key, person, preview, permalink) VALUES ('slack', 'E1', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
  const posts = [
    ['C2', '2.1', 'U1', 0, null, 'We are on it'],
    ['C1', '1.1', 'U3', 0, null, 'Thanks'],
    ['C1', '1.1', 'U1', 0, null, 'We migrated the site for Globex and are admins of its repository'],
    ['C1', '1.2', 'U2', 0, null, 'Reindexing now'],
    ['C1', '1.3', 'U1', 0, null, 'Fonts fixed'],
    ['C1', '1.1', 'UC', 1, 3, 'Thanks, that helps'],
    ['C2', '2.1', 'UB', 1, 2, 'When does Globex go live with the new site?'],
  ];
  posts.forEach(([ch, root, user, staff, person, preview], i) => post.run(ch, `m${i}`, `slack:E1:${ch}:${root}`, `2026-10-${10 + i}T10:00:00Z`, staff, `slack:E1:${user}`, person, preview, `https://example.slack.com/archives/${ch}/p${i}`));
  return {
    DB, AI: fakeAI(), STAFF_DOMAINS: 'staff.example', CHANNELS: fakeBucket(), NORMALIZE: { send: async () => {} },
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

describe('the evidence of a request', () => {
  it('links the threads behind a partner request, and names who could know', async () => {
    const e = env();
    const r = await quiet(() => call(e, BO, 'POST', '/api/admin/org-partner-requests', {
      customer: 'globex', partner: 'agency', action: 'link', note: 'Do they work for Globex?',
    }));
    const key = requestKey('partner', r.body.request.id);
    const t = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`));
    const { body } = t.body.messages[0];
    // The partner's people in the customer's threads: each thread, opened at the message that says
    // the most, its quote and the platform's permalink.
    assert.match(body, /\*\*The Agency's people in Globex's threads \(agency\.example\)\*\*/);
    assert.match(body, /\[Site migration\]\(\/inbox\?team=helix&t=slack%3AE1%3AC1%3A1\.1&m=m2\), #aem-globex \(Slack\), 2026-10-12 — Wile: “We migrated the site for Globex/);
    assert.match(body, /\(\[in Slack\]\(https:\/\/example\.slack\.com\/archives\/C1\/p2\)\)/);
    // The customer named in the partner's threads, by Adobe.
    assert.match(body, /\*\*Globex named in The Agency's threads\*\*\n- \[Go-live dates\]\([^)]*&m=m6\)[^\n]*Bo \(Adobe\): “When does Globex go live/);
    // Who worked those threads at Adobe, and the action to ask one of them.
    assert.match(body, /\*\*Who could know:\*\* Bo \(bo@staff\.example, in one of these threads, last 2026-10-16\); Cy \(cy@staff\.example, in one of these threads, last 2026-10-15\)/);
    const ask = t.body.request.actions.find((a) => a.id === 'ask');
    assert.deepEqual(ask.fields[0].options.map((o) => o.value), ['bo@staff.example', 'cy@staff.example', '']);
    assert.equal(ask.fields[2].value, 'Does The Agency work for Globex?');
    // Asked, Cy has it in their inbox; what they answer comes into the request's log.
    const asked = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', {
      key, action: 'ask', values: { who: 'cy@staff.example', question: 'Does the agency run Globex\'s site?' },
    }));
    assert.equal(asked.status, 200);
    assert.match(asked.body.done, /Asked Cy/);
    assert.match(asked.body.thread.messages.at(-1).body, /Asked \*\*Cy\*\*: Does the agency run Globex's site\?/);
    const [q] = rows(e, 'SELECT id, thread, team, email, asked_by FROM questions');
    assert.deepEqual([q.thread, q.team, q.email, q.asked_by], [key, 'helix', 'cy@staff.example', 'ada@staff.example']);
    const mine = await quiet(() => call(e, CY, 'GET', '/api/requests'));
    const entry = mine.body.threads.find((x) => x.thread === requestKey('question', q.id));
    assert.ok(entry);
    const theirs = await quiet(() => call(e, CY, 'GET', `/api/thread?thread=${encodeURIComponent(entry.thread)}`));
    assert.match(theirs.body.messages[0].body, /^Ada of the admin team asks you, to decide a request of its inbox/);
    assert.equal(theirs.body.messages[0].author.name, 'Ada');
    const answered = await quiet(() => call(e, CY, 'POST', '/api/requests/resolve', {
      key: entry.thread, action: 'answer', values: { text0: 'Yes, since the spring' },
    }));
    assert.equal(answered.status, 200);
    assert.match(answered.body.done, /Sent to the admin team\. The admin team reads it in its request\./);
    const after = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`));
    const last = after.body.messages.at(-1);
    assert.equal(last.author.name, 'Cy');
    assert.match(last.body, /^Answered:\n\n1\. Does the agency run Globex's site\? Yes, since the spring/);
    assert.ok(rows(e, 'SELECT told_at FROM questions')[0].told_at);
  });

  it('shows Clef the deciding messages, and asks again on no new thread', async () => {
    const e = env();
    const load = () => quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners?fresh=1'));
    await load();
    const [state] = e.AI.asked;
    assert.match(state, /What their messages say, quoted short \(who wrote them left out\):/);
    assert.match(state, /- In a thread of C \(#aem-globex\), one of P's people wrote: "We migrated the site for Globex and are admins of its repository"/);
    assert.match(state, /- In a thread of P \(#aem-agency\), Adobe staff wrote: "When does Globex go live with the new site\?"/);
    // No names of people go to Clef.
    assert.ok(!/Wile|Road|Bo\b|Cy\b/.test(state));
    // A new thread of theirs changes the quotes, not the fingerprint: Clef is not asked again.
    e.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        channel_name, title, path, root_at, last_at, any_at, messages, updated_at)
      VALUES ('slack:E1:C1:1.4', 'slack', 'E1', 'C1', '1.4', 'globex', 'helix', 'channel', 'aem-globex',
        'Redirects', 'channels/globex/helix/slack-C1/1.4/', '${AT}', '${AT}', '${AT}', 1, '${AT}');
      INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key, preview)
      VALUES ('slack', 'E1', 'C1', 'm9', 'slack:E1:C1:1.4', '${AT}', 0, 1, 'slack:E1:U2',
        'The redirects are in our repository for Globex now')`);
    forgetEvidence();
    await load();
    assert.equal(e.AI.asked.length, 1);
  });

  it('links where two orgs name each other for a merge, and quotes it to Clef', async () => {
    const e = env();
    // Globex Corp, a channel of its own, whose thread names Globex.
    e.DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
        VALUES ('slack', 'E1', 'C3', 'aem-globexcorp', '${AT}');
      INSERT INTO orgs (slug, name, type, updated_at) VALUES ('globexcorp', 'Globex Corp', 'customer', '${AT}');
      INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name,
          title, path, root_at, last_at, any_at, messages, updated_at)
        VALUES ('slack:E1:C3:3.1', 'slack', 'E1', 'C3', '3.1', 'globexcorp', 'helix', 'channel',
          'aem-globexcorp', 'Billing', 'channels/globexcorp/helix/slack-C3/3.1/', '${AT}', '${AT}', '${AT}', 1, '${AT}');
      INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key, person, preview)
        VALUES ('slack', 'E1', 'C3', 'g1', 'slack:E1:C3:3.1', '${AT}', 1, 1, 'slack:E1:UC', 3,
          'This is the same contract as the one of Globex, the parent company')`);
    const r = await quiet(() => call(e, ADA, 'POST', '/api/admin/org-merge-requests', { from: 'globexcorp', into: 'globex' }));
    assert.equal(r.status, 200);
    const key = requestKey('merge', r.body.request.id);
    const t = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`));
    const { body } = t.body.messages[0];
    assert.match(body, /\*\*Globex named in Globex Corp's threads\*\*\n- \[Billing\]\([^)]*&m=g1\)[^\n]*Cy \(Adobe\): “This is the same contract/);
    assert.match(body, /\*\*Who could know:\*\* Cy \(cy@staff\.example, in one of these threads/);
    assert.equal(t.body.request.actions.at(-1).fields[2].value, 'Are Globex Corp and Globex one company?');
    // Clef, asked about the two, is shown the message too, not who wrote it.
    e.AI.asked.length = 0;
    await quiet(() => call(e, ADA, 'GET', '/api/admin/org-duplicates?pair=globex:globexcorp'));
    assert.match(e.AI.asked.at(-1), /- In a thread of B \(#aem-globexcorp\), Adobe staff wrote: "This is the same contract as the one of Globex, the parent company"/);
  });

  it('lists the threads behind a pair on its page, and what a viewer may not read by where only', async () => {
    const e = env();
    const get = (who) => quiet(() => call(e, who, 'GET', '/api/admin/org-partners/evidence?pair=globex:agency'));
    // The admin team: the heads with the mail domains, each thread linked at its message.
    const a = await get(ADA);
    assert.equal(a.status, 200);
    const posters = a.body.sections.find((s) => /people in Globex's threads/.test(s.head));
    assert.equal(posters.head, 'The Agency\'s people in Globex\'s threads (agency.example)');
    const [first] = posters.items;
    assert.equal(first.seen, true);
    assert.equal(first.title, 'Site migration');
    assert.equal(first.href, '/inbox?team=helix&t=slack%3AE1%3AC1%3A1.1&m=m2');
    assert.equal(first.permalink, 'https://example.slack.com/archives/C1/p2');
    assert.match(first.preview, /^We migrated the site for Globex/);
    assert.deepEqual(a.body.people.map((p) => p.email), ['bo@staff.example', 'cy@staff.example']);
    // Bo, on the team of the threads: them too, under heads without the domains, and not
    // himself as who could know.
    const b = await get(BO);
    assert.equal(b.status, 200);
    assert.ok(b.body.sections.some((s) => s.head === 'The Agency\'s people in Globex\'s threads'));
    assert.ok(!JSON.stringify(b.body).includes('agency.example'));
    assert.ok(b.body.sections.flatMap((s) => s.items).every((x) => x.seen && x.href));
    assert.deepEqual(b.body.people.map((p) => p.email), ['cy@staff.example']);
    // Someone on another team: where and when only, and nobody who could know.
    const z = await get({ id: 9, email: 'zed@staff.example', teams: ['edge'] });
    assert.equal(z.status, 200);
    const items = z.body.sections.flatMap((s) => s.items);
    assert.ok(items.length);
    assert.deepEqual(Object.keys(items[0]).sort(), ['at', 'channel', 'n', 'org', 'seen', 'source', 'team']);
    assert.ok(!/Site migration|We migrated/.test(JSON.stringify(z.body)));
    assert.deepEqual(z.body.people, []);
    // Nobody off an ops team, and no such pair.
    assert.equal((await get({ id: 10, email: 'x@staff.example', teams: [] })).status, 403);
    const none = await quiet(() => call(e, ADA, 'GET', '/api/admin/org-partners/evidence?pair=globex:nobody'));
    assert.equal(none.status, 404);
  });

  it('names a thread the viewer may not see by its customer, team and channel only', async () => {
    const e = env();
    const thread = {
      thread: 'slack:E1:C1:1.1', team: 'helix', org: 'globex', source: 'slack', channel_id: 'C1', channel_name: 'aem-globex', title: 'Site migration',
    };
    const message = {
      ...thread, id: 'm2', at: '2026-10-12T10:00:00Z', preview: 'Secret plans', author: 'Wile', staff: 0,
    };
    const ev = {
      sections: [{
        head: 'Threads', items: [{ thread, message, n: 1 }], more: 0, threads: [thread.thread],
      }],
      people: [],
    };
    const n = { org: (slug) => ({ globex: 'Globex' }[slug] || slug), team: (slug) => ({ helix: 'Helix ops' }[slug] || slug) };
    // Nobody on Helix ops sees it; Ada, of the admin team, does.
    const someone = { id: 9, email: 'zed@staff.example', teams: [{ slug: 'edge' }] };
    const hidden = evidenceText(await markSeen(e, someone, structuredClone(ev)), n);
    assert.equal(hidden, '**Threads**\n- A thread of **Globex** in Helix ops\'s #aem-globex (Slack), 2026-10-12');
    const shown = evidenceText(await markSeen(e, viewer(ADA), structuredClone(ev)), n);
    assert.match(shown, /\[Site migration\]\(\/inbox\?team=helix&t=slack%3AE1%3AC1%3A1\.1&m=m2\)[^\n]*“Secret plans”/);
  });

  it('quotes one message a thread, every kind first, without who wrote it', () => {
    const m = (thread, preview, at = AT) => ({
      thread, id: preview, at, preview, source: 'slack', channel_name: 'aem-x',
    });
    const lines = quoteLines([
      { where: 'a thread of C', who: () => 'one of P\'s people', messages: [m('t1', 'a long first message'), m('t1', 'short'), m('t2', 'second thread')] },
      { where: 'a thread of P', who: () => 'Adobe staff', messages: [m('t3', 'named here')] },
    ]);
    assert.deepEqual(lines, [
      'In a thread of C (#aem-x), one of P\'s people wrote: "a long first message"',
      'In a thread of P (#aem-x), Adobe staff wrote: "named here"',
      'In a thread of C (#aem-x), one of P\'s people wrote: "second thread"',
    ]);
    assert.equal(withQuotes('state', []), 'state');
    assert.equal(withQuotes('state', ['x']), 'state\nWhat their messages say, quoted short (who wrote them left out):\n- x');
  });
});
