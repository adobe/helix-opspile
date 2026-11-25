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
import { opspileExtension } from '../src/agent/tools.js';
import { answered, answerNote } from '../src/agent/question.js';
import { requestKey } from '../src/requestkeys.js';
import { cleanItems, DEADLINE_MS } from '../src/questions.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const LEE = {
  id: 2, email: 'lee@staff.example', name: 'Lee Lead', staff: 1, teams: ['helix'],
};
const RAY = {
  id: 3, email: 'ray@staff.example', name: 'Ray Expert', staff: 1, teams: ['helix'],
};
const EVE = {
  id: 4, email: 'eve@staff.example', name: 'Eve Elsewhere', staff: 1, teams: ['edge'],
};
const KEY = 'teams:T1:G1:19:c1@thread.tacv2:1700000000000';
const SIDEBAR = 'sb_00000000-0000-4000-8000-000000000001';
const AT = '2026-11-25T10:00:00Z';
const TARGET = {
  key: KEY, team: 'helix', org: 'acme', kind: 'channel', source: 'teams', tenant: 'T1', channelId: '19:c1@thread.tacv2', threads: [KEY],
};
const RUNBOOK = {
  email: RAY.email,
  purpose: 'runbook',
  why: 'You raised the SVG limit for acme in this thread; kb-team has no runbook for it.',
  questions: [
    { text: 'How did you set it?', guess: 'POST the site config', choices: ['the org config', 'a staff tool'] },
    { text: 'Site or whole org?', guess: 'whole org', choices: ['site only'] },
    { text: 'How is it undone?' },
  ],
};

function env() {
  const DB = d1({
    people: [ADA, LEE, RAY, EVE],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    kind, channel_name, path, title, root_at, last_at, any_at, messages, updated_at) VALUES (?,
    'teams', 'T1', '19:c1@thread.tacv2', '1700000000000', 'acme', 'helix', 'channel', 'Main',
    'p/1/', 'SVG file size limit', ?, ?, ?, 1, ?)`).run(KEY, AT, AT, AT, AT);
  DB.sqlite.prepare(`INSERT INTO sidebar_messages (id, thread, role, person, body, at)
    VALUES (?, ?, 'person', 2, 'Do we have a runbook for that?', ?)`).run(SIDEBAR, KEY, AT);
  const notified = [];
  const told = [];
  const reads = [];
  return {
    DB,
    notified,
    told,
    reads,
    STAFF_DOMAINS: 'staff.example',
    ROOMS: {
      idFromName: (n) => n,
      get: (team) => ({
        fetch: async (u, init) => {
          (u.endsWith('/read') ? reads : notified).push({ team, ...JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }),
    },
    AGENTS: {
      idFromName: (n) => n,
      get: (name) => ({
        __unsafe_ensureInitialized: async () => {},
        answered: async (note) => {
          told.push({ name, ...note });
          return { ok: true };
        },
      }),
    },
  };
}

/** The agent's tools, answering sidebar message `sidebar` (null: a turn on the messages). */
function agentTools(e, sidebar = null) {
  const tools = Object.fromEntries(opspileExtension({
    env: e,
    hasThread: true,
    target: async () => TARGET,
    verdicts: async () => new Map(),
    sidebarMessage: async () => sidebar,
  }).tools.map((t) => [t.name, t]));
  return async (name, args = {}) => {
    const res = await quiet(() => tools[name].execute(args, {}));
    return { text: res.output.map((o) => o.text).join(''), error: Boolean(res.isError) };
  };
}

async function as(person, e, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const viewer = { ...person, teams: person.teams.map((slug) => ({ slug, role: 'member' })) };
  const res = await quiet(() => api(request, e, url, { viewer }));
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/** The agent asks Ray, while it answers Lee in the sidebar; the question's key. */
async function asked(e) {
  const res = await agentTools(e, SIDEBAR)('ask_teammate', RUNBOOK);
  assert.equal(res.error, false, res.text);
  const [{ id }] = e.DB.rows('SELECT id FROM questions');
  return requestKey('question', id);
}

describe('agent: ask_teammate', () => {
  it('asks a colleague on the thread\'s teams, and tells the inboxes that have the thread', async () => {
    const e = env();
    const res = await agentTools(e, SIDEBAR)('ask_teammate', RUNBOOK);
    assert.equal(res.error, false);
    assert.match(res.text, /^asked \(question [0-9a-f]{12}\) Ray Expert: 3 questions, in their inbox until 2\d{3}-\d\d-\d\d\. You are told when they answer/);
    const [q] = e.DB.rows('SELECT thread, team, title, email, name, purpose, status, sidebar, items FROM questions');
    assert.deepEqual({ ...q, items: JSON.parse(q.items) }, {
      thread: KEY,
      team: 'helix',
      title: 'SVG file size limit',
      email: RAY.email,
      name: 'Ray Expert',
      purpose: 'runbook',
      status: 'open',
      sidebar: SIDEBAR,
      items: [
        { text: 'How did you set it?', guess: 'POST the site config', choices: ['POST the site config', 'the org config', 'a staff tool'] },
        { text: 'Site or whole org?', guess: 'whole org', choices: ['whole org', 'site only'] },
        { text: 'How is it undone?' },
      ],
    });
    // The admin team's room, as for every request, and the thread's team's, where Ray listens.
    assert.deepEqual(e.notified.map((n) => [n.team, n.type]), [['admin', 'request'], ['helix', 'request']]);
  });

  it('asks only colleagues who can open the thread, never the one it is answering, once at a time', async () => {
    const e = env();
    const run = agentTools(e, SIDEBAR);
    const nobody = async (args, why) => {
      const res = await run('ask_teammate', { ...RUNBOOK, ...args });
      assert.equal(res.error, true);
      assert.match(res.text, why);
    };
    await nobody({ email: 'pat@customer.example' }, /not a staff address: only colleagues are asked, never customers/);
    await nobody({ email: EVE.email }, /Eve Elsewhere|eve@staff\.example/);
    await nobody({ email: EVE.email }, /on none of the teams whose inbox has this thread \(helix\).*suggest_expert/);
    await nobody({ email: LEE.email }, /is the person you are answering: ask them in your answer/);
    await nobody({ email: undefined }, /Say whom to ask/);
    await nobody({ purpose: 'gossip' }, /Say what the answer is for: runbook, reply, fact/);
    await nobody({ why: '' }, /Say why you ask/);
    await nobody({ questions: [] }, /ask one to 3 questions at a time/);
    await nobody({ questions: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }, /ask one to 3 questions/);
    assert.equal(e.DB.rows('SELECT * FROM questions').length, 0);
    // By the name the inbox knows, in a turn on the thread's messages too.
    const byName = await agentTools(e)('ask_teammate', { ...RUNBOOK, email: undefined, name: 'ray expert' });
    assert.equal(byName.error, false, byName.text);
    await nobody({}, /question [0-9a-f]{12} waits for/);
    // Lee may be asked outside the sidebar: a second question of the thread, the last one.
    assert.equal((await agentTools(e)('ask_teammate', { ...RUNBOOK, email: LEE.email })).error, false);
    e.DB.sqlite.exec(`INSERT INTO people (id, email, name, staff) VALUES (5, 'sam@staff.example', 'Sam', 1);
      INSERT INTO team_members (team, person) VALUES ('helix', 5)`);
    await nobody({ email: 'sam@staff.example' }, /2 of your questions wait for an answer already/);
  });

  it('cleans the questions: the guess among the choices, first, and at most four', () => {
    assert.deepEqual(cleanItems([{ text: ' Q ', guess: 'b', choices: ['a', 'b', ' '] }]), { items: [{ text: 'Q', guess: 'b', choices: ['b', 'a'] }] });
    assert.match(cleanItems([{ text: 'Q', guess: 'e', choices: ['a', 'b', 'c', 'd'] }]).error, /at most 4 choices/);
    assert.match(cleanItems([{ guess: 'x' }]).error, /needs its text/);
  });
});

describe('questions as threads of the inbox of whom they ask', () => {
  it('are Ray\'s entries, filed under the thread\'s team, and nobody else\'s', async () => {
    const e = env();
    const key = await asked(e);
    const mine = await as(RAY, e, 'GET', '/api/requests?mine=1');
    assert.equal(mine.status, 200);
    const [t] = mine.body.threads;
    assert.equal(t.thread, key);
    assert.equal(t.title, 'Question on SVG file size limit');
    assert.equal(t.team, 'helix');
    assert.equal(t.org_name, 'Questions for you');
    assert.equal(t.waiting_on, 'us');
    assert.equal(t.unread, true);
    assert.deepEqual(t.request, { kind: 'question', status: 'asked', open: true });
    assert.deepEqual(t.participants.map((p) => p.name), ['Thread agent']);
    // The agent's purple badge, as for its answers in a sidebar, until he answers; no mention.
    assert.deepEqual([t.sideNew, t.mentionedMe], [[key], false]);
    // Lee, who asked in the sidebar, Eve, and the admin team see none of it.
    const path = `/api/thread?thread=${encodeURIComponent(key)}`;
    const others = await Promise.all([LEE, EVE].map(async (who) => [
      (await as(who, e, 'GET', '/api/requests')).body.threads, (await as(who, e, 'GET', path)).status,
    ]));
    assert.deepEqual(others, [[[], 404], [[], 404]]);
    const admins = await as(ADA, e, 'GET', '/api/requests');
    assert.equal(admins.body.threads.some((x) => x.thread === key), false);
    // The number on Inbox.
    assert.deepEqual((await as(RAY, e, 'GET', '/api/me')).body.questions, { open: 1, team: 'helix' });
    assert.deepEqual((await as(LEE, e, 'GET', '/api/me')).body.questions, { open: 0, team: null });
  });

  it('leave the admin team\'s tracked requests alone, and show none of them, to anyone else', async () => {
    const e = env();
    await asked(e);
    // A conflict the admin team's inbox found waiting, and one it found gone.
    e.DB.sqlite.exec(`INSERT INTO request_threads (request, title, opened_at, closed_at) VALUES
      ('request:rule:rule:1|rule:2', 'Helix ops and Edge ops: rules overlap', '${AT}', NULL),
      ('request:tech:name:x', 'Secret conflict', '${AT}', '${AT}')`);
    const before = e.DB.rows('SELECT request, closed_at FROM request_threads ORDER BY request');
    for (const path of ['/api/requests', '/api/requests?mine=1']) {
      // eslint-disable-next-line no-await-in-loop
      const { body } = await as(RAY, e, 'GET', path);
      assert.deepEqual(body.threads.map((t) => t.request.kind), ['question']);
    }
    // An admin's personal listing too.
    const mine = await as(ADA, e, 'GET', '/api/requests?mine=1');
    assert.deepEqual(mine.body.threads, []);
    assert.deepEqual(e.DB.rows('SELECT request, closed_at FROM request_threads ORDER BY request'), before);
  });

  it('are filed in the inbox of a team of whom they ask, when the thread is only shared with it', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('teams', '19:c1@thread.tacv2', 'edge', '${AT}')`);
    const res = await agentTools(e)('ask_teammate', { ...RUNBOOK, email: EVE.email });
    assert.equal(res.error, false, res.text);
    assert.deepEqual(e.DB.rows('SELECT team FROM questions').map((r) => r.team), ['edge']);
    assert.deepEqual(e.notified.map((n) => n.team), ['admin', 'edge']);
    const [t] = (await as(EVE, e, 'GET', '/api/requests?mine=1')).body.threads;
    assert.equal(t.team, 'edge');
  });

  it('show the question with the agent\'s guesses, and a form that confirms them', async () => {
    const e = env();
    const key = await asked(e);
    const { status, body } = await as(RAY, e, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`);
    assert.equal(status, 200);
    assert.equal(body.messages[0].author.name, 'Thread agent');
    assert.match(body.messages[0].body, /^The thread's agent asks you, for a runbook it is writing:\n\n> You raised the SVG limit/);
    assert.match(body.messages[0].body, /1\. \*\*How did you set it\?\*\*\n {3}My guess: POST the site config/);
    assert.match(body.messages[0].body, /Asked while it answered Lee Lead in the thread's sidebar/);
    assert.match(body.messages[0].body, /\[SVG file size limit\]\(\/inbox\?team=helix&t=teams%3AT1/);
    assert.equal(body.request.kindName, 'Questions for you');
    assert.deepEqual(body.request.actions.map((a) => a.id), ['answer', 'pass', 'unknown']);
    const [answer] = body.request.actions;
    assert.equal(answer.act, undefined);
    assert.deepEqual(answer.fields.map((f) => [f.name, f.type]), [
      ['pick0', 'select'], ['text0', 'textarea'], ['pick1', 'select'], ['text1', 'textarea'], ['text2', 'textarea'], ['note', 'textarea'],
    ]);
    assert.equal(answer.fields[0].value, 'POST the site config');
    assert.deepEqual(answer.fields[0].options.map((o) => o.label), [
      'POST the site config (the agent\'s guess)', 'the org config', 'a staff tool', 'Something else: say it below',
    ]);
    // Read in the room of the thread's team, where Ray's inbox has it.
    const read = await as(RAY, e, 'POST', '/api/read', { thread: key, at: AT });
    assert.equal(read.status, 204);
    assert.deepEqual(e.reads.map((r) => [r.team, r.person]), [['helix', RAY.id]]);
    // Read (as the room writes it), it is not unread, nor a mention, any more.
    const now = new Date().toISOString();
    e.DB.sqlite.prepare(`INSERT INTO watermarks (person, thread, read_at, via, updated_at)
      VALUES (?, ?, ?, 'open', ?)`).run(RAY.id, key, now, now);
    const [seen] = (await as(RAY, e, 'GET', '/api/requests?mine=1')).body.threads;
    assert.deepEqual([seen.unread, seen.sideNew], [false, [key]]);
    assert.equal((await as(LEE, e, 'POST', '/api/read', { thread: key, at: AT })).status, 404);
  });

  it('answered, tell the agent as an input of its own, once', async () => {
    const e = env();
    const key = await asked(e);
    assert.equal((await as(LEE, e, 'POST', '/api/requests/resolve', { key, action: 'answer', values: { pick0: 'the org config' } })).status, 404);
    const empty = await as(RAY, e, 'POST', '/api/requests/resolve', { key, action: 'answer', values: { pick0: '', pick1: '' } });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /answer at least one/);
    const res = await as(RAY, e, 'POST', '/api/requests/resolve', {
      key,
      action: 'answer',
      values: {
        pick0: 'the org config', pick1: 'whole org', text2: 'Delete the key again.', note: 'GET it first: the POST replaces it.',
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.done, 'Sent to the agent. The agent goes on with it.');
    assert.equal(res.body.thread.request.open, false);
    assert.equal(res.body.thread.request.status, 'answered');
    assert.deepEqual(res.body.thread.request.actions, []);
    // What Ray answered is his reply in the thread.
    const [, said] = res.body.thread.messages;
    assert.deepEqual([said.author.name, said.mine], ['Ray Expert', true]);
    assert.match(said.body, /^\*\*Answered\*\*\n\n1\. How did you set it\? \*\*the org config\*\*\n2\. Site or whole org\? \*\*whole org\*\*\n3\. How is it undone\? Delete the key again\./);
    const [told] = e.told;
    assert.equal(told.name, KEY);
    assert.match(told.text, /^Ray Expert \(Adobe staff, on the team\) answered your question [0-9a-f]{12}, asked for a runbook\. It is trusted\./);
    assert.match(told.text, /1\. How did you set it\?\n {3}→ the org config \(not your guess, POST the site config\)/);
    assert.match(told.text, /2\. Site or whole org\?\n {3}→ whole org \(your guess\)/);
    assert.match(told.text, /3\. How is it undone\?\n {3}→ Delete the key again\./);
    assert.match(told.text, /They added: GET it first/);
    assert.match(told.text, /Write the runbook now \(kb-team, `runbooks\/`\).*author: human:Ray Expert/);
    assert.match(told.text, new RegExp(`tell them what came of it with sidebar_followup \\(message ${SIDEBAR}\\)`));
    assert.ok(e.DB.rows('SELECT told_at FROM questions')[0].told_at);
    // Of two answers, one.
    const again = await as(RAY, e, 'POST', '/api/requests/resolve', { key, action: 'answer', values: { pick0: 'a staff tool' } });
    assert.equal(again.status, 409);
    assert.equal(e.told.length, 1);
    assert.deepEqual((await as(RAY, e, 'GET', '/api/me')).body.questions, { open: 0, team: null });
    const [done] = (await as(RAY, e, 'GET', '/api/requests?mine=1')).body.threads;
    assert.deepEqual([done.resolution.verdict, done.sideNew], ['resolved', undefined]);
  });

  it('passed on or not known, tell the agent so; read-only, nothing is decided', async () => {
    const e = env();
    const key = await asked(e);
    const viewing = { ...RAY, readonly: true };
    assert.equal((await as(viewing, e, 'POST', '/api/requests/resolve', { key, action: 'unknown' })).status, 403);
    assert.equal((await as(RAY, e, 'POST', '/api/requests/resolve', { key, action: 'pass', values: {} })).status, 400);
    const passed = await as(RAY, e, 'POST', '/api/requests/resolve', { key, action: 'pass', values: { who: 'Sam on edge', note: 'Sam wrote the tool' } });
    assert.equal(passed.status, 200);
    assert.equal(passed.body.thread.request.status, 'passed');
    assert.match(e.told[0].text, /does not know the answer to your question [0-9a-f]{12} and says to ask Sam on edge\.\n\nThey added: Sam wrote the tool\n\nAsk the person they named with ask_teammate/);
    const q = {
      id: 'abc', status: 'unknown', note: null, sidebar: null, purpose: 'fact', items: [],
    };
    assert.match(answerNote(q, 'Ray'), /^Ray \(Adobe staff, on the team\) does not know the answer to your question abc\.\n\nDo not ask them about it again\./);
    assert.match(answerNote({
      ...q, status: 'answered', purpose: 'reply', items: [{ text: 'Q?' }], answers: [],
    }, 'Ray'), /1\. Q\?\n {3}→ no answer to this one\n\nUpdate the draft with it/);
  });

  it('expire unanswered after three days, and make room for the agent to ask again', async () => {
    const e = env();
    const key = await asked(e);
    const past = new Date(Date.now() - DEADLINE_MS - 1000).toISOString();
    e.DB.sqlite.prepare('UPDATE questions SET asked_at = ?, deadline = ?').run(past, new Date(Date.now() - 1000).toISOString());
    const { body } = await as(RAY, e, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`);
    assert.equal(body.request.status, 'expired');
    assert.deepEqual(body.request.actions, []);
    assert.match(body.messages.find((m) => m.author.kind === 'system').body, /\*\*Expired\*\*: nobody answered it in time/);
    assert.equal((await as(RAY, e, 'POST', '/api/requests/resolve', { key, action: 'answer', values: { pick0: 'the org config' } })).status, 409);
    assert.deepEqual((await as(RAY, e, 'GET', '/api/me')).body.questions, { open: 0, team: null });
    const again = await agentTools(e)('ask_teammate', RUNBOOK);
    assert.equal(again.error, false, again.text);
    assert.deepEqual(e.DB.rows('SELECT status FROM questions ORDER BY asked_at').map((r) => r.status), ['expired', 'open']);
  });

  it('do not reach an agent that is not there, and say so', async () => {
    const e = env();
    const key = await asked(e);
    delete e.AGENTS;
    const res = await as(RAY, e, 'POST', '/api/requests/resolve', { key, action: 'unknown', values: {} });
    assert.equal(res.status, 200);
    assert.match(res.body.done, /The agent was not told \(agents are not configured\): tell it in the thread's sidebar\./);
    assert.equal(e.DB.rows('SELECT told_at FROM questions')[0].told_at, null);
  });
});

describe('ThreadAgent.answered', () => {
  it('submits the answer as an input of its own, once per question', async () => {
    const submitted = [];
    const agent = {
      env: { AGENT_BASE_URL: 'https://model.example', AGENT_MODEL: 'x', BEDROCK_API_KEY: 'k' },
      harness: {
        submit: async (text, options) => {
          submitted.push([text, options]);
          return { accepted: true };
        },
      },
    };
    const res = await answered(agent, { id: 'abc', text: 'Ray answered' });
    assert.deepEqual(submitted, [['Ray answered', { operationId: 'question:abc', whenBusy: 'followUp' }]]);
    assert.equal(res.ok, true);
    // Without a model, nothing is submitted: the answer stays in the inbox, untold.
    assert.deepEqual(await answered({ env: {} }, { id: 'abc', text: 'x' }), { error: 'missing AI_GATEWAY_ACCOUNT, AGENT_GATEWAY, AGENT_MODEL, BEDROCK_API_KEY' });
  });
});
