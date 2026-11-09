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
const { DiscordPoller, replyTarget } = await import('../src/poller.js');

// Made-up ids and names only.
const G = '100000000000000001';
const CH = '200000000000000002';
const FORUM = '200000000000000003';
const ROOT = '1300000000000000010';
const REPLY = '1300000000000000011';
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
  it('files an envelope under the channel and day, the same state under the same key', async () => {
    const d = msg(ROOT);
    const day = new Date(snowflakeMs(ROOT)).toISOString().slice(0, 10).replace(/-/g, '/');
    const key = await discordKey({ t: 'MESSAGE_CREATE', guild: G, d });
    assert.match(key, new RegExp(`^discord/${G}/${CH}/${day}/${ROOT}-[0-9a-f]{16}\\.json$`));
    assert.equal(key, await discordKey({
      t: 'MESSAGE_CREATE', via: 'history', guild: G, d,
    }));
    assert.notEqual(key, await discordKey({ t: 'MESSAGE_CREATE', guild: G, d: { ...d, content: 'edited' } }));
    // A thread's messages are filed under its parent channel.
    const thread = {
      id: TH, parent_id: FORUM, name: 'Help', type: 11,
    };
    assert.match(await discordKey({
      t: 'MESSAGE_CREATE', guild: G, d: msg(TH, { channel_id: TH }), thread,
    }), new RegExp(`^discord/${G}/${FORUM}/`));
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

  it('reads deletions, and reactions with the time they were first seen', () => {
    const del = normalizeDiscord('k', {
      t: 'MESSAGE_DELETE', guild: G, d: { id: REPLY, channel_id: CH }, root: ROOT, at: '2026-10-22T00:00:00.000Z',
    });
    assert.deepEqual(
      [del.op, del.message.thread, del.message.deletedAt],
      ['delete', `discord:${G}:${CH}:${ROOT}`, '2026-10-22T00:00:00.000Z'],
    );
    const op = normalizeDiscord('k', {
      t: 'MESSAGE_CREATE',
      via: 'history',
      guild: G,
      d: msg(ROOT),
      reactions: [{ emoji: '✅', users: [ADA, CY], at: { [ADA]: '2026-10-22T00:00:00.000Z', [CY]: null } }],
    });
    assert.deepEqual(op.message.reactions, [
      { emoji: '✅', userId: ADA, at: '2026-10-22T00:00:00.000Z' }, { emoji: '✅', userId: CY, at: undefined },
    ]);
    assert.deepEqual(op.message.reactors, [ADA, CY]);
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
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    waitUntil: (p) => pending.push(p),
  };
}

describe('DiscordPoller', () => {
  const realFetch = globalThis.fetch;
  // A server in memory, with messages from the last hour.
  const base = BigInt(snowflakeAt(Date.now() - 60 * 60 * 1000));
  const id = (n) => String(base + BigInt(n) * 4194304000n);
  const [M1, M2, M3, T1, M4] = [1, 2, 3, 4, 5].map(id);
  let server;
  let api;
  const ofChannel = (c) => server.messages.filter((m) => m.channel_id === c);
  const last = (c) => ofChannel(c).map((m) => m.id).sort().pop() || null;
  beforeEach(() => {
    server = {
      messages: [
        msg(M1),
        msg(M2, { type: 19, message_reference: { message_id: M1, channel_id: CH } }),
      ],
      threads: [],
      reactors: {},
    };
    api = discordApiFake([
      [/^\/guilds\/\d+\/channels$/, () => [
        { id: CH, type: 0, last_message_id: last(CH) }, { id: FORUM, type: 15 },
      ]],
      [/^\/guilds\/\d+\/threads\/active$/, () => ({
        threads: server.threads.map((t) => ({ ...t, last_message_id: last(t.id) })),
      })],
      [/^\/channels\/\d+\/threads\/archived\/public$/, { threads: [], has_more: false }],
      [/^\/channels\/(\d+)\/messages$/, (m, u) => ofChannel(m[1])
        .filter((x) => BigInt(x.id) > BigInt(u.searchParams.get('after'))).reverse()],
      [/^\/channels\/\d+\/messages\/(\d+)\/reactions\/.+$/, (m) => (server.reactors[m[1]] || []).map((u) => ({ id: u }))],
      [/^\/channels\/(\d+)$/, (m) => ({ id: m[1], type: 0 })],
    ]);
    globalThis.fetch = api.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function poller() {
    const ctx = fakeCtx();
    const stored = [];
    const env = {
      DISCORD_GUILDS: G,
      DISCORD_BOT_TOKEN: 'made-up',
      RAW: { put: async (key, body) => stored.push({ key, envelope: JSON.parse(body) }) },
      NORMALIZE: { send: async () => {} },
      DB: d1(),
    };
    return { p: new DiscordPoller(ctx, env), ctx, stored };
  }

  it('knows which messages are inline replies', () => {
    const ref = (r) => msg(REPLY, { type: 19, message_reference: r });
    assert.equal(replyTarget(ref({ message_id: ROOT, channel_id: CH })), ROOT);
    // A forward is not a reply, and neither is a reference without the reply type.
    assert.equal(replyTarget(ref({ type: 1, message_id: ROOT })), null);
    assert.equal(replyTarget(msg(REPLY, { message_reference: { message_id: ROOT } })), null);
  });

  it('polls the guilds after one that keeps failing', async () => {
    const { p, ctx } = poller();
    const BAD = '999999999999999999';
    const { fetch } = api;
    const asked = [];
    p.env.DISCORD_GUILDS = `${BAD},${G}`;
    globalThis.fetch = async (url, init) => {
      asked.push(String(url));
      return String(url).includes(`/guilds/${BAD}/`)
        ? Response.json({ code: 50001 }, { status: 403 }) : fetch(url, init);
    };
    const out = await quiet(() => p.poll());
    assert.equal(out.messages, 2);
    assert.match(out.error, /discord 403/);
    assert.ok(asked.some((u) => u.includes(`/guilds/${G}/channels`)));
    assert.deepEqual(await ctx.storage.get('last'), out);
  });

  it('adds up what it found in every guild, and names each one that failed', async () => {
    const { p, ctx } = poller();
    const [SECOND, BAD, WORSE] = ['888888888888888888', '999999999999999999', '777777777777777777'];
    const { fetch } = api;
    p.env.DISCORD_GUILDS = `${BAD},${G},${WORSE},${SECOND}`;
    const refused = (url) => [BAD, WORSE].some((g) => String(url).includes(`/guilds/${g}/`));
    globalThis.fetch = async (url, init) => (refused(url)
      ? Response.json({ code: 50001 }, { status: 403 }) : fetch(url, init));
    const out = await quiet(() => p.poll());
    // The second good guild lists the same channel: its channels add up, its messages are read.
    assert.equal(out.channels, 4);
    assert.equal(out.messages, 2);
    assert.match(out.error, new RegExp(`^${BAD}: .*; ${WORSE}: `));
    assert.deepEqual(await ctx.storage.get('last'), out);
  });

  it('reads history once, then only what is new: two requests when nothing happened', async () => {
    const { p, stored } = poller();
    const first = await quiet(() => p.poll());
    assert.equal(first.messages, 2);
    assert.deepEqual(stored.map((s) => [s.envelope.d.id, s.envelope.root]), [[M1, M1], [M2, M1]]);
    const before = api.calls.length;
    await quiet(() => p.poll());
    assert.deepEqual(api.calls.slice(before), [
      `GET /guilds/${G}/channels`, `GET /guilds/${G}/threads/active`,
    ]);
    // A reply to the reply, and a thread started from it: one conversation.
    const toM2 = { message_id: M2, channel_id: CH };
    server.messages.push(msg(M3, { type: 19, message_reference: toM2 }));
    server.threads.push({
      id: M3, parent_id: CH, name: 'Follow-up', type: 11,
    });
    server.messages.push(msg(M4, { channel_id: M3 }));
    const third = await quiet(() => p.poll());
    assert.equal(third.messages, 2);
    const where = ({ envelope: e }) => [e.d.id, e.root, e.thread && e.thread.id];
    assert.deepEqual(stored.slice(2).map(where), [
      [M3, M1, undefined], [M4, M1, M3],
    ]);
    assert.ok(!stored.some((s) => s.envelope.d.id === T1));
  });

  it('finds edits, reactions and deletions when it reads the last day again', async () => {
    const { p, stored } = poller();
    await quiet(() => p.poll());
    const n = stored.length;
    await quiet(() => p.poll({ recheck: true }));
    assert.equal(stored.length, n, 'nothing changed, nothing stored');
    server.messages[0] = { ...server.messages[0], reactions: [{ emoji: { name: '✅' }, count: 1 }] };
    server.reactors[M1] = [ADA];
    server.messages[1] = { ...server.messages[1], content: 'fixed typo', edited_timestamp: new Date().toISOString() };
    const r = await quiet(() => p.poll({ recheck: true }));
    assert.equal(r.changed, 2);
    const [reacted, edited] = stored.slice(n).map((s) => s.envelope);
    assert.deepEqual([reacted.d.id, reacted.reactions[0].emoji, reacted.reactions[0].users], [M1, '✅', [ADA]]);
    assert.ok(reacted.reactions[0].at[ADA], 'a new reaction is timed');
    assert.deepEqual([edited.d.id, edited.reactions], [M2, undefined]);
    // The ✅ keeps its time when someone else reacts; the reply is deleted.
    const firstSeen = reacted.reactions[0].at[ADA];
    server.messages[0] = { ...server.messages[0], reactions: [{ emoji: { name: '✅' }, count: 2 }] };
    server.reactors[M1] = [ADA, CY];
    server.messages.splice(1, 1);
    await quiet(() => p.poll({ recheck: true }));
    const [again, gone] = stored.slice(n + 2).map((s) => s.envelope);
    assert.equal(again.reactions[0].at[ADA], firstSeen);
    assert.deepEqual([gone.t, gone.d.id, gone.root], ['MESSAGE_DELETE', M2, M1]);
  });

  it('keeps its alarm set while Discord is on', async () => {
    const { p, ctx } = poller();
    const r = await p.ensure();
    assert.equal(r.state, 'on');
    assert.ok(await ctx.storage.getAlarm());
  });
});
