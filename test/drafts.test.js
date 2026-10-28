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
import { api, inbox } from '../src/api.js';
import { render } from '../src/channels.js';
import { seal } from '../src/post.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up keys, ids and people only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', teams: [{ slug: 'helix' }],
};
const EVE = {
  id: 3, email: 'eve@staff.example', name: 'Eve', teams: [{ slug: 'other' }],
};
const ROOT = 'slack:E1:C1:1.1';
const FOLLOW = 'slack:E1:C1:2.1';

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'other', name: 'Other' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
      },
      {
        id: 3, email: 'eve@staff.example', name: 'Eve', staff: 1, teams: ['other'],
      },
    ],
  });
  for (const [thread, root] of [[ROOT, '1.1'], [FOLLOW, '2.1']]) {
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, root_at, last_at, any_at, messages, updated_at) VALUES (?, 'slack', 'E1', 'C1', ?,
      'acme', 'helix', ?, '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z',
      1, '2026-10-21T10:00:00Z')`).run(thread, root, `p/${root}/`);
    DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, author_key) VALUES ('slack', 'E1', 'C1', ?, ?, '2026-10-21T10:00:00Z', 0, 1,
      'slack:E1:U9')`).run(root, thread);
  }
  const notified = [];
  const ROOMS = {
    idFromName: (n) => n,
    get: (team) => ({
      fetch: async (u, init) => {
        notified.push({ team, ...JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      },
    }),
  };
  return {
    DB,
    ROOMS,
    CHANNELS: fakeBucket(),
    notified,
    TOKEN_KEY: KEY,
    STAFF_DOMAINS: 'staff.example',
  };
}

const call = (e, who, method, path, body) => api(
  new Request(`https://opspile.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
  e,
  new URL(`https://opspile.test${path}`),
  { viewer: who },
);
const draftOf = async (e, who, thread = ROOT) => (await (await call(e, who, 'GET', `/api/draft?thread=${encodeURIComponent(thread)}`)).json()).draft;

describe('shared drafts', () => {
  it('keeps one draft per thread, which the whole team sees', async () => {
    const e = env();
    assert.equal(await draftOf(e, ADA), null);
    const res = await call(e, ADA, 'PUT', '/api/draft', {
      thread: ROOT, text: 'Looking into it, @Cy', mentions: [{ id: 'U9', name: 'Cy' }], base: null,
    });
    assert.equal(res.status, 200);
    const saved = (await res.json()).draft;
    assert.equal(saved.body, 'Looking into it, @Cy');
    assert.deepEqual(saved.mentions, [{ id: 'U9', name: 'Cy' }]);
    assert.deepEqual(saved.by, { id: 1, name: 'Ada' });
    assert.deepEqual(e.notified, [{ team: 'helix', type: 'draft', thread: ROOT }]);

    // A colleague sees it, and changes it from that version.
    assert.equal((await draftOf(e, BO)).body, 'Looking into it, @Cy');
    const again = await call(e, BO, 'PUT', '/api/draft', { thread: ROOT, text: 'Fixed in 1.2', base: saved.updated_at });
    assert.equal(again.status, 200);
    const changed = (await again.json()).draft;
    assert.deepEqual(changed.by, { id: 2, name: 'Bo' });
    assert.equal(changed.created_at, saved.created_at);
    assert.ok(changed.updated_at > saved.updated_at);
    assert.equal(e.DB.rows('SELECT * FROM drafts').length, 1);
  });

  it('does not overwrite a draft somebody changed meanwhile', async () => {
    const e = env();
    const first = (await (await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'one', base: null })).json()).draft;
    // Bo started without a draft: his save would overwrite Ada's.
    let res = await call(e, BO, 'PUT', '/api/draft', { thread: ROOT, text: 'two', base: null });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.conflict, true);
    assert.equal(body.draft.body, 'one');
    // He saw it and chose to overwrite.
    res = await call(e, BO, 'PUT', '/api/draft', { thread: ROOT, text: 'two', base: first.updated_at });
    assert.equal(res.status, 200);
    // Ada's stale version cannot discard it either.
    res = await call(e, ADA, 'DELETE', '/api/draft', { thread: ROOT, base: first.updated_at });
    assert.equal(res.status, 409);
    assert.equal((await draftOf(e, ADA)).body, 'two');
  });

  it('is shared with the teams a channel is shared with, and tells all their rooms', async () => {
    const e = env();
    assert.equal((await call(e, EVE, 'PUT', '/api/draft', { thread: ROOT, text: 'x', base: null })).status, 404);
    e.DB.sqlite.exec(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('slack', 'C1', 'other', '2026-10-21T10:00:00Z')`);
    const res = await call(e, EVE, 'PUT', '/api/draft', { thread: ROOT, text: 'From the other team', base: null });
    assert.equal(res.status, 200);
    assert.deepEqual(e.notified.map((n) => n.team).sort(), ['helix', 'other']);
    assert.equal((await draftOf(e, ADA)).body, 'From the other team');
    // A read goes to the room of the inbox it was read in.
    e.notified.length = 0;
    const read = await call(e, EVE, 'POST', '/api/read', { thread: ROOT, at: '2026-10-21T10:00:00Z', team: 'other' });
    assert.equal(read.status, 204);
    assert.deepEqual(e.notified.map((n) => n.team), ['other']);
  });

  it('discards a draft', async () => {
    const e = env();
    const d = (await (await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'one', base: null })).json()).draft;
    const res = await call(e, BO, 'DELETE', '/api/draft', { thread: ROOT, base: d.updated_at });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).discarded, true);
    assert.equal(await draftOf(e, ADA), null);
    assert.equal((await (await call(e, BO, 'DELETE', '/api/draft', { thread: ROOT })).json()).discarded, false);
  });

  it('is only for the team that owns the channel', async () => {
    const e = env();
    await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'one', base: null });
    assert.equal((await call(e, EVE, 'GET', `/api/draft?thread=${ROOT}`)).status, 404);
    assert.equal((await call(e, EVE, 'PUT', '/api/draft', { thread: ROOT, text: 'x', base: null })).status, 404);
    assert.equal((await call(e, EVE, 'DELETE', '/api/draft', { thread: ROOT })).status, 404);
    // Admins look at every thread, so they see its draft, but write only in their own teams.
    const admin = { ...EVE, teams: [{ slug: 'admin' }] };
    assert.equal((await draftOf(e, admin)).body, 'one');
    assert.equal((await call(e, admin, 'PUT', '/api/draft', { thread: ROOT, text: 'x', base: null })).status, 404);
    // Viewing as someone else is read-only.
    const as = { ...BO, readonly: true, viewer: { id: 9, name: 'Admin' } };
    assert.equal((await call(e, as, 'PUT', '/api/draft', { thread: ROOT, text: 'x', base: null })).status, 403);
    assert.equal((await call(e, as, 'DELETE', '/api/draft', { thread: ROOT })).status, 403);
  });

  it('refuses empty and overlong drafts', async () => {
    const e = env();
    assert.equal((await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: '  \n', base: null })).status, 400);
    assert.equal((await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'x'.repeat(8001), base: null })).status, 400);
  });

  it('follows a thread into its group', async () => {
    const e = env();
    await call(e, ADA, 'PUT', '/api/draft', { thread: FOLLOW, text: 'on the follow-up', base: null });
    // The follow-up is re-threaded into ROOT's group: the draft shows on the entry.
    e.DB.sqlite.prepare('UPDATE threads SET logical_thread = ? WHERE thread = ?').run(ROOT, FOLLOW);
    const d = await draftOf(e, BO, ROOT);
    assert.equal(d.body, 'on the follow-up');
    const { threads } = await inbox(e, BO, 'helix');
    assert.equal(threads.length, 1);
    assert.equal(threads[0].draft.preview, 'on the follow-up');
    // Saving it again moves it to the group's key; there is still one.
    await call(e, BO, 'PUT', '/api/draft', { thread: ROOT, text: 'merged', base: d.updated_at });
    assert.deepEqual(e.DB.rows('SELECT thread, body FROM drafts'), [{ thread: ROOT, body: 'merged' }]);
  });

  it('opens a folded thread as its group, not on its own', async () => {
    const e = env();
    e.DB.sqlite.prepare('UPDATE threads SET logical_thread = ? WHERE thread = ?').run(ROOT, FOLLOW);
    for (const key of [FOLLOW, ROOT]) {
      // eslint-disable-next-line no-await-in-loop
      const data = await (await call(e, BO, 'GET', `/api/thread?thread=${key}`)).json();
      assert.equal(data.thread.thread, ROOT);
      assert.deepEqual(data.members.map((m) => m.thread).sort(), [ROOT, FOLLOW]);
    }
    // A group whose first thread is gone shows the asked thread alone.
    e.DB.sqlite.prepare('UPDATE threads SET logical_thread = ? WHERE thread = ?').run('slack:E1:C1:0.1', FOLLOW);
    const alone = await (await call(e, BO, 'GET', `/api/thread?thread=${FOLLOW}`)).json();
    assert.equal(alone.thread.thread, FOLLOW);
    assert.deepEqual(alone.members.map((m) => m.thread), [FOLLOW]);
  });

  it('marks threads with a draft in the inbox and the thread', async () => {
    const e = env();
    await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: `long ${'x'.repeat(200)}`, base: null });
    const { threads } = await inbox(e, BO, 'helix');
    const root = threads.find((t) => t.thread === ROOT);
    assert.deepEqual(root.draft.by, { id: 1, name: 'Ada' });
    assert.equal(root.draft.preview.length, 140);
    assert.equal(threads.find((t) => t.thread === FOLLOW).draft, null);
    const res = await call(e, BO, 'GET', `/api/thread?thread=${ROOT}`);
    assert.equal((await res.json()).draft.body.length, 205);
  });

  describe('sending', () => {
    const real = globalThis.fetch;
    beforeEach(() => {
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/chat.postMessage')) {
          return Response.json({ ok: true, ts: '1.9' });
        }
        throw new Error(`unexpected ${url}`);
      };
    });
    afterEach(() => {
      globalThis.fetch = real;
    });
    const connect = async (e, person) => e.DB.sqlite.prepare(`INSERT INTO user_tokens (person,
      platform, user_id, access_token, scope, updated_at) VALUES (?, 'slack', 'U1', ?, 'chat:write',
      '2026-10-21T10:00:00Z')`).run(person, await seal(e, 'xoxp-made-up'));

    it('uses up the draft it was written from', async () => {
      const e = env();
      await connect(e, 2);
      const d = (await (await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'one', base: null })).json()).draft;
      const res = await call(e, BO, 'POST', '/api/post', { thread: ROOT, text: 'one', draft: d.updated_at });
      assert.equal(res.status, 200);
      assert.equal(await draftOf(e, ADA), null);
    });

    it('keeps a draft that changed, or that the reply was not written from', async () => {
      const e = env();
      await connect(e, 2);
      const d = (await (await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'one', base: null })).json()).draft;
      await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'two', base: d.updated_at });
      await call(e, BO, 'POST', '/api/post', { thread: ROOT, text: 'one', draft: d.updated_at });
      assert.equal((await draftOf(e, ADA)).body, 'two');
      await call(e, BO, 'POST', '/api/post', { thread: ROOT, text: 'something else' });
      assert.equal((await draftOf(e, ADA)).body, 'two');
    });

    it('posts as the opspile app where Post messages is on, for the thread\'s teams', async () => {
      const e = { ...env(), SLACK_BOT_TOKEN: 'xoxb-made-up' };
      const off = await call(e, BO, 'POST', '/api/post/app', { thread: ROOT, text: 'one' });
      assert.equal(off.status, 409);
      const asBot = async (who) => (await (await call(e, who, 'GET', `/api/thread?thread=${ROOT}`)).json()).can_post_as_bot;
      assert.equal(await asBot(BO), false);
      e.DB.sqlite.prepare(`INSERT INTO agent_tool_switches (tool, scope, target, enabled,
        changed_by, changed_at) VALUES ('post_message', 'channel', 'C1', 1, 'Ada',
        '2026-10-21T10:00:00Z')`).run();
      // The thread says so, for its teams' staff, and not when viewing as someone.
      assert.equal(await asBot(BO), true);
      assert.equal(await asBot({ ...BO, readonly: true, viewer: { id: 1, name: 'Ada' } }), false);
      const elsewhere = await call(e, EVE, 'POST', '/api/post/app', { thread: ROOT, text: 'one' });
      assert.equal(elsewhere.status, 404);
      const d = (await (await call(e, ADA, 'PUT', '/api/draft', { thread: ROOT, text: 'one', base: null })).json()).draft;
      // No personal account needed: it goes out with the bot token.
      const res = await call(e, BO, 'POST', '/api/post/app', { thread: ROOT, text: 'one', draft: d.updated_at });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true, platform: 'slack', id: '1.9', text: 'one',
      });
      assert.equal(await draftOf(e, ADA), null);
    });
  });
});

describe('own messages', () => {
  /** A reply in ROOT's folder, by `person` (a known person's id, or null). */
  const reply = async (e, id, person) => {
    const at = `2026-10-21T10:0${id}:00Z`;
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, person) VALUES ('slack', 'E1', 'C1', ?, ?, ?, 1, 1, ?)`).run(`1.${id}`, ROOT, at, person);
    await e.CHANNELS.put(`p/1.1/1.${id}.md`, render({
      source: 'slack', thread: ROOT, id: `1.${id}`, at,
    }, `reply ${id}`));
  };
  const mine = async (e, who) => {
    const { messages } = await (await call(e, who, 'GET', `/api/thread?thread=${ROOT}`)).json();
    return Object.fromEntries(messages.map((m) => [m.id, m.mine]));
  };

  it('says which messages the viewer posted, also when an admin views as them', async () => {
    const e = env();
    await reply(e, 2, 1); // Ada
    await reply(e, 3, 2); // Bo
    await reply(e, 4, null); // nobody known
    assert.deepEqual(await mine(e, ADA), { 1.2: true, 1.3: false, 1.4: false });
    assert.deepEqual(await mine(e, BO), { 1.2: false, 1.3: true, 1.4: false });
    // "View as" Bo: `viewer()` makes Bo the viewer, read-only.
    assert.deepEqual(await mine(e, { ...BO, readonly: true, viewer: { id: 1, name: 'Ada' } }), {
      1.2: false, 1.3: true, 1.4: false,
    });
  });
});
