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
import { render } from '../src/channels.js';
import { forgetPartnerDomains } from '../src/partners.js';
import {
  ABOUT_MIN, aboutOf, aboutScores, aboutThreads, dismissAbout, dismissLink, entryLinks,
  FACT_OWNER_FEW, FACT_OWNER_ONLY, forgetOwners, linkedOrgsOf, linkThread, RELATED_SURE, shownLink,
} from '../src/threadlinks.js';
import { deliveryText } from '../src/agent/deliver.js';
import { relatedNote, relatedThreads } from '../src/agent/related.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up orgs, people, channels and sites only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['edge'],
};
const asMe = (p) => ({ ...p, teams: p.teams.map((t) => (typeof t === 'string' ? { slug: t } : t)) });
const AT = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
const OLD = new Date(Date.now() - 40 * 86400 * 1000).toISOString();

const P1 = 'slack:E1:CP:1.1';
const G1 = 'slack:E1:CG:2.1';
const G2 = 'slack:E1:CG:2.2';
const I1 = 'slack:E1:CI:3.1';
const PATHS = {
  [P1]: 'channels/agency/helix/slack-CP/1.1/',
  [G1]: 'channels/globex/edge/slack-CG/2.1/',
  [G2]: 'channels/globex/edge/slack-CG/2.2/',
  [I1]: 'channels/initech/helix/slack-CI/3.1/',
};

/** The thread vectors, made up: each thread's, and which are alike. */
const VECTORS = {
  [P1]: [1, 0, 0],
  [G1]: [0.9, 0.1, 0],
  [G2]: [0, 1, 0],
  [I1]: [0, 0, 1],
  'slack:E1:CC:4.1': [0, 0.5, 0.5],
};
const cos = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0)
  / (Math.hypot(...a) * Math.hypot(...b));

/**
 * The agency (a partner) works for Globex (confirmed) and Initech (likely). Its thread P1 names
 * Globex's site owner `globex-web`, which only Globex's threads name too; Globex's G1 is about the
 * same, G2 is not, and one of the agency's people posts in G1.
 */
function env({ ai = true, content = true } = {}) {
  const DB = d1({
    people: [ADA, BO],
    teams: [{ slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  const sql = DB.sqlite;
  sql.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES
    ('agency', 'Agency Co', 'partner', '${AT}'), ('globex', 'Globex Corp', 'customer', '${AT}'),
    ('initech', 'Initech', 'customer', '${AT}')`);
  sql.exec(`INSERT INTO org_partners (customer, partner, score, signals, confirmed_by, confirmed_at)
    VALUES ('globex', 'agency', 4, '[]', 'ada', '${AT}')`);
  sql.exec('INSERT INTO org_partners (customer, partner, score, signals, p) VALUES (\'initech\', \'agency\', 2, \'[]\', 0.8)');
  const thread = (key, org, team, name, title, last = AT) => {
    const [, , id, root] = key.split(':');
    sql.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        channel_name, title, path, root_at, last_at, any_at, messages, updated_at, embedded)
      VALUES (?, 'slack', 'E1', ?, ?, ?, ?, 'channel', ?, ?, ?, ?, ?, ?, 2, ?, 'h')`)
      .run(key, id, root, org, team, name, title, PATHS[key], last, last, last, last);
  };
  thread(P1, 'agency', 'helix', 'agency-projects', 'Old code after the repository move');
  thread(G1, 'globex', 'edge', 'aem-globex', 'Preview serves stale code');
  thread(G2, 'globex', 'edge', 'aem-globex', 'Invoice question', OLD);
  thread(I1, 'initech', 'helix', 'aem-initech', 'Forms do not submit');
  const fact = (key, field, value) => sql.prepare(`INSERT INTO facts (thread, source, field, value)
    VALUES (?, 'rule', ?, ?)`).run(key, field, value);
  fact(P1, 'site', 'globex-web/site');
  fact(G1, 'url', 'https://main--site--globex-web.aem.page/');
  // An agency person in Globex's thread, by their mail domain (the admin team's row).
  sql.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at)
    VALUES ('slack', 'E1', 'U9', 'person', 'Lee', 'lee@agency.example', ?)`).run(AT);
  sql.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key)
    VALUES ('slack', 'E1', 'CG', '2.5', ?, ?, 0, 1, 'slack:E1:U9')`).run(G1, AT);
  sql.prepare('INSERT INTO partner_domains (domain, name, org) VALUES (\'agency.example\', NULL, \'agency\')').run();
  const file = (key, id, name, body) => [`${PATHS[key]}${id}.md`, render({
    source: 'slack', thread: key, id, at: AT, author: { kind: 'person', name, staff: false },
  }, body)];
  const CHANNELS = fakeBucket(Object.fromEntries([
    file(P1, '1.1', 'Lee', 'After the move of the repository the preview still serves the old code.'),
    file(G1, '2.1', 'Gus', 'Our preview serves stale code since yesterday.'),
    file(G2, '2.2', 'Gus', 'A question about our invoice.'),
    file(I1, '3.1', 'Ina', 'The forms do not submit.'),
  ]));
  const asked = [];
  const told = [];
  const e = {
    DB,
    CHANNELS,
    asked,
    told,
    STAFF_DOMAINS: 'staff.example',
    ...(ai ? {
      AI: {
        async run(model, input) {
          asked.push(input);
          const q = input.questions || {};
          if (q.same) {
            return { answers: { same: { type: 'noul', noul: 0.8 } } };
          }
          const answers = {};
          for (const [k, v] of Object.entries(q)) {
            answers[k] = { type: 'noul', noul: /Globex/.test(v.instructions) ? 0.85 : 0.1 };
          }
          return { answers };
        },
      },
    } : {}),
    ...(content ? {
      CONTENT: {
        async getByIds(ids) {
          return ids.map((id) => ({ id, values: VECTORS[P1] }));
        },
        async query(vector, { filter }) {
          const orgs = [].concat(filter.org.$in || filter.org);
          const rows = sql.prepare('SELECT thread, org FROM threads').all();
          return {
            matches: rows.filter((r) => orgs.includes(r.org))
              .map((r) => ({
                id: r.thread, score: cos(vector, VECTORS[r.thread]), metadata: { thread: r.thread },
              })),
          };
        },
      },
    } : {}),
    AGENTS: {
      idFromName: (name) => name,
      get: (name) => ({
        // eslint-disable-next-line no-underscore-dangle
        __unsafe_ensureInitialized: async () => {},
        relatedUpdate: async (change) => {
          told.push({ name, ...change });
        },
      }),
    },
  };
  return e;
}

beforeEach(() => {
  forgetOwners();
  forgetPartnerDomains();
});

describe('which customer a partner\'s thread is about', () => {
  const customers = [{ slug: 'globex', name: 'Globex Corp' }, { slug: 'initech', name: 'Initech' }];
  const owners = new Map([['globex-web', new Set(['globex'])], ['shared', new Set(['globex', 'hooli'])],
    ['adobe', new Set(['globex', 'initech', 'hooli'])]]);

  it('is the customer whose own site owner its facts name, less surely one another org has', () => {
    const only = aboutScores({ customers, facts: [{ field: 'site', value: 'globex-web/site' }], owners });
    assert.equal(only.get('globex').facts, FACT_OWNER_ONLY);
    assert.equal(only.get('initech').facts, 0);
    const few = aboutScores({ customers, facts: [{ field: 'repo', value: 'shared/x' }], owners });
    assert.equal(few.get('globex').facts, FACT_OWNER_FEW);
    // Adobe's own and demo owners are in many customers' threads: they say nothing.
    const many = aboutScores({ customers, facts: [{ field: 'url', value: 'https://main--x--adobe.aem.live/' }], owners });
    assert.equal(many.get('globex').facts, 0);
  });

  it('reads a URL on the customer\'s domain, its name in the channel, the title and the text', () => {
    const s = aboutScores({
      customers: [{ slug: 'globex', name: 'Globex Corp', icon: 'globex.example' }, { slug: 'initech', name: 'Initech' }],
      facts: [{ field: 'url', value: 'https://www.globex.example/en/' }],
      channel: 'agency-initech',
      title: 'nothing',
      text: 'We deploy for Initech tomorrow.',
    });
    assert.ok(s.get('globex').facts > 0);
    assert.ok(s.get('initech').channel > 0);
    assert.ok(s.get('initech').text > 0);
    // A one-word slug alone is no name in the text (it is often a word of its own).
    const word = aboutScores({ customers: [{ slug: 'apex', name: null }], text: 'the apex of it' });
    assert.equal(word.get('apex').text, 0);
  });

  it('takes Clef\'s word for the text\'s, keeps the facts beside it, and says what said so', () => {
    const scores = new Map([
      ['globex', { facts: 0.9, channel: 0, text: 0 }],
      ['initech', { facts: 0, channel: 0, text: 0.6 }],
    ]);
    assert.deepEqual(aboutOf(scores).map((a) => [a.org, a.via]), [['globex', 'facts'], ['initech', 'text']]);
    // Clef says no to Initech: the name in its text no longer counts.
    const clef = new Map([['globex', 0.7], ['initech', 0.1]]);
    const out = aboutOf(scores, clef);
    assert.deepEqual(out.map((a) => a.org), ['globex']);
    assert.equal(out[0].via, 'facts,clef');
    assert.ok(out[0].p > 0.9 && out[0].p < 1);
    assert.ok(out.every((a) => a.p >= ABOUT_MIN));
  });

  it('takes Clef alone only where it says much more of one customer than of the others', () => {
    const none = { facts: 0, channel: 0, text: 0 };
    const scores = new Map([['globex', none], ['initech', none], ['hooli', none]]);
    assert.deepEqual(aboutOf(scores, new Map([['globex', 0.52], ['initech', 0.45], ['hooli', 0.37]])), []);
    assert.deepEqual(aboutOf(scores, new Map([['globex', 0.6], ['initech', 0.3]])).map((a) => a.org), ['globex']);
    // A fact beside it needs no margin.
    const facts = new Map([['globex', { ...none, facts: 0.75 }], ['initech', none]]);
    assert.deepEqual(aboutOf(facts, new Map([['globex', 0.5], ['initech', 0.45]])).map((a) => a.org), ['globex']);
  });
});

describe('the link job', () => {
  it('files a partner\'s thread under the customer it is about and links the same issue there', async () => {
    const e = env();
    const r = await linkThread(e, P1);
    assert.equal(r.result, 'linked');
    assert.equal(r.role, 'about');
    const about = e.DB.sqlite.prepare('SELECT org, role, p, via FROM thread_orgs WHERE thread = ?').all(P1);
    assert.deepEqual(about.map((x) => x.org), ['globex']);
    assert.match(about[0].via, /facts/);
    assert.match(about[0].via, /clef/);
    // Only its customers are asked about, and the question names each.
    const { questions } = e.asked.find((x) => x.questions && x.questions.about_0);
    assert.equal(Object.keys(questions).length, 2);
    // G1 is alike and recent; G2 is neither, I1 is another customer's.
    const links = e.DB.sqlite.prepare('SELECT a, b, score, p FROM thread_links').all();
    assert.equal(links.length, 1);
    assert.deepEqual([links[0].a, links[0].b].sort(), [G1, P1].sort());
    assert.equal(links[0].p, 0.8);
    // Both agents hear of the link, and the partner's of its customer.
    assert.deepEqual(
      e.told.map((t) => `${t.name}:${t.kind}`).sort(),
      [`${G1}:related`, `${P1}:about`, `${P1}:related`].sort(),
    );
    // Asked again, nothing is new: Clef is not asked about the link again, nobody is told.
    const before = e.asked.length;
    e.told.length = 0;
    await linkThread(e, P1);
    assert.equal(e.asked.slice(before).filter((x) => x.questions && x.questions.same).length, 0);
    assert.ok(e.asked.length > before);
    assert.deepEqual(e.told, []);
  });

  it('records the partners whose people post in a customer\'s thread', async () => {
    const e = env();
    const r = await linkThread(e, G1);
    assert.equal(r.role, 'partner');
    assert.deepEqual(e.DB.sqlite.prepare('SELECT org, role, p, via FROM thread_orgs WHERE thread = ?').all(G1)
      .map((x) => ({ ...x })), [{
      org: 'agency', role: 'partner', p: 1, via: 'posters',
    }]);
  });

  it('shows a link whose threads name the same owner few customers have, whatever Clef says', () => {
    assert.equal(shownLink({ score: 0.8, p: 0.1, owner: 1 }), true);
    assert.equal(shownLink({ score: 0.8, p: 0.1, owner: 0 }), false);
    assert.equal(shownLink({
      score: 0.8, p: 0.1, owner: 1, dismissed_at: AT,
    }), false);
  });

  it('marks a link whose two threads name the customer\'s own site owner', async () => {
    const e = env({ ai: false });
    await linkThread(e, P1);
    const [link] = e.DB.sqlite.prepare('SELECT owner FROM thread_links').all();
    assert.equal(link.owner, 1);
    assert.ok((await entryLinks(e, [P1], async () => true)).related[0].via.includes('owner'));
  });

  it('keeps a link without Clef only where the vectors are alike enough', async () => {
    const e = env({ ai: false });
    await linkThread(e, P1);
    const [link] = e.DB.sqlite.prepare('SELECT score, p FROM thread_links').all();
    assert.equal(link.p, null);
    assert.equal(shownLink(link), link.score >= RELATED_SURE);
  });

  it('skips the threads of orgs that are neither a partner nor a customer', async () => {
    const e = env();
    e.DB.sqlite.exec("UPDATE orgs SET type = 'vendor' WHERE slug = 'initech'");
    assert.deepEqual(await linkThread(e, I1), { result: 'skip', reason: 'vendor' });
  });

  it('leaves a dismissed customer off the thread when it is found again', async () => {
    const e = env();
    await linkThread(e, P1);
    const res = await dismissAbout(e, ADA, { thread: P1, org: 'globex' });
    assert.equal(res.ok, true);
    await linkThread(e, P1);
    assert.equal((await linkedOrgsOf(e, [P1])).size, 0);
    assert.equal((await dismissAbout(e, ADA, { thread: P1, org: 'globex', undo: true })).dismissed, false);
    assert.deepEqual((await linkedOrgsOf(e, [P1])).get(P1).about.map((o) => o.slug), ['globex']);
  });
});

describe('a public thread', () => {
  const PUB = 'slack:E1:CC:4.1';
  /**
   * The community's channel (an org of type `public`): Lee of the agency, Gus of Globex (whose
   * people write from globex.example in its own channel too), and Max of free mail post there.
   */
  function world() {
    const e = env();
    const sql = e.DB.sqlite;
    sql.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('community', 'Public', 'public', '${AT}')`);
    sql.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        channel_name, title, path, root_at, last_at, any_at, messages, updated_at, embedded)
      VALUES (?, 'slack', 'E1', 'CC', '4.1', 'community', 'helix', 'channel', 'aem-community',
        'How do I preview?', 'channels/community/helix/slack-CC/4.1/', ?, ?, ?, 3, ?, 'h')`)
      .run(PUB, AT, AT, AT, AT);
    const person = (id, name, email) => sql.prepare(`INSERT INTO identities (source, tenant, user_id,
        kind, name, email, fetched_at) VALUES ('slack', 'E1', ?, 'person', ?, ?, ?)`).run(id, name, email, AT);
    person('U5', 'Gus', 'gus@globex.example');
    person('U6', 'Max', 'max@gmail.com');
    const post = (thread, channel, id, user) => sql.prepare(`INSERT INTO messages (source, tenant,
        channel_id, id, thread, at, staff, counted, author_key) VALUES ('slack', 'E1', ?, ?, ?, ?, 0, 1, ?)`)
      .run(channel, id, thread, AT, `slack:E1:${user}`);
    post(G2, 'CG', '2.6', 'U5');
    post(G1, 'CG', '2.7', 'U5');
    post(PUB, 'CC', '4.1', 'U9');
    post(PUB, 'CC', '4.2', 'U5');
    post(PUB, 'CC', '4.3', 'U6');
    return e;
  }

  it('is linked with the customers and partners whose people post in it, and nothing else', async () => {
    const e = world();
    const r = await linkThread(e, PUB);
    assert.equal(r.result, 'linked');
    assert.equal(r.customers, 1);
    assert.deepEqual(e.DB.sqlite.prepare('SELECT org, role, p, via FROM thread_orgs WHERE thread = ? ORDER BY role')
      .all(PUB).map((x) => ({ ...x })), [
      {
        org: 'globex', role: 'customer', p: 1, via: 'posters',
      },
      {
        org: 'agency', role: 'partner', p: 1, via: 'posters',
      },
    ]);
    // No thread is related to it, and no agent is told: a public thread is no customer's own.
    assert.deepEqual(e.DB.sqlite.prepare('SELECT * FROM thread_links').all(), []);
    assert.deepEqual(e.told, []);
    const linked = (await linkedOrgsOf(e, [PUB])).get(PUB);
    assert.deepEqual(linked.about, []);
    assert.deepEqual(linked.with.map((o) => [o.slug, o.role]), [['agency', 'partner'], ['globex', 'customer']]);
    // The customer's filter takes it in; a dismissed customer is off it.
    assert.ok((await aboutThreads(e, 'globex', [PUB, G1])).has(PUB));
    assert.equal((await dismissAbout(e, ADA, { thread: PUB, org: 'globex', role: 'customer' })).ok, true);
    assert.equal((await aboutThreads(e, 'globex', [PUB])).has(PUB), false);
  });

  it('lets its customers go once its org is no longer public, and clears them when linked again', async () => {
    const e = world();
    await linkThread(e, PUB);
    e.DB.sqlite.exec("UPDATE orgs SET type = 'customer' WHERE slug = 'community'");
    // At once, before any job: the customer's filter and the thread's links leave it.
    assert.equal((await aboutThreads(e, 'globex', [PUB])).has(PUB), false);
    assert.deepEqual((await linkedOrgsOf(e, [PUB])).get(PUB).with.map((o) => o.role), ['partner']);
    // Linked again as a customer's: its rows of role customer go, its partners stay.
    await linkThread(e, PUB);
    assert.deepEqual(e.DB.sqlite.prepare('SELECT role FROM thread_orgs WHERE thread = ?').all(PUB)
      .map((x) => x.role), ['partner']);
    // An org of a type of no links (a vendor) keeps none.
    e.DB.sqlite.exec("UPDATE orgs SET type = 'vendor' WHERE slug = 'community'");
    assert.equal((await linkThread(e, PUB)).result, 'skip');
    assert.deepEqual(e.DB.sqlite.prepare('SELECT role FROM thread_orgs WHERE thread = ?').all(PUB), []);
  });

  it('tells the agent whose people they are, and not to say so in the channel', async () => {
    const e = world();
    await linkThread(e, PUB);
    const note = await relatedNote(e, {
      key: PUB, threads: [PUB], org: 'community', orgType: 'public', team: 'helix', channelId: 'CC', kind: 'channel', source: 'slack',
    });
    assert.match(note, /People of the customer Globex Corp \(globex\) post in this public thread/);
    assert.match(note, /never say in the channel whose people they are/);
    assert.match(note, /People of the partner Agency Co/);
  });
});

describe('what the inbox shows of the links', () => {
  it('names a linked thread only to who may see it, and a dismissed link to nobody', async () => {
    const e = env();
    await linkThread(e, P1);
    const seen = await entryLinks(e, [P1], async () => true);
    assert.deepEqual(seen.about.map((o) => o.slug), ['globex']);
    assert.equal(seen.related[0].thread, G1);
    assert.equal(seen.related[0].title, 'Preview serves stale code');
    const unseen = await entryLinks(e, [P1], async () => false);
    assert.equal(unseen.related[0].can_see, false);
    assert.equal(unseen.related[0].title, undefined);
    assert.equal(unseen.related[0].permalink, undefined);
    // From the other side too.
    assert.equal((await entryLinks(e, [G1], async () => true)).related[0].thread, P1);
    await dismissLink(e, ADA, { thread: G1, other: P1 });
    assert.deepEqual((await entryLinks(e, [P1], async () => true)).related, []);
  });

  it('takes a partner\'s thread about a customer into the customer\'s filter', async () => {
    const e = env();
    await linkThread(e, P1);
    assert.deepEqual([...await aboutThreads(e, 'globex', [P1, G1, G2, I1])].sort(), [G1, G2, P1].sort());
    assert.deepEqual([...await aboutThreads(e, 'initech', [P1, G1, I1])], [I1]);
  });

  it('sends them with the thread and the inbox, and dismisses for who may work the thread', async () => {
    const e = env();
    await linkThread(e, P1);
    await linkThread(e, G1);
    const call = async (me, path, init) => {
      const url = new URL(`https://x${path}`);
      const res = await api(new Request(url, init), e, url, { viewer: asMe(me) });
      return { status: res.status, body: await res.json() };
    };
    const open = await call(ADA, `/api/thread?thread=${encodeURIComponent(P1)}`);
    assert.equal(open.status, 200);
    assert.deepEqual(open.body.linked.about.map((o) => o.slug), ['globex']);
    // Ada is on Helix: Globex's thread is Edge's, so she sees that there is one, not its words.
    assert.equal(open.body.related[0].thread, G1);
    assert.equal(open.body.related[0].can_see, false);
    assert.equal(open.body.related[0].title, undefined);
    const list = await call(ADA, '/api/inbox?team=helix');
    assert.deepEqual(list.body.threads.find((t) => t.thread === P1).linked.about.map((o) => o.slug), ['globex']);
    const edge = await call(BO, '/api/inbox?team=edge');
    assert.deepEqual(edge.body.threads.find((t) => t.thread === G1).linked.with.map((o) => o.slug), ['agency']);
    // Bo works Globex's thread, not the agency's.
    const post = (me, path, body) => call(me, path, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post(BO, '/api/thread/about/dismiss', { thread: P1, org: 'globex' })).status, 404);
    const no = await post(BO, '/api/thread/related/dismiss', { thread: G1, other: P1 });
    assert.equal(no.status, 200);
    assert.equal(no.body.dismissed, true);
    const again = await call(ADA, `/api/thread?thread=${encodeURIComponent(P1)}`);
    assert.deepEqual(again.body.related, []);
  });
});

describe('what the thread agent is told', () => {
  const target = (key, org, orgType, extra = {}) => ({
    key, threads: [key], org, orgType, team: 'helix', channelId: 'CP', kind: 'channel', source: 'slack', ...extra,
  });

  it('counts a linked thread it may not read, and names one it may', async () => {
    const e = env();
    await linkThread(e, P1);
    const note = await relatedNote(e, target(P1, 'agency', 'partner'));
    assert.match(note, /about the customer Globex Corp \(globex\)/);
    assert.match(note, /1 more in channels you may not read/);
    assert.doesNotMatch(note, /Preview serves stale code/);
    assert.match(note, /never post what it says in this channel/);
  });

  it('puts the note after the messages of its first input', () => {
    const entry = { messages: [] };
    const text = deliveryText(entry, [], new Map(), { first: true, related: 'Possibly the same issue: …' });
    assert.match(text, /\n\nPossibly the same issue: …$/);
    assert.doesNotMatch(deliveryText(entry, [], new Map(), { first: false }), /Possibly/);
  });

  it('finds the linked orgs\' threads by meaning, and says when there are none', async () => {
    const e = env();
    await linkThread(e, P1);
    const out = await relatedThreads(e, target(P1, 'agency', 'partner'));
    assert.match(out, /Linked organizations: 1\./);
    assert.match(out, /more in channels you may not read/);
    const none = await relatedThreads(e, target(I1, 'umbrella', 'customer', { channelId: 'CI' }));
    assert.match(none, /no partner of this customer/);
    const vendor = await relatedThreads(e, target(I1, 'initech', 'vendor', { channelId: 'CI' }));
    assert.match(vendor, /neither/);
  });
});
