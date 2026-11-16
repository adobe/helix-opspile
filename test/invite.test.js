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
import { invitedFields, invitedNote, inviteMentioned } from '../src/invite.js';
import { post, seal } from '../src/post.js';
import { postApp } from '../src/postapp.js';
import { d1 } from './d1.js';

// Made-up keys, ids and people only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ME = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const T = { source: 'slack', tenant: 'E1', channel_id: 'C1' };

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo Staff', staff: 1,
      },
      {
        id: 3, email: 'cy@customer.example', name: 'Cy Customer', staff: 0,
      },
    ],
  });
  const add = (id, kind, name, person, staff = null, tenant = 'E1') => DB.sqlite.prepare(`INSERT
    INTO identities (source, tenant, user_id, kind, name, person, staff, fetched_at)
    VALUES ('slack', ?, ?, ?, ?, ?, ?, '2026-10-21T10:00:00Z')`).run(tenant, id, kind, name, person, staff);
  add('U1', 'person', 'ada', 1);
  add('U2', 'person', 'bo', 2);
  add('U3', 'person', 'cy', 3);
  // Adobe by the account alone, with no person yet.
  add('U4', 'person', 'Di Staff', null, 1);
  add('B1', 'bot', 'Somebot', null, 1);
  add('U5', 'person', 'Bo Elsewhere', 2, null, 'E9');
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    path, any_at, updated_at) VALUES ('slack:E1:C1:1.1', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix',
    'p/', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`).run();
  DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, fetched_at)
    VALUES ('slack', 'E1', 'C1', '2026-10-21T10:00:00Z')`).run();
  return {
    DB,
    TOKEN_KEY: KEY,
    STAFF_DOMAINS: 'staff.example',
    SLACK_BOT_TOKEN: 'xoxb-made-up',
  };
}
const inTeam = (t) => [].concat(t).includes('helix');

/**
 * A fake Slack: `answers` by user id (an error code, or nothing for added); `assign` by user id,
 * admin.users.assign's (an error code, or nothing for added to the workspace, after which
 * conversations.invite adds them).
 */
function slack(answers = {}, assign = {}) {
  const calls = [];
  const joined = new Set();
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ u, body, auth: init.headers?.authorization });
    if (u.endsWith('/admin.users.assign')) {
      const error = assign[body.user_id];
      if (!error) {
        joined.add(body.user_id);
      }
      return Response.json(error ? { ok: false, error } : { ok: true });
    }
    if (u.endsWith('/conversations.invite')) {
      const error = joined.has(body.users) ? null : answers[body.users];
      return Response.json(error ? { ok: false, error } : { ok: true, channel: { id: 'C1' } });
    }
    if (u.endsWith('/chat.postMessage')) {
      return Response.json({ ok: true, ts: '1.9' });
    }
    throw new Error(`unexpected ${u}`);
  };
  return { calls, fetch };
}

describe('inviteMentioned', () => {
  it('adds the Adobe people mentioned, with the app, one call each', async () => {
    const e = env();
    const s = slack();
    const res = await inviteMentioned(e, T, [
      { id: 'U2', name: 'bo' }, { id: 'U4', name: 'Di Staff' },
    ], { fetch: s.fetch });
    assert.deepEqual(res.invited.map((p) => [p.id, p.name]), [['U2', 'Bo Staff'], ['U4', 'Di Staff']]);
    assert.deepEqual(res.refused, []);
    assert.deepEqual(s.calls.map((c) => [c.body.channel, c.body.users, c.auth]).sort(), [
      ['C1', 'U2', 'Bearer xoxb-made-up'], ['C1', 'U4', 'Bearer xoxb-made-up'],
    ]);
  });

  it('never adds anyone outside Adobe, a bot, the poster, or an account of another workspace', async () => {
    const e = env();
    const s = slack();
    const res = await inviteMentioned(e, T, [
      { id: 'U3' }, { id: 'B1', kind: 'bot' }, { id: 'U1' }, { id: 'U5' },
    ], { fetch: s.fetch, except: 'U1' });
    assert.equal(res, null);
    assert.deepEqual(s.calls, []);
  });

  it('says nothing of who is in already, and tells whom Slack would not add', async () => {
    const e = env();
    const s = slack({ U2: 'already_in_channel', U4: 'org_user_not_in_team' });
    const res = await inviteMentioned(e, T, [{ id: 'U2' }, { id: 'U4' }], { fetch: s.fetch });
    assert.deepEqual(res.invited, []);
    assert.deepEqual(res.refused.map((p) => [p.id, p.error]), [['U4', 'org_user_not_in_team']]);
    assert.deepEqual(invitedFields(res), {
      uninvited: [{ id: 'U4', name: 'Di Staff', error: 'org_user_not_in_team' }],
    });

    const none = await inviteMentioned(e, T, [{ id: 'U2' }], { fetch: slack({ U2: 'already_in_channel' }).fetch });
    assert.equal(none, null);
  });

  it('refuses nobody when the call itself fails: no scope, not in the channel, Slack away', async () => {
    const e = env();
    for (const error of ['missing_scope', 'not_in_channel', 'no_permission']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await inviteMentioned(e, T, [{ id: 'U2' }], { fetch: slack({ U2: error }).fetch }), null);
    }
    const down = async () => {
      throw new Error('network');
    };
    assert.equal(await inviteMentioned(e, T, [{ id: 'U2' }], { fetch: down }), null);
  });

  it('does nothing off Slack, or without the app', async () => {
    const e = env();
    const s = slack();
    assert.equal(await inviteMentioned(e, { ...T, source: 'teams' }, [{ id: 'U2' }], { fetch: s.fetch }), null);
    assert.equal(await inviteMentioned({ ...e, SLACK_BOT_TOKEN: '' }, T, [{ id: 'U2' }], { fetch: s.fetch }), null);
    assert.equal(await inviteMentioned(e, T, [], { fetch: s.fetch }), null);
    assert.deepEqual(s.calls, []);
  });

  it('with the admin token, adds someone of the org to the workspace first', async () => {
    const e = { ...env(), SLACK_ADMIN_TOKEN: 'xoxp-admin-made-up' };
    e.DB.sqlite.prepare("UPDATE channels SET group_id = 'T1' WHERE channel_id = 'C1'").run();
    const s = slack({ U2: 'org_user_not_in_team', U4: 'already_in_channel' });
    const res = await inviteMentioned(e, T, [{ id: 'U2' }, { id: 'U4' }], { fetch: s.fetch });
    assert.deepEqual(invitedFields(res), {
      invited: [{ id: 'U2', name: 'Bo Staff', workspace: true }],
    });
    const assigned = s.calls.filter((c) => c.u.endsWith('/admin.users.assign'));
    assert.deepEqual(assigned.map((c) => [c.body, c.auth]), [
      [{ team_id: 'T1', user_id: 'U2' }, 'Bearer xoxp-admin-made-up'],
    ]);
    assert.deepEqual(s.calls.filter((c) => c.u.endsWith('/conversations.invite'))
      .map((c) => [c.body.users, c.auth]), [
      ['U2', 'Bearer xoxb-made-up'], ['U4', 'Bearer xoxb-made-up'], ['U2', 'Bearer xoxb-made-up'],
    ]);
    assert.match(invitedNote(invitedFields(res)), /Bo Staff \(to the Slack workspace too\)/);
  });

  it('with the admin token, tells what Slack said of the person, and keeps the rest', async () => {
    const e = { ...env(), SLACK_ADMIN_TOKEN: 'xoxp-admin-made-up' };
    e.DB.sqlite.prepare("UPDATE channels SET group_id = 'T1' WHERE channel_id = 'C1'").run();
    const nope = await inviteMentioned(e, T, [{ id: 'U2' }], {
      fetch: slack({ U2: 'org_user_not_in_team' }, { U2: 'user_cannot_be_added_to_workspace' }).fetch,
    });
    assert.deepEqual(nope.refused.map((p) => p.error), ['user_cannot_be_added_to_workspace']);
    // The token without the scope: Slack's first answer stands.
    const scope = await inviteMentioned(e, T, [{ id: 'U2' }], {
      fetch: slack({ U2: 'org_user_not_in_team' }, { U2: 'missing_scope' }).fetch,
    });
    assert.deepEqual(scope.refused.map((p) => p.error), ['org_user_not_in_team']);
  });

  it('without the admin token or the workspace, asks nobody to add anyone to it', async () => {
    const e = env();
    const s = slack({ U2: 'org_user_not_in_team' });
    const res = await inviteMentioned(e, T, [{ id: 'U2' }], { fetch: s.fetch });
    assert.deepEqual(res.refused.map((p) => p.error), ['org_user_not_in_team']);
    // A channel of the whole org (or not looked up yet) has no workspace to add them to.
    const t = slack({ U2: 'org_user_not_in_team' });
    await inviteMentioned({ ...e, SLACK_ADMIN_TOKEN: 'xoxp-admin-made-up' }, T, [{ id: 'U2' }], { fetch: t.fetch });
    assert.deepEqual([...s.calls, ...t.calls].filter((c) => c.u.endsWith('/admin.users.assign')), []);
  });

  it('writes a note for agents and MCP clients', () => {
    assert.equal(invitedNote({}), '');
    assert.equal(
      invitedNote({ invited: [{ name: 'Bo' }], uninvited: [{ name: 'Di', error: 'cant_invite' }] }),
      ' Added to the channel first, so they see the mention: Bo. Not in the channel, and Slack would not add them, so they may not see it: Di (cant_invite).',
    );
  });
});

describe('posting adds the colleagues it mentions to the channel first', () => {
  const real = globalThis.fetch;
  let s;
  beforeEach(() => {
    s = slack({ U4: 'cant_invite' });
    globalThis.fetch = s.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('as the person, before the reply goes out', async () => {
    const e = env();
    await e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token,
      updated_at) VALUES (1, 'slack', 'U1', ?, '2026-10-21T10:00:00Z')`).run(await seal(e, 'xoxp-ada'));
    const res = await post(e, ME, {
      thread: 'slack:E1:C1:1.1',
      text: '@Bo Staff @Di Staff @ada have a look',
      mentions: [{ id: 'U2' }, { id: 'U4' }, { id: 'U1' }],
    }, inTeam);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.invited, [{ id: 'U2', name: 'Bo Staff' }]);
    assert.deepEqual(data.uninvited, [{ id: 'U4', name: 'Di Staff', error: 'cant_invite' }]);
    const order = s.calls.map((c) => c.u.split('/').pop());
    assert.equal(order.at(-1), 'chat.postMessage');
    assert.deepEqual(s.calls.filter((c) => c.u.endsWith('/conversations.invite')).map((c) => c.body.users).sort(), ['U2', 'U4']);
    assert.equal(s.calls.at(-1).auth, 'Bearer xoxp-ada');
  });

  it('as the opspile app', async () => {
    const e = env();
    e.DB.sqlite.prepare(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by,
      changed_at) VALUES ('post_message', 'team', 'helix', 1, 'Ada', '2026-10-21T10:00:00Z')`).run();
    const res = await postApp(e, ME, {
      thread: 'slack:E1:C1:1.1', text: '@Bo Staff see this', mentions: [{ id: 'U2' }],
    }, inTeam);
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.deepEqual(data.invited, [{ id: 'U2', name: 'Bo Staff' }]);
    assert.equal(s.calls.at(-1).u.split('/').pop(), 'chat.postMessage');
  });
});
