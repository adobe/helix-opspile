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
  afterEach, beforeEach, describe, it,
} from 'node:test';
import {
  feedbackConfigured, leak, PER_THREAD, resetFeedbackCache, sweepFeedback,
} from '../src/agent/feedback.js';
import { opspileExtension } from '../src/agent/tools.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels, repositories and slugs only.
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo Builder', staff: 1, teams: ['helix'],
};
const KEY = 'slack:E1:C1:1.1';
const TARGET = {
  key: KEY, team: 'helix', org: 'acme', orgName: 'Acme Rockets', kind: 'channel', source: 'slack', tenant: 'E1', channelId: 'C1', channelName: 'shop-acme', threads: [KEY],
};
const REPO = 'example-owner/example-repo';

function env(vars = {}) {
  const DB = d1({ people: [BO], teams: [{ slug: 'helix', name: 'Helix ops' }] });
  DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author, counted)
      VALUES ('slack', 'E1', 'C1', '1.1', '${KEY}', '2026-10-22T00:00:00Z', 'Wile Coyote', 1),
        ('slack', 'E1', 'C1', '1.2', '${KEY}', '2026-10-22T00:01:00Z', 'Deploy Watcher', 0);
    INSERT INTO sidebar_messages (id, thread, role, person, body, at)
      VALUES ('sb_1', '${KEY}', 'person', 2, 'tell them the search is slow', '2026-10-22T01:00:00Z')`);
  return {
    DB,
    AGENT_MODEL: 'made-up-model',
    PUBLIC_ORIGIN: 'https://opspile.example',
    FEEDBACK_REPO: REPO,
    FEEDBACK_GITHUB_TOKEN: 'ghp-made-up',
    ...vars,
  };
}

function agentTools(e, sidebar = null) {
  const tools = Object.fromEntries(opspileExtension({
    env: e,
    hasThread: true,
    target: async () => TARGET,
    verdicts: async () => new Map(),
    sidebarMessage: async () => sidebar,
  }).tools.map((t) => [t.name, t]));
  const run = async (name, args = {}) => {
    const res = await tools[name].execute(args, {});
    return { text: res.output.map((o) => o.text).join(''), error: Boolean(res.isError) };
  };
  run.has = (name) => Boolean(tools[name]);
  return run;
}

const GOOD = {
  title: 'git_grep finds nothing in a mirrored repository',
  text: 'I searched a customer\'s repository for a function name the thread\'s first message quotes, and git_grep found nothing although git_read shows the file has it.',
  kind: 'bug',
  tool: 'git_grep',
};

describe('agent: send_feedback', () => {
  const realFetch = globalThis.fetch;
  let calls;
  let github;
  beforeEach(() => {
    resetFeedbackCache();
    calls = [];
    github = { private: false, down: false, issues: { 7: { state: 'open', labels: [{ name: 'agent-feedback' }] } } };
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({
        method, path: u.pathname, query: u.search, auth: init.headers.authorization, body,
      });
      if (github.down && method === 'POST') {
        return Response.json({ message: 'Service unavailable' }, { status: 503 });
      }
      const base = `/repos/${REPO}`;
      if (u.pathname === base) {
        return Response.json({ private: github.private });
      }
      if (u.pathname === `${base}/issues` && method === 'GET') {
        return Response.json([
          {
            number: 7, title: 'The search is slow', comments: 2, updated_at: '2026-10-21T10:00:00Z', labels: [{ name: 'agent-feedback' }],
          },
          { number: 8, title: 'A pull request', pull_request: {} },
        ]);
      }
      if (u.pathname === `${base}/issues` && method === 'POST') {
        return Response.json({ number: 12, html_url: `https://github.com/${REPO}/issues/12` }, { status: 201 });
      }
      const one = u.pathname.match(/\/issues\/(\d+)$/);
      if (one && method === 'GET') {
        const i = github.issues[one[1]];
        return i ? Response.json({ number: Number(one[1]), html_url: `https://github.com/${REPO}/issues/${one[1]}`, ...i })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      if (/\/issues\/\d+\/comments$/.test(u.pathname) && method === 'POST') {
        return Response.json({ html_url: `https://github.com/${REPO}/issues/7#issuecomment-1` }, { status: 201 });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('is there only where a repository and a token are set', () => {
    assert.equal(agentTools(env()).has('send_feedback'), true);
    assert.equal(agentTools(env({ FEEDBACK_GITHUB_TOKEN: '' })).has('send_feedback'), false);
    assert.equal(agentTools(env({ FEEDBACK_REPO: 'not a repo' })).has('send_feedback'), false);
    assert.equal(feedbackConfigured({}), false);
  });

  it('lists the open feedback issues without a title', async () => {
    const { text, error } = await agentTools(env())('send_feedback');
    assert.equal(error, false);
    assert.match(text, /^The open feedback issues/);
    assert.match(text, /- #7: The search is slow \(2 comments, updated 2026-10-21\)/);
    assert.doesNotMatch(text, /#8/);
    assert.equal(calls[0].query, '?state=open&labels=agent-feedback&sort=updated&per_page=30');
    assert.equal(calls[0].auth, 'Bearer ghp-made-up');
  });

  it('files an issue that says nothing of the case, and keeps the case in D1', async () => {
    const e = env();
    const res = await quiet(() => agentTools(e)('send_feedback', GOOD));
    assert.equal(res.error, false, res.text);
    assert.match(res.text, /^Sent \(feedback fb_[0-9a-f-]+\): filed as issue #12 \(https:\/\/github\.com\/example-owner\/example-repo\/issues\/12\)/);
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.path, `/repos/${REPO}/issues`);
    assert.equal(post.body.title, GOOD.title);
    assert.deepEqual(post.body.labels, ['agent-feedback']);
    assert.match(post.body.body, /^I searched a customer's repository/);
    assert.match(post.body.body, /- Kind: bug \(a tool failed or answered wrong\) · Tool: `git_grep`/);
    assert.match(post.body.body, /- From: the agent, on its own/);
    assert.match(post.body.body, /- Agent: opspile-agent\/made-up-model · Slack thread · \d{4}-\d\d-\d\d/);
    assert.match(post.body.body, /its thread is in `agent_feedback` in D1/);
    // A public repository: no link to the thread, no key, no channel.
    assert.doesNotMatch(post.body.body, /opspile\.example|slack:E1|\bC1\b|acme|helix/i);
    const [row] = e.DB.rows('SELECT * FROM agent_feedback');
    assert.equal(row.thread, KEY);
    assert.equal(row.team, 'helix');
    assert.equal(row.person, null);
    assert.equal(row.issue_number, 12);
    assert.ok(row.filed_at);
    assert.equal(row.attempts, 1);
  });

  it('links a private repository\'s issue to the thread, and says who asked in the sidebar', async () => {
    github.private = true;
    const e = env();
    const res = await quiet(() => agentTools(e, 'sb_1')('send_feedback', { ...GOOD, kind: 'idea', title: 'The search could be faster' }));
    assert.equal(res.error, false, res.text);
    const post = calls.find((c) => c.method === 'POST');
    assert.match(post.body.body, /\[the thread\]\(https:\/\/opspile\.example\/inbox\?t=slack%3AE1%3AC1%3A1\.1\)/);
    assert.match(post.body.body, /- From: a person on the team, through the agent's sidebar/);
    assert.equal(e.DB.rows('SELECT person FROM agent_feedback')[0].person, 2);
  });

  it('adds to an open feedback issue, and opens a new one for an issue that is not', async () => {
    const run = agentTools(env());
    const added = await quiet(() => run('send_feedback', { ...GOOD, issue: 7 }));
    assert.match(added.text, /added to issue #7 \(https:\/\/github\.com\/example-owner\/example-repo\/issues\/7#issuecomment-1\)/);
    const comment = calls.find((c) => c.method === 'POST');
    assert.equal(comment.path, `/repos/${REPO}/issues/7/comments`);
    assert.match(comment.body.body, /^\*\*git_grep finds nothing in a mirrored repository\*\*\n\nI searched/);
    github.issues[7].state = 'closed';
    calls = [];
    const opened = await quiet(() => run('send_feedback', { ...GOOD, issue: 7 }));
    assert.match(opened.text, /filed as issue #12/);
  });

  it('refuses what names the case', async () => {
    const run = agentTools(env(), 'sb_1');
    const tries = [
      [{ text: 'Acme Rockets has a site we could not read' }, /"Acme Rockets" \(a name from the case\)/],
      [{ text: 'the channel shop-acme has no members listed' }, /"shop-acme" \(a name from the case\)/],
      [{ text: 'Wile Coyote asked for it' }, /"Wile Coyote" \(a name from the case\)/],
      [{ text: 'Bo Builder asked for it' }, /"Bo Builder" \(a name from the case\)/],
      [{ text: 'mail someone@else.example about it' }, /an email address/],
      [{ text: 'see https://docs.example/page' }, /an address of a site/],
      [{ text: 'the user U0123ABCD9 could not be found' }, /a Slack id/],
      [{ title: 'read_thread fails on slack:E9:C9:2.2' }, /a thread key|\(a name from the case\)/],
      [{ text: 'Wile asked me to look' }, /"Wile" \(a name from the case\)/],
      [{ text: 'Builder said the search is slow' }, /"Builder" \(a name from the case\)/],
      [{ text: 'what the Rockets team set up' }, /"Rockets" \(a name from the case\)/],
      [{ text: 'their site customer-site.ai is down' }, /"customer-site\.ai" \(a host name\)/],
      [{ text: 'the page main--site--owner.aem.live fails' }, /"main--site--owner\.aem\.live" \(a host name\)/],
      [{ text: 'message 456789012345678901 could not be read' }, /a Discord id/],
      [{ text: 'message 1792584999.000900 could not be read' }, /a Slack message id/],
    ];
    for (const [args, why] of tries) {
      // eslint-disable-next-line no-await-in-loop
      const res = await run('send_feedback', { ...GOOD, ...args });
      assert.equal(res.error, true);
      assert.match(res.text, /^Nothing was sent: it has .+ in it\. Anyone may read the issue/);
      assert.match(res.text, why);
    }
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(leak('Adobe Experience Manager', ['adobe-internal']), null);
    // Files, the platforms' own hosts, a bot's name word by word and common words pass.
    const fine = 'stack.md and src/agent/tools.js, Node.js, api.github.com and aem.live; a Deploy'
      + ' step, the coyote in lower case, e.g. a will, and 1.2.3';
    assert.equal(leak(fine, { names: ['Deploy Watcher'], parts: ['Wile', 'Coyote', 'Will'] }), null);
  });

  it('refuses a bad kind, title or text, and more than three a thread a day', async () => {
    const run = agentTools(env());
    assert.match((await run('send_feedback', { ...GOOD, kind: 'rant' })).text, /kind is one of bug, missing, instructions, idea/);
    assert.match((await run('send_feedback', { ...GOOD, text: '' })).text, /a text of up to/);
    assert.match((await run('send_feedback', { ...GOOD, title: 'x'.repeat(200) })).text, /a title of up to 120/);
    for (let i = 0; i < PER_THREAD; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await quiet(() => run('send_feedback', GOOD))).error, false);
    }
    assert.match((await run('send_feedback', GOOD)).text, /this thread gave 3 pieces of feedback in the last day already/);
  });

  it('keeps what GitHub did not take, and the cron files it once', async () => {
    github.down = true;
    const e = env();
    const res = await quiet(() => agentTools(e)('send_feedback', GOOD));
    assert.equal(res.error, false);
    assert.match(res.text, /^Kept \(feedback fb_[^)]+\), but GitHub did not take it yet \(GitHub POST \/issues: 503 Service unavailable\): it is filed later/);
    const [kept] = e.DB.rows('SELECT * FROM agent_feedback');
    assert.equal(kept.filed_at, null);
    assert.match(kept.error, /503/);
    github.down = false;
    const now = Date.parse(kept.created_at);
    const none = { pending: 0, filed: 0, failed: 0 };
    // Too fresh: the turn that kept it may still be filing it.
    assert.deepEqual(await sweepFeedback(e, now + 60 * 1000), none);
    assert.deepEqual(await sweepFeedback(e, now + 600 * 1000), { ...none, pending: 1, filed: 1 });
    const [filed] = e.DB.rows('SELECT * FROM agent_feedback');
    assert.equal(filed.issue_number, 12);
    assert.equal(filed.attempts, 2);
    assert.equal(filed.error, null);
    assert.deepEqual(await sweepFeedback(e, now + 1200 * 1000), none);
    assert.deepEqual(await sweepFeedback({ DB: e.DB }), { skipped: 'not configured' });
  });
});
