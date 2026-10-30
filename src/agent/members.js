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

import { rankMentions } from '../mention-match.js';
import { MAX_MEMBERS_LISTED, refreshMembers } from '../suggest.js';

/**
 * Who is in a thread's channel (on Teams, in its Teams team), for the agent: `findMember`
 * answers its question, `mentionedOutside` tells it about a mention of someone who is not in.
 *
 * Both only go by a complete list of members from the platform. Without one nobody can be said
 * to be out, so they say that nothing is known: the `member` of the mention suggestions, which
 * is also true of whoever posted, is no use here.
 */

// A list this old is listed again before it decides anything.
const FRESH_MS = 60 * 60 * 1000;
const MAX_MATCHES = 10;
const MAX_NAME = 80;

/**
 * The members of `where` (`{ source, tenant, channelId }`) as `{ members, at, place }`, or
 * `{ why }` when there is no list to go by. With `fresh`, a list over an hour old (or a failure
 * that old) is listed again first.
 */
async function roster(env, where, { now = Date.now(), fresh = false, ...deps } = {}) {
  const key = [where.source, where.tenant, where.channelId];
  const channel = () => env.DB.prepare(`SELECT * FROM channels
    WHERE source = ? AND tenant = ? AND channel_id = ?`).bind(...key).first();
  let ch = await channel();
  if (!ch) {
    return { why: 'opspile does not know this channel' };
  }
  if (ch.source === 'teams' && ch.shared) {
    // Lists the Teams team, and people from other teams and tenants are in a shared channel.
    return { why: 'this is a shared channel, and only its team\'s members are listed' };
  }
  if (fresh && (!ch.members_at || Date.parse(ch.members_at) < now - FRESH_MS)) {
    await refreshMembers(env, ch, deps, now);
    ch = await channel();
  }
  if (ch.members_error) {
    return { why: `its members could not be listed (${ch.members_error})` };
  }
  const { results } = await env.DB.prepare(`SELECT user_id, email, name FROM channel_members
    WHERE source = ? AND tenant = ? AND channel_id = ?`).bind(...key).all();
  const members = results || [];
  if (!members.length) {
    return { why: 'its members have not been listed' };
  }
  if (members.length >= MAX_MEMBERS_LISTED) {
    return { why: `it has more members than opspile lists (${MAX_MEMBERS_LISTED})` };
  }
  return {
    members, at: ch.members_at, place: ch.source === 'teams' ? 'Teams team' : 'channel',
  };
}

/**
 * The members of the channel that match `query`, a name as in the mention suggestions (best
 * first) or a whole mail address, as `{ matches, members, at, place }`, or `{ why }`.
 */
export async function findMember(env, where, query, opts = {}) {
  const listed = await roster(env, where, { ...opts, fresh: true });
  if (!listed.members) {
    return listed;
  }
  const q = String(query || '').trim();
  if (q.includes('@')) {
    const mail = q.toLowerCase();
    return {
      ...listed,
      matches: listed.members.filter((m) => m.email && m.email.toLowerCase() === mail),
    };
  }
  const accounts = listed.members.map((m) => ({
    ...m, name: m.name || m.email || '', aliases: [m.email].filter(Boolean),
  }));
  return { ...listed, matches: rankMentions(accounts, q, MAX_MATCHES) };
}

const isMember = (person, members) => members.some((m) => person.accounts.includes(m.user_id)
  || (person.email && m.email && person.email.toLowerCase() === m.email.toLowerCase()));

/**
 * Who `messages` of the inbox entry `entry` mention on the platform (`@Name` picked or typed
 * there; a name in the text is no mention) and is not in the channel: `{ names, at, place }`,
 * or null when everyone is, or nobody can tell. A list that says someone is out is listed again
 * first, so a person added since is not called out.
 */
export async function mentionedOutside(env, entry, messages, opts = {}) {
  const keys = messages.map((m) => `${entry.source}:${entry.tenant}:${entry.channelId}:${m.id}`);
  if (!keys.length) {
    return null;
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT m.person, p.name, p.email,
      (SELECT json_group_array(i.user_id) FROM identities i
        WHERE i.person = m.person AND i.source = ?) AS accounts
    FROM mentions m JOIN people p ON p.id = m.person
    WHERE m.via = 'id' AND m.message IN (SELECT value FROM json_each(?))`)
    .bind(entry.source, JSON.stringify(keys)).all();
  const people = (results || []).map((r) => ({ ...r, accounts: JSON.parse(r.accounts) }));
  if (!people.length) {
    return null;
  }
  const where = { source: entry.source, tenant: entry.tenant, channelId: entry.channelId };
  const known = await roster(env, where, opts);
  if (known.members && people.every((p) => isMember(p, known.members))) {
    return null;
  }
  const listed = await roster(env, where, { ...opts, fresh: true });
  const outside = listed.members ? people.filter((p) => !isMember(p, listed.members)) : [];
  if (!outside.length) {
    return null;
  }
  return {
    names: outside.map((p) => String(p.name || p.email || 'someone').replace(/\s+/g, ' ').slice(0, MAX_NAME)),
    at: listed.at,
    place: listed.place,
  };
}
