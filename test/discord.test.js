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
import { registerHooks } from 'node:module';
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { parse } from '../src/channels.js';
import {
  discordKey, newer, snowflakeAt, snowflakeMs,
} from '../src/discord.js';
import { discordToMarkdown } from '../src/markdown.js';
import { discordEmbeds, normalizeDiscord } from '../src/normalize.js';
import { processKey } from '../src/normalizer.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// The gateway is a Durable Object; outside workerd its base class is a plain one.
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'cloudflare:workers'
    ? { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true }
    : next(specifier, context)),
});
const { DiscordGateway, replyTarget } = await import('../src/gateway.js');

// Made-up ids and names only.
const G = '100000000000000001';
const CH = '200000000000000002';
const FORUM = '200000000000000003';
const ROOT = '1300000000000000010';
const REPLY = '1300000000000000011';
const REPLY2 = '1300000000000000012';
const TH = '1300000000000000020';
const ADA = '400000000000000001';
const CY = '400000000000000002';
const STAFF_ROLE = '500000000000000001';

const msg = (id, extra = {}) => ({
  id,
  type: 0,
  channel_id: CH,
  content: 'hello',
  timestamp: new Date(snowflakeMs(id)).toISOString(),
  edited_timestamp: null,
  author: { id: CY, username: 'cy', global_name: 'Cy' },
  attachments: [],
  embeds: [],
  mentions: [],
  ...extra,
});

describe('discord snowflakes', () => {
  it('turn into times and back', () => {
    const ms = Date.parse('2026-10-22T00:10:00Z');
    assert.equal(snowflakeMs(snowflakeAt(ms)), ms);
    assert.ok(newer(snowflakeAt(ms + 1), snowflakeAt(ms)));
    assert.ok(newer('1', undefined));
    assert.ok(!newer(undefined, '1'));
  });
});

describe('discordKey', () => {
  it('files an envelope under the channel and day, the same event under the same key', async () => {
    const d = msg(ROOT);
    const day = new Date(snowflakeMs(ROOT)).toISOString().slice(0, 10).replace(/-/g, '/');
    assert.equal(
      await discordKey({ t: 'MESSAGE_CREATE', guild: G, d }),
      `discord/${G}/${CH}/${day}/${ROOT}-create.json`,
    );
    // A thread's messages are filed under its parent channel.
    const thread = {
      id: TH, parent_id: FORUM, name: 'Help', type: 11,
    };
    assert.match(await discordKey({
      t: 'MESSAGE_CREATE', guild: G, d: msg(TH, { channel_id: TH }), thread,
    }), new RegExp(`^discord/${G}/${FORUM}/`));
    const update = { t: 'MESSAGE_UPDATE', guild: G, d: { ...d, content: 'edited' } };
    assert.equal(await discordKey(update), await discordKey({ ...update }));
    assert.notEqual(await discordKey(update), await discordKey({ ...update, d: { ...d, content: 'again' } }));
    assert.match(await discordKey({ t: 'MESSAGE_DELETE', guild: G, d: { id: ROOT, channel_id: CH } }), /-delete\.json$/);
  });
});

describe('normalizeDiscord', () => {
  it('makes a channel message its own root', () => {
    const op = normalizeDiscord('k', { t: 'MESSAGE_CREATE', guild: G, d: msg(ROOT) });
    assert.equal(op.op, 'upsert');
    assert.deepEqual(
      [op.message.thread, op.message.rootId, op.message.channelId],
      [`discord:${G}:${CH}:${ROOT}`, ROOT, CH],
    );
    assert.equal(op.message.permalink, `https://discord.com/channels/${G}/${CH}/${ROOT}`);
    assert.deepEqual(op.message.authorRef, {
      source: 'discord', tenant: G, userId: CY, name: 'Cy', bot: false,
    });
  });

  it('files a thread message under the parent channel and the thread, a forum post with its title', () => {
    const thread = {
      id: TH, parent_id: FORUM, name: 'Preview fails', type: 11,
    };
    const first = normalizeDiscord('k', {
      t: 'MESSAGE_CREATE', guild: G, d: msg(TH, { channel_id: TH }), thread, root: TH,
    });
    assert.deepEqual(
      [first.message.thread, first.message.id, first.message.subject],
      [`discord:${G}:${FORUM}:${TH}`, TH, 'Preview fails'],
    );
    assert.equal(first.message.permalink, `https://discord.com/channels/${G}/${TH}/${TH}`);
    const reply = normalizeDiscord('k', {
      t: 'MESSAGE_CREATE', guild: G, d: msg(REPLY, { channel_id: TH }), thread, root: TH,
    });
    assert.deepEqual([reply.message.rootId, reply.message.subject], [TH, undefined]);
  });

  it('puts an inline reply in the conversation it answers', () => {
    const op = normalizeDiscord('k', {
      t: 'MESSAGE_CREATE',
      guild: G,
      d: msg(REPLY, { type: 19, message_reference: { message_id: ROOT, channel_id: CH } }),
      root: ROOT,
    });
    assert.equal(op.message.thread, `discord:${G}:${CH}:${ROOT}`);
  });

  it('skips joins, pins and a thread\'s copy of its starter message', () => {
    for (const type of [7, 6, 18, 21]) {
      assert.equal(normalizeDiscord('k', { t: 'MESSAGE_CREATE', guild: G, d: msg(ROOT, { type }) }).op, 'skip');
    }
  });

  it('keeps images and files, and renders a bot\'s embeds', () => {
    const op = normalizeDiscord('k', {
      t: 'MESSAGE_CREATE',
      guild: G,
      d: msg(ROOT, {
        content: '',
        author: {
          id: ADA, username: 'releases', bot: true,
        },
        attachments: [
          {
            url: 'https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1', filename: 'shot.png', content_type: 'image/png', width: 640, height: 480,
          },
          { url: 'https://cdn.discordapp.com/attachments/1/3/log.txt', filename: 'log.txt', content_type: 'text/plain' },
        ],
        embeds: [{
          type: 'rich', title: 'v1.2.3', url: 'https://example.com/r', description: 'Fixes', fields: [{ name: 'Repo', value: 'acme/site' }],
        }, { type: 'link', title: 'a preview' }],
      }),
    });
    assert.match(op.message.text, /\*\*\[v1\.2\.3\]\(https:\/\/example\.com\/r\)\*\*\n\nFixes\n\n\*\*Repo:\*\* acme\/site/);
    assert.ok(!op.message.text.includes('a preview'));
    assert.match(op.message.text, /!\[shot\.png\]\(https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/shot\.png\?ex=1 "640x480"\)/);
    assert.match(op.message.text, /- \[log\.txt\]/);
    assert.equal(op.message.authorRef.bot, true);
  });

  it('reads reactions, deletions and renames', () => {
    const thread = {
      id: TH, parent_id: FORUM, name: 'x', type: 11,
    };
    const r = normalizeDiscord('k', {
      t: 'MESSAGE_REACTION_ADD',
      guild: G,
      d: {
        user_id: ADA, channel_id: TH, message_id: TH, emoji: { name: '✅', id: null },
      },
      thread,
      at: '2026-10-22T00:00:00.000Z',
    });
    assert.deepEqual(r.reaction, {
      removed: false, emoji: '✅', source: 'discord', tenant: G, channelId: FORUM, id: TH, userId: ADA, at: '2026-10-22T00:00:00.000Z',
    });
    const custom = normalizeDiscord('k', {
      t: 'MESSAGE_REACTION_REMOVE',
      guild: G,
      d: {
        user_id: ADA, channel_id: CH, message_id: ROOT, emoji: { name: 'party', id: '9' },
      },
    });
    assert.deepEqual([custom.reaction.emoji, custom.reaction.removed], [':party:', true]);
    const del = normalizeDiscord('k', {
      t: 'MESSAGE_DELETE', guild: G, d: { id: REPLY, channel_id: CH }, root: ROOT, at: '2026-10-22T00:00:00.000Z',
    });
    assert.deepEqual([del.op, del.message.thread, del.message.deletedAt], ['delete', `discord:${G}:${CH}:${ROOT}`, '2026-10-22T00:00:00.000Z']);
    const ch = normalizeDiscord('k', { t: 'CHANNEL_UPDATE', guild: G, d: { id: CH, name: 'aem-acme' } });
    assert.deepEqual(ch.channel, {
      source: 'discord', tenant: G, channelId: CH, name: 'aem-acme',
    });
  });

  it('turns history reactors into reaction rows', () => {
    const op = normalizeDiscord('k', {
      t: 'MESSAGE_CREATE', via: 'history', guild: G, d: msg(ROOT), reactions: [{ emoji: '✅', users: [ADA, CY] }],
    });
    assert.deepEqual(op.message.reactions, [{ emoji: '✅', userId: ADA }, { emoji: '✅', userId: CY }]);
  });
});

describe('discordToMarkdown', () => {
  it('names mentions, roles and channels, and keeps code as typed', () => {
    const out = discordToMarkdown('Hi <@1> and <@!2>, ask <@&3> in <#4> <:party:5> at <t:1792627800:f>\n-# small\n`<@1>`', {
      user: (id) => ({ 1: 'Ada', 2: 'Cy' }[id]),
      role: () => 'mods',
      channel: () => 'help-desk',
    });
    assert.equal(out, 'Hi @Ada and @Cy, ask @mods in #help-desk :party: at 2026-10-22 00:10 UTC\nsmall\n`<@1>`');
    assert.deepEqual(discordEmbeds([]), '');
  });
});

/** Discord's REST API, in memory. */
function discordApiFake(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v10/, '');
    calls.push(`${init.method || 'GET'} ${path}${u.search}`);
    for (const [re, answer] of routes) {
      const m = re.exec(path);
      if (m) {
        const body = typeof answer === 'function' ? answer(m, u, init) : answer;
        return body === 404 ? new Response('{}', { status: 404 }) : Response.json(body);
      }
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetch };
}

describe('processKey for Discord', () => {
  const realFetch = globalThis.fetch;
  let api;
  beforeEach(() => {
    api = discordApiFake([
      [/^\/channels\/(\d+)$/, (m) => ({ id: m[1], name: 'aem-acme', type: 0 })],
      [/^\/guilds\/\d+$/, { id: G, name: 'Made-up Community' }],
      [/^\/guilds\/\d+\/members\/(\d+)$/, (m) => ({
        nick: m[1] === ADA ? 'Ada (Adobe)' : null,
        roles: m[1] === ADA ? [STAFF_ROLE] : [],
        user: {
          id: m[1], username: m[1] === ADA ? 'ada' : 'cy', global_name: m[1] === ADA ? 'Ada' : 'Cy', avatar: 'abc',
        },
      })],
    ]);
    globalThis.fetch = api.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function env(raw) {
    const queued = [];
    return {
      queued,
      NORMALIZE: { send: async (body, options) => queued.push({ body, options }) },
      RAW: fakeBucket(Object.fromEntries(Object.entries(raw)
        .map(([k, v]) => [k, JSON.stringify(v)]))),
      CHANNELS: fakeBucket(),
      DB: d1({
        rules: [{
          id: 1, target: 'org', priority: 100, source: 'discord', field: 'name', pattern: '^aem-(.+)$', value: '$1',
        }, {
          id: 2, target: 'team', priority: 100, source: 'discord', field: 'group_name', pattern: '^Made-up Community$', value: 'helix',
        }],
        teams: [{ slug: 'helix', name: 'Helix' }],
      }),
      DISCORD_BOT_TOKEN: 'made-up',
      DISCORD_STAFF_ROLES: STAFF_ROLE,
      STAFF_DOMAINS: 'staff.example',
    };
  }

  it('files a conversation by the rules, with staff from their role', async () => {
    const k1 = `discord/${G}/${CH}/2026/10/22/${ROOT}-create.json`;
    const k2 = `discord/${G}/${CH}/2026/10/22/${REPLY}-create.json`;
    const e = env({
      [k1]: { t: 'MESSAGE_CREATE', guild: G, d: msg(ROOT, { content: 'Preview fails for <@400000000000000001>' }) },
      [k2]: {
        t: 'MESSAGE_CREATE',
        guild: G,
        d: msg(REPLY, {
          type: 19, content: 'Looking', author: { id: ADA, username: 'ada' }, message_reference: { message_id: ROOT, channel_id: CH },
        }),
        root: ROOT,
      },
    });
    const r = await quiet(() => processKey(e, k1));
    assert.deepEqual([r.result, r.org, r.team], ['upsert', 'acme', 'helix']);
    await quiet(() => processKey(e, k2));
    const root = parse(e.CHANNELS.objects.get(`channels/acme/helix/discord-${CH}/${ROOT}/${ROOT}.md`).body);
    assert.equal(root.body, 'Preview fails for @Ada (Adobe)');
    assert.deepEqual(root.meta.author, {
      kind: 'person', name: 'Cy', org: null, staff: false,
    });
    const reply = parse(e.CHANNELS.objects.get(`channels/acme/helix/discord-${CH}/${ROOT}/${REPLY}.md`).body);
    assert.deepEqual(reply.meta.author, {
      kind: 'person', name: 'Ada (Adobe)', org: null, staff: true,
    });
    const [t] = e.DB.rows('SELECT * FROM threads');
    assert.deepEqual(
      [t.thread, t.source, t.messages, t.last_staff, t.channel_name],
      [`discord:${G}:${CH}:${ROOT}`, 'discord', 2, 1, 'aem-acme'],
    );
    const [ada] = e.DB.rows(`SELECT * FROM identities WHERE user_id = '${ADA}'`);
    assert.deepEqual([ada.staff, ada.avatar], [1, `https://cdn.discordapp.com/avatars/${ADA}/abc.png?size=96`]);
  });

  it('asks for the history of a thread whose root it has never seen', async () => {
    const thread = {
      id: TH, parent_id: CH, name: 'Old one', type: 11,
    };
    const key = `discord/${G}/${CH}/2026/10/22/${REPLY}-create.json`;
    const e = env({
      [key]: {
        t: 'MESSAGE_CREATE', guild: G, d: msg(REPLY, { channel_id: TH }), thread, root: TH,
      },
    });
    await quiet(() => processKey(e, key));
    const backfill = e.queued.find((q) => q.body.backfill);
    assert.deepEqual(backfill.body.backfill, {
      source: 'discord', tenant: G, channelId: CH, groupId: undefined, rootId: TH, thread: `discord:${G}:${CH}:${TH}`,
    });
  });
});

/** A Durable Object's storage and context, in memory. */
function fakeCtx() {
  const data = new Map();
  let alarm = null;
  const pending = [];
  return {
    data,
    pending,
    storage: {
      get: async (k) => data.get(k),
      put: async (k, v) => {
        data.set(k, v);
      },
      delete: async (k) => data.delete(k),
      getAlarm: async () => alarm,
      setAlarm: async (t) => {
        alarm = t;
      },
    },
    waitUntil: (p) => pending.push(p),
  };
}

describe('DiscordGateway', () => {
  const realFetch = globalThis.fetch;
  let api;
  beforeEach(() => {
    api = discordApiFake([
      [/^\/channels\/(\d+)$/, (m) => (m[1] === TH ? {
        id: TH, parent_id: CH, name: 'A thread', type: 11,
      } : { id: m[1], type: 0 })],
      [/^\/guilds\/\d+\/channels$/, [{ id: CH, type: 0, last_message_id: REPLY }, { id: FORUM, type: 15 }]],
      [/^\/guilds\/\d+\/threads\/active$/, { threads: [] }],
      [/^\/channels\/\d+\/threads\/archived\/public$/, { threads: [], has_more: false }],
      [/^\/channels\/(\d+)\/messages$/, (m, u) => (m[1] === CH && u.searchParams.get('after') !== REPLY
        ? [msg(REPLY, { type: 19, message_reference: { message_id: ROOT, channel_id: CH }, reactions: [{ emoji: { name: '👀' }, count: 1 }] }), msg(ROOT)]
        : [])],
      [/^\/channels\/\d+\/messages\/\d+\/reactions\/.+$/, [{ id: ADA }]],
    ]);
    globalThis.fetch = api.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function gateway() {
    const ctx = fakeCtx();
    const stored = [];
    const env = {
      DISCORD_GUILDS: G,
      DISCORD_BOT_TOKEN: 'made-up',
      // The made-up messages are from 2024.
      DISCORD_HISTORY_DAYS: '10000',
      RAW: { put: async (key, body) => stored.push({ key, envelope: JSON.parse(body) }) },
      NORMALIZE: { send: async () => {} },
      DB: d1(),
    };
    return { gw: new DiscordGateway(ctx, env), ctx, stored };
  }

  it('knows which messages are inline replies', () => {
    const ref = (r) => msg(REPLY, { type: 19, message_reference: r });
    assert.equal(replyTarget(ref({ message_id: ROOT, channel_id: CH })), ROOT);
    // A forward is not a reply, and neither is a reference without the reply type.
    assert.equal(replyTarget(ref({ type: 1, message_id: ROOT })), null);
    assert.equal(replyTarget(msg(REPLY, { message_reference: { message_id: ROOT } })), null);
  });

  it('stores messages with their thread and conversation root, reactions with a time', async () => {
    const { gw, stored, ctx } = gateway();
    await gw.dispatch('GUILD_CREATE', { id: G, channels: [{ id: CH, type: 0 }], threads: [] });
    await gw.dispatch('MESSAGE_CREATE', { ...msg(ROOT), guild_id: G });
    await gw.dispatch('MESSAGE_CREATE', {
      ...msg(REPLY, { type: 19, message_reference: { message_id: ROOT, channel_id: CH } }),
      guild_id: G,
    });
    // A reply to the reply is in the same conversation.
    await gw.dispatch('MESSAGE_CREATE', {
      ...msg(REPLY2, { type: 19, message_reference: { message_id: REPLY, channel_id: CH } }),
      guild_id: G,
    });
    // A thread nobody announced is looked up once.
    await gw.dispatch('MESSAGE_CREATE', { ...msg('1300000000000000030', { channel_id: TH }), guild_id: G });
    await gw.dispatch('MESSAGE_REACTION_ADD', {
      user_id: ADA, channel_id: CH, message_id: ROOT, guild_id: G, emoji: { name: '✅' },
    });
    await gw.dispatch('MESSAGE_DELETE', { id: REPLY2, channel_id: CH, guild_id: G });
    // Other servers are none of opspile's business.
    await gw.dispatch('MESSAGE_CREATE', { ...msg('1300000000000000040'), guild_id: '999' });
    assert.deepEqual(stored.map((s) => s.envelope.root), [ROOT, ROOT, ROOT, TH, undefined, ROOT]);
    assert.deepEqual(stored[3].envelope.thread, {
      id: TH, parent_id: CH, name: 'A thread', type: 11,
    });
    assert.match(stored[3].key, new RegExp(`^discord/${G}/${CH}/`));
    assert.ok(stored[4].envelope.at);
    assert.equal(ctx.data.get(`cursor:${CH}`), REPLY2);
    assert.equal(api.calls.filter((c) => c === `GET /channels/${TH}`).length, 1);
  });

  it('catches up from history after a new session, once per message', async () => {
    const { gw, stored, ctx } = gateway();
    const r = await quiet(() => gw.catchup(G));
    assert.deepEqual([r.channels, r.messages], [2, 2]);
    assert.deepEqual(stored.map((s) => [s.envelope.d.id, s.envelope.via, s.envelope.root]), [
      [ROOT, 'history', ROOT], [REPLY, 'history', ROOT],
    ]);
    assert.deepEqual(stored[1].envelope.reactions, [{ emoji: '👀', users: [ADA] }]);
    assert.equal(ctx.data.get(`cursor:${CH}`), REPLY);
    // Nothing new since: no message fetches.
    const before = api.calls.length;
    await quiet(() => gw.catchup(G));
    assert.ok(!api.calls.slice(before).some((c) => c.startsWith(`GET /channels/${CH}/messages`)));
  });
});
