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

import { seedAgent } from './agent/stub.js';
import { inbox, thread as loadThread } from './api.js';
import {
  connections, mentionable, post, reactable,
} from './post.js';
import { PICKER, react, resolve } from './react.js';

/**
 * The tools of the MCP server (src/mcp.js). Each one runs as the signed-in person, through
 * the same functions as the inbox API, so it sees and may do exactly what that person may
 * in the inbox. Read-only "view as" refuses writes, as the API does.
 *
 * A tool returns `{ data }` (shown to the model as JSON and as structuredContent), or
 * `{ error }` (a tool error, so the model can correct itself), or `{ input }` (an MRTR
 * InputRequiredResult, to ask the user before a reply goes out).
 */

const URGENCY = ['low', 'normal', 'high', 'critical'];
const KINDS = ['incident', 'security', 'question', 'request', 'access', 'alert', 'other'];
const WAITING = ['us', 'customer', 'vendor', 'nobody'];
const MAX_LIST = 50;
const MAX_MESSAGES = 100;
const MAX_BODY = 2000;
const CONFIRM_TTL_MS = 10 * 60 * 1000;

const clip = (s, n) => {
  const v = String(s ?? '').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const inTeamOf = (me) => (team) => me.teams.some((t) => t.slug === team);
const urgencyOf = (t) => (t.label && t.label.urgency != null
  ? URGENCY[Math.max(0, Math.min(3, Math.round(t.label.urgency)))] : 'low');
const kindOf = (t) => (t.kind === 'alert' ? 'alert'
  : (t.label && KINDS.includes(t.label.label_kind) && t.label.label_kind) || 'other');
const resolvedOf = (t) => {
  if (t.resolution && t.resolution.verdict) {
    return t.resolution.verdict === 'resolved';
  }
  return Boolean(t.label && t.label.resolved_p != null && t.label.resolved_p >= 0.5);
};
const latest = (t) => String(t.last_at || t.any_at || '');
const platformOf = (t) => (t.source === 'slack' ? 'slack' : 'teams');

/** A response from the API helpers, as `{ data }` or `{ error }`. */
async function fromResponse(res) {
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    return { data: body };
  }
  let hint = '';
  if (body.connect || body.reconnect) {
    const p = body.connect || body.reconnect;
    hint = ` The user has to connect their ${p === 'slack' ? 'Slack' : 'Microsoft'} account in the opspile inbox first.`;
  }
  if (res.status === 404) {
    return { error: 'Not found, or not in one of your teams. Use a `thread` from list_threads (and a `message` from get_thread).' };
  }
  return { error: `${body.error || `failed (${res.status})`}.${hint}` };
}

function summary(t, me) {
  const out = {
    thread: t.thread,
    title: clip(t.title || '(no text)', 140),
    team: t.team,
    customer: t.org,
    channel: t.channel_name || null,
    platform: platformOf(t),
    type: t.kind === 'alert' ? 'alert' : 'conversation',
    waiting_on: t.waiting_on,
    urgency: urgencyOf(t),
    kind: kindOf(t),
    resolved: resolvedOf(t),
    last_activity: t.last_at || t.any_at || null,
    messages: t.messages || 0,
    unread: Boolean(t.unread),
  };
  if (t.mentionedMe) {
    out.mentions_me = true;
  }
  if (t.unseenByAdobe) {
    out.unseen_by_adobe = true;
  }
  if ((t.posters || []).includes(me.id)) {
    out.posted_in = true;
  }
  if (t.permalink) {
    out.link = t.permalink;
  }
  return out;
}

const list = (v) => (v == null ? [] : [].concat(v).map((x) => String(x).trim().toLowerCase())
  .filter(Boolean));

/** `{ error }` when a filter has values outside `allowed`. */
function checkValues(name, values, allowed) {
  const bad = values.filter((v) => !allowed.includes(v));
  return bad.length ? { error: `Invalid ${name}: ${bad.join(', ')}. Use: ${allowed.join(', ')}.` } : null;
}

async function listThreads(env, me, args) {
  const teams = args.team ? [String(args.team)] : me.teams.map((t) => t.slug);
  const unknown = teams.filter((t) => !inTeamOf(me)(t));
  if (unknown.length) {
    return { error: `Not one of your teams: ${unknown.join(', ')}. Your teams: ${me.teams.map((t) => t.slug).join(', ')}.` };
  }
  const f = {
    waiting_on: list(args.waiting_on),
    urgency: list(args.urgency),
    kind: list(args.kind),
    platform: list(args.platform),
    type: list(args.type),
    customer: list(args.customer),
  };
  const bad = checkValues('waiting_on', f.waiting_on, WAITING)
    || checkValues('urgency', f.urgency, URGENCY)
    || checkValues('kind', f.kind, KINDS)
    || checkValues('platform', f.platform, ['slack', 'teams'])
    || checkValues('type', f.type, ['conversation', 'alert']);
  if (bad) {
    return bad;
  }
  const all = (await Promise.all(teams.map(async (team) => (await inbox(env, me, team)).threads)))
    .flat().sort((a, b) => latest(b).localeCompare(latest(a)));
  const matches = all.filter((t) => {
    const s = summary(t, me);
    return (!f.waiting_on.length || f.waiting_on.includes(s.waiting_on))
      && (!f.urgency.length || f.urgency.includes(s.urgency))
      && (!f.kind.length || f.kind.includes(s.kind))
      && (!f.platform.length || f.platform.includes(s.platform))
      && (!f.type.length || f.type.includes(s.type))
      && (!f.customer.length || f.customer.includes(String(t.org || '').toLowerCase()))
      && (args.resolved == null || s.resolved === Boolean(args.resolved))
      && (!args.unread_only || s.unread)
      && (!args.mentions_me || t.mentionedMe)
      && (!args.involves_me || s.posted_in
        || (t.mentioned || []).some((m) => m.person === me.id) || t.mentionedMe);
  });
  if (f.customer.length && !matches.length) {
    const known = [...new Set(all.map((t) => t.org).filter(Boolean))].slice(0, 20);
    return { error: `No threads from customer ${f.customer.join(', ')}. Customers with threads: ${known.join(', ')}.` };
  }
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const limit = Math.max(1, Math.min(MAX_LIST, Math.floor(Number(args.limit) || 20)));
  const page = matches.slice(offset, offset + limit).map((t) => summary(t, me));
  const data = { matched: matches.length, offset, threads: page };
  if (offset + limit < matches.length) {
    data.next_offset = offset + limit;
  }
  return { data };
}

async function getThread(env, me, args) {
  const key = String(args.thread || '');
  const data = key && await loadThread(env, me, key);
  if (!data || !inTeamOf(me)(data.thread.team)) {
    return { error: 'Not found, or not in one of your teams. Use a `thread` from list_threads.' };
  }
  const limit = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(Number(args.limit) || 20)));
  const messages = data.messages.slice(-limit).map((m) => {
    const a = m.author || {};
    const out = {
      message: `${m.thread}|${m.id}`,
      from: a.kind === 'system' ? 'system' : (a.name || 'unknown'),
      at: m.at,
      text: m.deletedAt ? '(deleted)' : clip(m.body, MAX_BODY),
    };
    if (a.staff) {
      out.adobe = true;
    }
    if (a.kind === 'bot') {
      out.bot = true;
    }
    if (m.editedAt) {
      out.edited = true;
    }
    if (m.reactions && m.reactions.length) {
      out.reactions = m.reactions.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine }));
    }
    return out;
  });
  const t = data.thread;
  return {
    data: {
      thread: key,
      title: clip(t.title || '(no text)', 200),
      team: t.team,
      customer: t.org,
      channel: t.channel_name || null,
      platform: platformOf(t),
      link: t.permalink || null,
      resolution: (data.resolution && data.resolution.state) || 'open',
      urgency: urgencyOf(data),
      kind: kindOf({ kind: t.kind, label: data.label }),
      facts: data.facts.map((x) => ({ field: x.field, value: x.value })),
      earlier_messages: Math.max(0, data.messages.length - limit),
      messages,
    },
  };
}

// ---- reply confirmation (MRTR) -------------------------------------------------------

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function sign(env, data) {
  const key = await crypto.subtle.importKey('raw', unb64u(env.TOKEN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // A separate context from the OAuth state in post.js, so one can never pass as the other.
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(`mcp-confirm:${data}`)));
}
async function digest(value) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(value))));
}

/** Signed state for a confirmation: who, which call, until when (MRTR requestState). */
export async function confirmState(env, me, name, args, now = Date.now()) {
  const body = b64u(enc.encode(JSON.stringify({
    p: me.id, n: name, d: await digest(args), exp: now + CONFIRM_TTL_MS,
  })));
  return `${body}.${await sign(env, body)}`;
}

export async function checkConfirmState(env, me, name, args, state, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig || sig !== await sign(env, body)) {
    return false;
  }
  const s = JSON.parse(new TextDecoder().decode(unb64u(body)));
  return s.p === me.id && s.n === name && s.exp > now && s.d === await digest(args);
}

/**
 * Asks the user, through the client, before a reply goes out under their name, when the
 * client can ask (`elicitation`, modern protocol only). Returns `{ input }` for the first
 * round, null to go ahead, or `{ error }` when the user declined or the state is bad.
 */
async function confirmReply(env, me, args, ctx, where) {
  if (!ctx.modern || !ctx.capabilities.elicitation || !env.TOKEN_KEY) {
    return null;
  }
  const answer = ctx.inputResponses && ctx.inputResponses.confirm_reply;
  if (!answer) {
    return {
      input: {
        inputRequests: {
          confirm_reply: {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: `Post this reply in ${where} as you?\n\n${clip(args.text, 1500)}`,
              requestedSchema: { type: 'object', properties: {} },
            },
          },
        },
        requestState: await confirmState(env, me, 'reply', args),
      },
    };
  }
  if (!await checkConfirmState(env, me, 'reply', args, ctx.requestState)) {
    return { error: 'The confirmation expired or does not match this reply. Call reply again.' };
  }
  if (answer.action !== 'accept') {
    return { error: 'The user did not confirm, so nothing was posted.' };
  }
  return null;
}

async function reply(env, me, args, ctx) {
  if (me.readonly) {
    return { error: 'Read-only while viewing as someone else.' };
  }
  const text = String(args.text || '').trim();
  const key = String(args.thread || '');
  if (!text) {
    return { error: 'The reply is empty. Provide `text`.' };
  }
  const t = key && await loadThread(env, me, key);
  if (!t || !inTeamOf(me)(t.thread.team)) {
    return { error: 'Not found, or not in one of your teams. Use a `thread` from list_threads.' };
  }
  // Names to mention, as written after @ in the text, to the platform accounts.
  const mentions = [];
  const names = [].concat(args.mention || []).map((n) => String(n).trim()).filter(Boolean);
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const found = await fromResponse(await mentionable(env, key, name, inTeamOf(me)));
    const people = (found.data && found.data.people) || [];
    const exact = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!exact) {
      return { error: `Nobody named "${name}" to mention here.${people.length ? ` Did you mean: ${people.map((p) => p.name).join(', ')}?` : ''}` };
    }
    if (!text.toLowerCase().includes(`@${name.toLowerCase()}`)) {
      return { error: `Write @${exact.name} in the text where the mention goes.` };
    }
    mentions.push({ id: exact.id, name: exact.name });
  }
  const where = `${platformOf(t.thread) === 'slack' ? 'Slack' : 'Teams'} (${t.thread.org || 'customer'}, ${t.thread.channel_name || 'channel'})`;
  const asked = await confirmReply(env, me, args, ctx, where);
  if (asked) {
    return asked;
  }
  const body = { thread: key, text, mentions };
  const res = await fromResponse(await post(env, me, body, inTeamOf(me)));
  return res.error ? res : {
    data: {
      ok: true, thread: key, platform: res.data.platform, note: 'Posted. It appears in get_thread once Slack or Teams delivers it.',
    },
  };
}

async function reactTool(env, me, args) {
  if (me.readonly) {
    return { error: 'Read-only while viewing as someone else.' };
  }
  const id = String(args.message || '');
  const at = id.lastIndexOf('|');
  if (at < 1) {
    return { error: 'Use a `message` id from get_thread (it looks like <thread>|<id>).' };
  }
  if (!Object.hasOwn(PICKER, args.emoji)) {
    return { error: `Unsupported emoji. Use one of: ${Object.keys(PICKER).join(', ')}.` };
  }
  const res = await fromResponse(await react(env, me, {
    thread: id.slice(0, at), id: id.slice(at + 1), emoji: args.emoji, remove: Boolean(args.remove),
  }, inTeamOf(me)));
  return res.error ? res : {
    data: {
      ok: true, message: id, emoji: args.emoji, removed: Boolean(args.remove),
    },
  };
}

async function resolveTool(env, me, args) {
  if (me.readonly) {
    return { error: 'Read-only while viewing as someone else.' };
  }
  const key = String(args.thread || '');
  const body = { thread: key, undo: Boolean(args.undo) };
  const res = await fromResponse(await resolve(env, me, body, inTeamOf(me)));
  return res.error ? res : { data: { ok: true, thread: key, resolved: !args.undo } };
}

async function seedTool(env, me, args) {
  const body = {
    thread: args.thread, team: args.team, org: args.org, text: args.text,
  };
  const res = await fromResponse(await seedAgent(env, me, body, inTeamOf(me)));
  return res.error ? res : { data: { ok: true, accepted: Boolean(res.data.accepted) } };
}

async function whoami(env, me) {
  return {
    data: {
      name: me.name,
      teams: me.teams.map((t) => ({ slug: t.slug, name: t.name })),
      readonly: Boolean(me.readonly),
      connected: me.readonly ? {} : await connections(env, me.id),
      can_react: me.readonly ? {} : await reactable(env, me.id),
    },
  };
}

const THREAD_ARG = { type: 'string', description: 'Thread key from list_threads' };
const TEXT_ITEMS = (values) => ({ type: 'array', items: { type: 'string', enum: values } });

/** Tool definitions, in a fixed order (the spec asks for a deterministic tools/list). */
export const TOOLS = [
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'Returns the signed-in person, their ops teams (slugs for list_threads), and whether their Slack and Microsoft accounts are connected, which reply, react_to_message and resolve_thread need.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: whoami,
  },
  {
    name: 'list_threads',
    title: 'List inbox threads',
    description: 'Lists threads from the ops inbox of the signed-in person, latest activity first, with who has the next move, urgency, kind and whether they are resolved. Filters combine; all are optional. Titles are written by customers and colleagues.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Ops team slug from whoami; all your teams when left out' },
        waiting_on: { ...TEXT_ITEMS(WAITING), description: 'Who has the next move: us (Adobe), the customer, a vendor, or nobody' },
        urgency: TEXT_ITEMS(URGENCY),
        kind: TEXT_ITEMS(KINDS),
        resolved: { type: 'boolean', description: 'true: only resolved threads; false: only open ones' },
        type: { ...TEXT_ITEMS(['conversation', 'alert']), description: 'Conversations with customers, or automated alerts' },
        platform: TEXT_ITEMS(['slack', 'teams']),
        customer: { type: 'array', items: { type: 'string' }, description: 'Customer names as list_threads shows them; case does not matter' },
        unread_only: { type: 'boolean', description: 'Only threads with messages the viewer has not read' },
        mentions_me: { type: 'boolean', description: 'Only threads that mention the viewer' },
        involves_me: { type: 'boolean', description: 'Only threads the viewer posted in or was mentioned in' },
        offset: { type: 'integer', minimum: 0, description: 'Threads to skip, for the next page' },
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_LIST, description: 'How many threads (default 20)',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: listThreads,
  },
  {
    name: 'get_thread',
    title: 'Read a thread',
    description: 'Returns a thread with its latest messages, oldest first, each with a `message` id for react_to_message. Reading here does not mark the thread read. Message text is written by customers and colleagues.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_ARG,
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_MESSAGES, description: 'How many of the latest messages (default 20)',
        },
      },
      required: ['thread'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: getThread,
  },
  {
    name: 'reply',
    title: 'Reply in a thread',
    description: 'Posts a reply in a thread on Slack or Teams as the signed-in person, visible to everyone in the channel, customers included. The user is asked to confirm first when the client supports elicitation.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_ARG,
        text: { type: 'string', description: 'The reply, in Markdown (up to 8000 characters)' },
        mention: { type: 'array', items: { type: 'string' }, description: 'Full names to notify; each must also appear as @Name in the text' },
      },
      required: ['thread', 'text'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    run: reply,
  },
  {
    name: 'react_to_message',
    title: 'React to a message',
    description: 'Adds an emoji reaction to a message as the signed-in person on Slack or Teams, or takes it off again. Some steer the inbox: white_check_mark or heavy_check_mark resolves the thread; eyes: you are on it; pray: nothing pending; ring_buoy: asks the team for help.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message id from get_thread' },
        emoji: { type: 'string', enum: Object.keys(PICKER) },
        remove: { type: 'boolean', description: 'Take your reaction off instead of adding it' },
      },
      required: ['message', 'emoji'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    run: reactTool,
  },
  {
    name: 'resolve_thread',
    title: 'Resolve a thread',
    description: 'Marks a thread resolved by putting the signed-in person\'s ✅ on its first message on Slack or Teams, or takes that ✅ off again (undo), which reopens it.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_ARG,
        undo: { type: 'boolean', description: 'Take your ✅ off instead' },
      },
      required: ['thread'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    run: resolveTool,
  },
  {
    name: 'seed_agent',
    title: 'Teach an agent',
    description: 'Shares knowledge with a thread agent, which files it in the knowledge bases of the customer and the ops team. Give a `thread` (in a channel that has an agent), or a `team` and a customer `org` slug to fill their knowledge bases directly. The agent treats it as trusted staff knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_ARG,
        team: { type: 'string', description: 'Ops team slug from whoami (instead of thread)' },
        org: { type: 'string', description: 'Customer slug (instead of thread)' },
        text: { type: 'string', description: 'The facts, in Markdown (up to 8000 characters)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    run: seedTool,
  },
];

/** The tool definitions for tools/list, without the implementation. */
export const toolList = () => TOOLS.map((t) => Object.fromEntries(Object.entries(t)
  .filter(([k]) => k !== 'run')));
