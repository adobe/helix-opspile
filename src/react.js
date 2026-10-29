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

import { json } from './http.js';
import { isStaffDomain } from './lookup.js';
import { processReaction } from './normalizer.js';
import { personalToken } from './post.js';
import { isResolvedEmoji, RESOLVED_EMOJI } from './resolve.js';
import { teamsOf } from './shares.js';

/**
 * Reacting from the inbox, as the person (their own Slack or Microsoft token, see post.js),
 * and resolving a thread with ✅ on its root message.
 *
 * The platform call is followed by the same bookkeeping a reaction event does (D1, the
 * reactor's watermark, a live update), so the inbox shows the reaction at once; the
 * platform's own event arrives later and changes nothing.
 */

/**
 * The picker's emoji, by Slack name, and what each is on Teams (Teams takes any Unicode
 * emoji as a reaction type).
 */
export const PICKER = {
  white_check_mark: '✅',
  eyes: '👀',
  pray: '🙏',
  '+1': '👍',
  thumbsup: '👍',
  grinning: '😀',
  rocket: '🚀',
  ring_buoy: '🛟',
  heavy_check_mark: '✔️',
  heart: '❤️',
  joy: '😂',
  open_mouth: '😮',
  tada: '🎉',
};
const TEAMS_LEGACY = new Set(['like', 'angry', 'sad', 'laugh', 'heart', 'surprised']);

/**
 * The reaction in the platform's own form: a picker name becomes the Teams emoji; a stored
 * reaction (a chip someone clicked) is already in its platform's form. Null if not valid.
 */
export function nativeEmoji(source, emoji) {
  const e = String(emoji || '').trim();
  if (source === 'slack') {
    return /^[a-z0-9_+'-]{1,60}(::skin-tone-[2-6])?$/.test(e) ? e : null;
  }
  if (Object.hasOwn(PICKER, e)) {
    return PICKER[e];
  }
  if (TEAMS_LEGACY.has(e)) {
    return e;
  }
  return e.length <= 16 && /^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u.test(e)
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e) ? e : null;
}

const SLACK_RECONNECT = ['invalid_auth', 'token_revoked', 'not_authed', 'account_inactive'];

/** One reaction added or removed on the platform. `{ ok }` or `{ error, status, connect? }`. */
async function platformReact(t, groupId, tok, messageId, emoji, removed) {
  if (t.source === 'slack') {
    const res = await fetch(`https://slack.com/api/reactions.${removed ? 'remove' : 'add'}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: t.channel_id, timestamp: messageId, name: emoji }),
    });
    const data = await res.json();
    // Already there, or already gone: the person sees what they asked for.
    if (data.ok || data.error === (removed ? 'no_reaction' : 'already_reacted')) {
      return { ok: true };
    }
    if (data.error === 'missing_scope') {
      return { error: 'connect Slack again to react (opspile now asks for reactions:write)', status: 409, reconnect: 'slack' };
    }
    return {
      error: `Slack: ${data.error}`,
      status: 502,
      connect: SLACK_RECONNECT.includes(data.error) ? 'slack' : undefined,
    };
  }
  if (!groupId) {
    return { error: 'the Teams team of this channel is not known yet', status: 409 };
  }
  const reply = messageId === t.root_id ? '' : `/replies/${encodeURIComponent(messageId)}`;
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(t.channel_id)}`
    + `/messages/${encodeURIComponent(t.root_id)}${reply}/${removed ? 'unsetReaction' : 'setReaction'}`;
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reactionType: emoji }),
  });
  if (res.ok) {
    return { ok: true };
  }
  const data = await res.json().catch(() => ({}));
  return {
    error: `Teams: ${(data.error && data.error.code) || res.status}`,
    status: 502,
    connect: res.status === 401 ? 'teams' : undefined,
    reconnect: res.status === 403 ? 'teams' : undefined,
  };
}

const THREAD = `SELECT t.*, c.group_id FROM threads t LEFT JOIN channels c
  ON c.source = t.source AND c.tenant = t.tenant AND c.channel_id = t.channel_id`;

/** The person's token for the thread's platform, or the response that explains why not. */
async function tokenFor(env, me, t) {
  if (!isStaffDomain(env, me.email)) {
    return { response: json({ error: 'only staff can react' }, 403) };
  }
  if (t.source === 'discord') {
    // Discord lets only bots react through its API, and opspile acts as the person or not at all.
    return { response: json({ error: 'react in Discord: opspile cannot react there as you' }, 409) };
  }
  const tok = await personalToken(env, me.id, t.source);
  if (!tok) {
    const name = t.source === 'slack' ? 'Slack' : 'Microsoft';
    return { response: json({ error: `connect your ${name} account first`, connect: t.source }, 409) };
  }
  if (t.source === 'slack' && !tok.scope.split(/[\s,]+/).includes('reactions:write')) {
    return {
      response: json({
        error: 'connect Slack again to react (opspile now asks for reactions:write)', reconnect: 'slack',
      }, 409),
    };
  }
  return { tok };
}

/**
 * Adds or removes one reaction on the platform as the person, then records it like the
 * platform's event would. An add is timed after the platform accepted it, so it is newer
 * than a removal just before it; a removal made here always removes.
 */
async function reactAs(env, t, tok, messageId, emoji, removed) {
  const done = await platformReact(t, t.group_id, tok, messageId, emoji, removed);
  if (!done.ok) {
    return done;
  }
  const at = removed ? null : new Date().toISOString();
  await processReaction(env, 'inbox', {
    source: t.source,
    tenant: t.tenant,
    channelId: t.channel_id,
    id: messageId,
    emoji,
    userId: tok.userId,
    at,
    removed,
  });
  return done;
}

/** The person's "resolved" reactions on a thread's first message. */
async function mineResolvedOn(env, t, tok) {
  const { results: rows } = await env.DB.prepare(`SELECT emoji FROM reactions
    WHERE message = ? AND user_key = ?`)
    .bind(`${t.source}:${t.tenant}:${t.channel_id}:${t.root_id}`, `${t.source}:${t.tenant}:${tok.userId}`)
    .all();
  return (rows || []).map((r) => r.emoji).filter(isResolvedEmoji);
}

const failed = (r) => json({
  error: r.error, connect: r.connect, reconnect: r.reconnect,
}, r.status || 502);

/**
 * POST /api/react `{ thread, id, emoji, remove? }`: adds (or removes) a reaction on one
 * message, as the signed-in person. `thread` is the message's platform thread, `emoji` a
 * picker name or a reaction as the inbox shows it.
 */
export async function react(env, me, request, inTeam) {
  const {
    thread: key, id, emoji, remove,
  } = request || {};
  const t = key && await env.DB.prepare(`${THREAD} WHERE t.thread = ?`).bind(key).first();
  if (!t || !await inTeam(await teamsOf(env, t), t)) {
    return json({ error: 'not found' }, 404);
  }
  const msg = await env.DB.prepare('SELECT id FROM messages WHERE thread = ? AND id = ? AND deleted = 0')
    .bind(key, String(id || '')).first();
  if (!msg) {
    return json({ error: 'not found' }, 404);
  }
  const native = nativeEmoji(t.source, emoji);
  if (!native) {
    return json({ error: 'not a reaction' }, 400);
  }
  const { tok, response } = await tokenFor(env, me, t);
  if (response) {
    return response;
  }
  const done = await reactAs(env, t, tok, msg.id, native, Boolean(remove));
  if (!done.ok) {
    return failed(done);
  }
  // A ✅ on a reply is also put on the thread's first message, which is what the channel
  // shows (and what makes the thread resolved); taking it off a reply takes yours off there.
  if (isResolvedEmoji(native) && msg.id !== t.root_id && t.root_at) {
    const root = remove ? await mineResolvedOn(env, t, tok) : [RESOLVED_EMOJI[t.source]];
    for (const e of root) {
      // eslint-disable-next-line no-await-in-loop
      const also = await reactAs(env, t, tok, t.root_id, e, Boolean(remove));
      if (!also.ok) {
        return failed(also);
      }
    }
  }
  return json({ ok: true, emoji: native });
}

/**
 * POST /api/resolve `{ thread, undo? }`: ✅ on the root message of the entry's latest
 * platform thread, as the signed-in person; `undo` takes the person's ✅ off every root of
 * the entry again. Resolving a reopened thread the person had resolved before moves their
 * ✅ (off and on again), so it is newer than the customer's message.
 */
export async function resolve(env, me, request, inTeam) {
  const { thread: key, undo } = request || {};
  const { results } = key ? await env.DB.prepare(`${THREAD}
    WHERE t.thread = ? OR t.logical_thread = ? ORDER BY t.any_at DESC`).bind(key, key).all()
    : { results: [] };
  const members = results || [];
  if (!members.length || !await inTeam(await teamsOf(env, members[0]), members[0])) {
    return json({ error: 'not found' }, 404);
  }
  const { tok, response } = await tokenFor(env, me, members[0]);
  if (response) {
    return response;
  }
  const mineOn = (t) => mineResolvedOn(env, t, tok);
  if (undo) {
    let removed = 0;
    for (const t of members) {
      // eslint-disable-next-line no-await-in-loop
      for (const emoji of await mineOn(t)) {
        // eslint-disable-next-line no-await-in-loop
        const done = await reactAs(env, t, tok, t.root_id, emoji, true);
        if (!done.ok) {
          return failed(done);
        }
        removed += 1;
      }
    }
    return removed ? json({ ok: true, resolved: false })
      : json({ error: 'you have not resolved this thread; only whoever did can undo it' }, 409);
  }
  const t = members.find((m) => m.root_at);
  if (!t) {
    return json({ error: 'the first message of this thread is not known yet' }, 409);
  }
  const emoji = RESOLVED_EMOJI[t.source];
  for (const old of await mineOn(t)) {
    // eslint-disable-next-line no-await-in-loop
    const done = await reactAs(env, t, tok, t.root_id, old, true);
    if (!done.ok) {
      return failed(done);
    }
  }
  const done = await reactAs(env, t, tok, t.root_id, emoji, false);
  return done.ok ? json({ ok: true, resolved: true }) : failed(done);
}
