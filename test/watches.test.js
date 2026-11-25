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
import {
  forgetWatched, githubChanges, githubRef, inboxThread, isWatched, MAX_WATCHES, removeWatch,
  setWatch, watchText, watchUpdate,
} from '../src/agent/watches.js';
import { notifyWatched, pollWatches } from '../src/watches.js';
import { opspileExtension } from '../src/agent/tools.js';
import { forgetGithub, pkcs8Pem } from '../src/github.js';
import { seal } from '../src/post.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up teams, orgs, channels, people, repositories, keys and tokens only.
const NOW = new Date('2026-11-25T12:00:00.000Z');
const KEY = Buffer.alloc(32, 7).toString('base64url');
const TOKEN = 'ghs_made-up-installation-token';
const { privateKey: PKCS1 } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const A = 'slack:E1:C1:1792000000.000100';
const B = 'slack:E1:C1:1792000100.000100';
const C = 'slack:E1:C3:1792000200.000100';
const hour = (n) => new Date(NOW.getTime() - n * 3600000).toISOString();

// GitHub's API, as far as a watch reads it.
const GH = {
  issue: null, pull: null, comments: [], reviews: [],
};
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== 'api.github.com') {
      return realFetch(input, init);
    }
    const reply = (body, status = 200) => Response.json(body, { status });
    if (url.pathname === '/app/installations') {
      return reply([{ id: 41, account: { login: 'acme-labs', type: 'Organization' }, repository_selection: 'all' }]);
    }
    if (/^\/app\/installations\/41\/access_tokens$/.test(url.pathname)) {
      const expires = new Date(Date.now() + 3600_000).toISOString();
      return reply({ token: TOKEN, expires_at: expires }, 201);
    }
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return reply({ message: 'Bad credentials' }, 401);
    }
    if (url.pathname === '/repos/acme-labs/site/issues/7') {
      return GH.issue ? reply(GH.issue) : reply({ message: 'Not Found' }, 404);
    }
    if (url.pathname === '/repos/acme-labs/site/pulls/7') {
      return reply(GH.pull);
    }
    if (url.pathname === '/repos/acme-labs/site/issues/7/comments') {
      return reply(GH.comments.filter((c) => c.created_at > url.searchParams.get('since')));
    }
    if (url.pathname === '/repos/acme-labs/site/pulls/7/reviews') {
      return reply(GH.reviews);
    }
    return reply({ message: 'Not Found' }, 404);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * Thread A (Helix ops' channel C1, for ACME) watches; B is another thread of C1, C one of CDN Co's
 * channel C3, Edge ops'. The agents' objects only record what they are told.
 */
function env() {
  const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }] });
  const thread = DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id,
    org, team, kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, ?, ?, ?, 'channel', ?, 'p/', ?, ?, ?, 1, ?)`);
  thread.run(A, 'C1', '1792000000.000100', 'acme', 'helix', 'aem-acme', hour(9), hour(9), hour(9), hour(9));
  thread.run(B, 'C1', '1792000100.000100', 'acme', 'helix', 'aem-acme', hour(8), hour(8), hour(8), hour(8));
  thread.run(C, 'C3', '1792000200.000100', 'cdnco', 'edge', 'cdnco-support', hour(7), hour(7), hour(7), hour(7));
  const told = [];
  return {
    DB,
    told,
    TOKEN_KEY: KEY,
    AGENT_CHANNELS: 'C1',
    AGENT_MODEL: 'made-up',
    AGENT_BASE_URL: 'https://made-up.example',
    BEDROCK_API_KEY: 'made-up',
    PUBLIC_ORIGIN: 'https://opspile.example',
    AGENTS: {
      idFromName: (name) => name,
      get: (name) => ({
        // eslint-disable-next-line no-underscore-dangle
        __unsafe_ensureInitialized: async () => {},
        watchUpdate: async (update) => { told.push([name, update]); },
      }),
    },
  };
}

let n = 0;
function post(e, thread, at, {
  author = 'Sam', staff = 0, kind = 'person', id = null,
} = {}) {
  n += 1;
  const channel = thread.split(':')[2];
  e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author, staff,
    counted, deleted, author_kind) VALUES ('slack', 'E1', ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(channel, id || `${thread.split(':')[3].split('.')[0]}.${String(n).padStart(6, '0')}`, thread, at, author, staff, kind === 'person' ? 1 : 0, kind);
}

/** Thread A's agent as the tools reach it: its target, and whether it answers a sidebar message. */
const watcher = (e, { sidebar = true } = {}) => ({
  env: e,
  target: async () => ({
    key: A, threads: [A], team: 'helix', org: 'acme', channelId: 'C1', source: 'slack', kind: 'channel',
  }),
  inSidebar: async () => sidebar,
});

/** Thread A's ThreadAgent as watchUpdate needs it: what it is told. */
const thinker = (e) => {
  const a = {
    ...watcher(e),
    submitted: [],
    syncTools: async () => {},
    syncMcp: async () => {},
    harness: { submit: async (input, options) => { a.submitted.push([input, options]); } },
  };
  return a;
};

beforeEach(() => {
  forgetWatched();
  forgetGithub();
  Object.assign(GH, {
    issue: null, pull: null, comments: [], reviews: [],
  });
});

describe('watching a thread', () => {
  it('reads an opspile link, a Slack message link or a key, and keeps what it saw', async () => {
    const e = env();
    post(e, B, hour(8));
    post(e, B, hour(6), { author: 'Ada', staff: 1 });
    const set = await quiet(() => setWatch(watcher(e), {
      url: `https://opspile.example/inbox?team=helix&t=${encodeURIComponent(B)}`, why: 'The fix for the purge is tracked there',
    }, NOW));
    assert.equal(set.error, undefined);
    assert.equal(set.readable, 'channel');
    assert.deepEqual([set.watch.kind, set.watch.target, set.watch.seen, set.watch.set_in], ['thread', B, hour(6), 'sidebar']);
    assert.equal(set.watch.expires_at, '2026-12-25T12:00:00.000Z');
    // A Slack link to a message of C: another customer's channel, which the agent may not read.
    post(e, C, hour(7), { id: '1792000200.000100' });
    const slack = await quiet(() => setWatch(watcher(e, { sidebar: false }), {
      url: 'https://acme.slack.com/archives/C3/p1792000200000100', why: 'CDN Co has to fix the purge', days: 5,
    }, NOW));
    assert.deepEqual([slack.watch.target, slack.readable, slack.watch.set_in], [C, null, 'thread']);
    assert.equal(slack.others.length, 1);
  });

  it('refuses its own thread, a second watch of one, no reason, and more than it may', async () => {
    const e = env();
    const w = watcher(e);
    assert.match((await setWatch(w, { url: A, why: 'x' }, NOW)).error, /your own thread/);
    assert.match((await setWatch(w, { url: B }, NOW)).error, /`why`/);
    assert.match((await setWatch(w, { url: 'https://example.com/nope', why: 'x' }, NOW)).error, /no thread has that key/);
    assert.match((await setWatch(w, { url: B, why: 'x', days: 91 }, NOW)).error, /`days`/);
    await quiet(() => setWatch(w, { url: B, why: 'x' }, NOW));
    assert.match((await setWatch(w, { url: B, why: 'again' }, NOW)).error, /watch .* already/);
    for (let i = 1; i < MAX_WATCHES; i += 1) {
      e.DB.sqlite.prepare(`INSERT INTO agent_watches (id, watcher, kind, target, url, why, set_at, expires_at)
        VALUES (?, ?, 'thread', ?, 'u', 'w', ?, ?)`).run(`w${i}`, A, `t${i}`, hour(1), '2026-12-25T00:00:00Z');
    }
    assert.match((await setWatch(w, { url: C, why: 'x' }, NOW)).error, /You watch 10 already/);
  });

  it('hears of a watched thread\'s people and other bots, not of the system\'s nor Adobe\'s bots', async () => {
    const e = env();
    await quiet(() => setWatch(watcher(e), { url: B, why: 'x' }, NOW));
    assert.equal(await isWatched(e, B, { kind: 'person' }), true);
    assert.equal(await isWatched(e, B, { kind: 'bot', staff: false }), true);
    assert.equal(await isWatched(e, B, { kind: 'bot', staff: true }), false);
    assert.equal(await isWatched(e, B, { kind: 'system' }), false);
    assert.equal(await isWatched(e, C, { kind: 'person' }), false);
    // A thread folded into B's group is B's.
    e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
      path, logical_thread, updated_at) VALUES ('slack:E1:C1:3.0', 'slack', 'E1', 'C1', '3.0', 'acme', 'helix',
      'channel', 'p/', ?, ?)`).run(B, hour(1));
    forgetWatched();
    assert.equal(await isWatched(e, 'slack:E1:C1:3.0', { kind: 'person' }), true);
  });

  it('tells the watching agent once what came since, without Adobe\'s bots', async () => {
    const e = env();
    post(e, B, hour(8));
    await quiet(() => setWatch(watcher(e), { url: B, why: 'x' }, NOW));
    post(e, B, hour(3), { author: 'Vic' });
    post(e, B, hour(2), { author: 'opspile', staff: 1, kind: 'bot' });
    post(e, B, hour(1), { author: 'Ada', staff: 1 });
    const r = await quiet(() => notifyWatched(e, B, NOW));
    assert.deepEqual([r.result, r.told], ['told', 1]);
    const [[name, { watch, change }]] = e.told;
    assert.equal(name, A);
    assert.equal(watch.why, 'x');
    assert.deepEqual(change, {
      type: 'thread', target: B, channel: 'aem-acme', count: 2, adobe: 1, adobeNames: ['Ada'], others: 1, otherNames: ['Vic'], since: hour(8), latest: hour(1),
    });
    // The burst's second job finds nothing new.
    assert.equal((await quiet(() => notifyWatched(e, B, NOW))).result, 'nothing new');
    assert.equal(e.told.length, 1);
  });

  it('names the authors and the read tool only where the agent may read the thread', () => {
    const watch = {
      id: 'w1', url: 'u', why: 'CDN Co fixes the <purge>', set_at: hour(9),
    };
    const change = {
      type: 'thread', target: C, channel: 'cdnco-support', count: 2, adobe: 1, adobeNames: ['Ada'], others: 1, otherNames: ['Vic'], since: hour(8), latest: hour(1),
    };
    const open = watchText(watch, change, 'any');
    assert.match(open, /<why>\nCDN Co fixes the <purge>\n<\/why>/);
    assert.match(open, /2 new messages since .*: 1 from outside Adobe \(Vic\), 1 from Adobe \(Ada\); the latest at/);
    assert.match(open, /read_any_thread \(`thread`: slack:E1:C3:/);
    assert.match(open, /Never post in your thread only to say/);
    const closed = watchText(watch, change, null);
    assert.doesNotMatch(closed, /Vic|Ada|cdnco-support|slack:E1:C3/);
    assert.match(closed, /1 from outside Adobe, 1 from Adobe/);
    assert.match(closed, /You may not read that thread/);
    assert.match(watchText(watch, { type: 'expired' }), /ran out .*watch it again with watch_related/s);
  });

  it('wakes the agent, once per change, unless it is turned off', async () => {
    const e = env();
    const a = thinker(e);
    const update = {
      watch: {
        id: 'w1', kind: 'thread', target: B, url: B, why: 'x', set_at: hour(9),
      },
      change: {
        type: 'thread', target: B, count: 1, adobe: 0, adobeNames: [], others: 1, otherNames: ['Vic'], latest: hour(1),
      },
    };
    assert.deepEqual(await quiet(() => watchUpdate(a, update)), { result: 'told' });
    const [[input, options]] = a.submitted;
    assert.match(input, /read_thread \(`thread`: slack:E1:C1:1792000100/);
    assert.deepEqual(options, { operationId: `watch:w1:${hour(1)}`, whenBusy: 'followUp' });
    const off = thinker({ ...e, AGENT_CHANNELS: '' });
    assert.equal((await watchUpdate(off, update)).result, 'skip');
  });

  it('stops by its id or what it watches', async () => {
    const e = env();
    const { watch } = await quiet(() => setWatch(watcher(e), { url: B, why: 'x' }, NOW));
    assert.match((await removeWatch(watcher(e), { watch: 'nope' })).error, /None of your watches/);
    assert.equal((await removeWatch(watcher(e), { watch: watch.id })).watch.id, watch.id);
    assert.match((await removeWatch(watcher(e), { watch: B })).error, /You watch nothing/);
    assert.equal(await isWatched(e, B, { kind: 'person' }), false);
  });
});

describe('watching a GitHub issue or pull request', () => {
  const PR_URL = 'https://github.com/acme-labs/site/pull/7#issuecomment-1';
  async function withGithub(e, { on = true } = {}) {
    e.DB.sqlite.prepare(`INSERT INTO github_apps (id, slug, name, owner, client_id, private_key, created_at)
      VALUES (777, 'opspile-test', 'opspile test', 'acme-labs', 'Iv1.madeup', ?, '2026-10-25T00:00:00Z')`)
      .run(await seal(e, pkcs8Pem(PKCS1)));
    e.DB.sqlite.exec(`INSERT INTO github_installations (id, app_id, account, approved_by, approved_at)
      VALUES (41, 777, 'acme-labs', 'ada@staff.example', '2026-10-25T00:00:00Z')`);
    if (on) {
      e.DB.sqlite.exec(`INSERT INTO mcp_global_switches (server, scope, target, enabled, changed_by, changed_at)
        VALUES ('github', 'team', 'helix', 1, 'Ada', '2026-10-25T00:00:00Z')`);
    }
    GH.issue = {
      title: 'Purge stale objects', state: 'open', state_reason: null, comments: 1, updated_at: hour(5), pull_request: {},
    };
    GH.pull = { merged: false, draft: true };
  }

  it('reads an issue\'s or a pull request\'s URL', () => {
    assert.deepEqual(githubRef(PR_URL), {
      owner: 'acme-labs', repo: 'site', number: 7, type: 'pull',
    });
    assert.deepEqual(githubRef('https://github.com/acme-labs/site/issues/12'), {
      owner: 'acme-labs', repo: 'site', number: 12, type: 'issue',
    });
    assert.equal(githubRef('https://github.com/acme-labs/site'), null);
    assert.equal(inboxThread('https://opspile.example/inbox?team=helix&t=slack%3AE1%3AC1%3A1.0'), 'slack:E1:C1:1.0');
    assert.equal(inboxThread('https://opspile.example/inbox/topics?t=x'), null);
  });

  it('needs the github server on in the channel, for the repository\'s account', async () => {
    const e = env();
    assert.match((await setWatch(watcher(e), { url: PR_URL, why: 'x' }, NOW)).error, /no opspile GitHub App/);
    await withGithub(e, { on: false });
    assert.match((await setWatch(watcher(e), { url: PR_URL, why: 'x' }, NOW)).error, /github MCP server is not on/);
    assert.match((await setWatch(watcher(e), { url: 'https://github.com/someone-else/x/issues/1', why: 'x' }, NOW)).error, /github MCP server is not on/);
  });

  it('tells the agent what changed, polled, and who commented and reviewed', async () => {
    const e = env();
    await withGithub(e);
    assert.match((await setWatch(watcher(e), { url: 'https://github.com/someone-else/x/issues/1', why: 'x' }, NOW)).error, /does not read someone-else's/);
    const set = await quiet(() => setWatch(watcher(e), { url: PR_URL, why: 'The fix merges here' }, NOW));
    assert.equal(set.error, undefined);
    assert.deepEqual([set.watch.kind, set.watch.target, set.watch.installation, set.watch.seen], ['github', 'acme-labs/site#7', 41, hour(5)]);
    // Polled again before four minutes passed: nothing asked; unchanged: nothing told.
    const early = await quiet(() => pollWatches(e, new Date(NOW.getTime() + 60_000)));
    assert.deepEqual(early, { expired: 0, polled: 0 });
    assert.equal((await quiet(() => pollWatches(e, new Date(NOW.getTime() + 300_000)))).told, 0);
    // It merged, with a comment and an approval.
    Object.assign(GH.issue, { state: 'closed', updated_at: hour(-1), comments: 2 });
    GH.pull = { merged: true, draft: false };
    GH.comments = [{ user: { login: 'old' }, created_at: hour(6) }, { user: { login: 'bo' }, created_at: hour(-0.5) }];
    GH.reviews = [{ user: { login: 'cy' }, state: 'APPROVED', submitted_at: hour(-0.8) }, { user: { login: 'old' }, state: 'COMMENTED', submitted_at: hour(7) }];
    const r = await quiet(() => pollWatches(e, new Date(NOW.getTime() + 600_000)));
    assert.deepEqual([r.polled, r.told, r.failed], [1, 1, 0]);
    const [[name, { change }]] = e.told;
    assert.equal(name, A);
    assert.deepEqual(change.lines, [
      'It is closed (merged) now, was open.',
      'It is ready for review now, no longer a draft.',
      `1 new comment, by bo, the latest at ${hour(-0.5)}.`,
      `cy reviewed it: approved, at ${hour(-0.8)}.`,
    ]);
    assert.match(watchText({
      id: 'w', url: PR_URL, why: 'x', set_at: hour(1),
    }, change), /GitHub pull request acme-labs\/site#7 \("Purge stale objects"\) changed:\n- It is closed \(merged\)/);
  });

  it('ends a watch that ran out, and says so', async () => {
    const e = env();
    await quiet(() => setWatch(watcher(e), { url: B, why: 'x', days: 1 }, NOW));
    const r = await quiet(() => pollWatches(e, new Date(NOW.getTime() + 2 * 86400000)));
    assert.equal(r.expired, 1);
    assert.deepEqual(e.told.map(([, u]) => u.change.type), ['expired']);
    assert.deepEqual(e.DB.rows('SELECT id FROM agent_watches'), []);
  });

  it('says nothing for changes an agent does not care about', () => {
    const s = { state: 'open', merged: false, title: 't' };
    assert.deepEqual(githubChanges(s, { ...s }), []);
    assert.deepEqual(githubChanges(s, { ...s, state: 'closed', reason: 'not_planned' }), ['It is closed (not planned) now, was open.']);
  });
});

describe('the watch tools', () => {
  it('are every thread agent\'s, and list, set and stop watches', async () => {
    const e = env();
    const w = watcher(e);
    const ctx = {
      ...w,
      hasThread: true,
      verdicts: async () => new Map(),
      watch: { set: (args) => setWatch(w, args, NOW), remove: (args) => removeWatch(w, args) },
    };
    const ext = opspileExtension(ctx);
    const tools = Object.fromEntries(ext.tools.map((t) => [t.name, t]));
    const run = async (name, args) => {
      const res = await quiet(() => tools[name].execute(args, {}));
      return { text: res.output.map((o) => o.text).join(''), error: Boolean(res.isError) };
    };
    assert.deepEqual(await run('watch_related', {}), { text: 'You watch nothing.', error: false });
    const set = await run('watch_related', { url: B, why: 'The purge fix is tracked there' });
    assert.equal(set.error, false);
    assert.match(set.text, /^watching \(watch [0-9a-f]{8}\) thread slack:E1:C1:1792000100\.000100 until 2026-12-25\. You are woken a minute after new messages in it; read them with read_thread/);
    assert.match((await run('watch_related', {})).text, /^You watch:\n- [0-9a-f]{8}: thread .* because: The purge fix is tracked there$/);
    const stop = await run('unwatch_related', { watch: B });
    assert.match(stop.text, /^no longer watching slack:E1:C1:1792000100\.000100 \(watch [0-9a-f]{8}\)\.$/);
    assert.equal((await run('unwatch_related', { watch: B })).error, true);
    // A knowledge-base agent has no thread to watch for.
    assert.equal(opspileExtension({ ...ctx, hasThread: false }).tools.some((t) => t.name.includes('watch')), false);
  });
});
