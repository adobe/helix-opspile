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

import { ensureKnowledgeBase, repoName } from './kb.js';
import { sha256 } from './raw.js';

/**
 * Individual channels, as the inbox's thread agents work them (docs/ARCHITECTURE.md, "Individual
 * channels"; the portal enforces what its customers see, portal migration 0008). In a channel whose
 * customers are each their own customer, a thread's agent:
 *
 * - learns into the **end user's own knowledge base**, `kb-person-<key>` (kind `person` in
 *   `knowledge_bases`), not the org's: the org holds every end user of the channel, and what one
 *   of them says is nobody else's. Its key is their identity: the verified address of their
 *   accounts (an embedded account's merge key, `identities.merge_email`, or a standalone portal
 *   account's mail address), so one person's profiles share one, and without an address their
 *   account. The team's knowledge base and its instructions are as in any channel;
 * - reads only that person's threads of the channel (`scopeOf`): the list, read_thread, the
 *   watches and the related threads, never another member's; and no other channel's
 *   (`org_threads` and `any_thread` are off, src/agent/agenttools.js).
 *
 * The end user of a thread is its first customer author (`endUserOf`): who started it, unless
 * Adobe wrote first. A thread with none yet has no person: its agent gets no `kb-person`, and
 * reads no other thread.
 *
 * The agent's "their threads" is narrower than the portal's on purpose: threads one of their
 * accounts wrote in. The portal also shows a customer a thread Adobe added them to
 * (`thread_members`), which the inbox never hears of; until they write in it, their agent does
 * not list or read it, so it errs towards reading less.
 */

export const AUDIENCES = ['shared', 'individual'];

/** The repository key of a person: `p` and 24 hex digits of what identifies them. */
export async function personSlug({ mail, key }) {
  const what = mail ? `mail:${String(mail).trim().toLowerCase()}` : `account:${key}`;
  return `p${(await sha256(what)).slice(0, 24)}`;
}

/**
 * Records who sees a portal channel's threads, as portal event `seq` says: only when it is newer
 * than what the row has (a replay, or two events out of order, end where the latest says).
 * A channel without a row is shared, so a shared one (every message of a shared channel says so)
 * is written only over a row there is. Whether it changed anything.
 */
export async function recordAudience(env, {
  source = 'portal', tenant, channelId, audience, seq = 0, at = new Date().toISOString(),
}) {
  if (!tenant || !channelId || !AUDIENCES.includes(audience)) {
    return false;
  }
  const n = Number(seq) || 0;
  const { meta } = audience === 'shared'
    ? await env.DB.prepare(`UPDATE channel_audiences SET audience = 'shared', seq = ?4, at = ?5
      WHERE source = ?1 AND tenant = ?2 AND channel_id = ?3 AND seq <= ?4`)
      .bind(source, tenant, channelId, n, at).run()
    : await env.DB.prepare(`INSERT INTO channel_audiences (source, tenant, channel_id,
        audience, seq, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, tenant, channel_id) DO UPDATE SET audience = excluded.audience,
        seq = excluded.seq, at = excluded.at
      WHERE excluded.seq >= channel_audiences.seq`)
      .bind(source, tenant, channelId, audience, n, at).run();
  return Boolean(meta && meta.changes);
}

/** Whether channel `{ source, tenant, channelId }` is individual. */
export async function isIndividualChannel(env, { source, tenant, channelId }) {
  if (source !== 'portal' || !env.DB) {
    return false;
  }
  const row = await env.DB.prepare(`SELECT audience FROM channel_audiences WHERE source = ?
    AND tenant = ? AND channel_id = ?`).bind(source, tenant || '', channelId || '').first();
  return Boolean(row) && row.audience === 'individual';
}

const ACCOUNT = /^portal:(.+):([^:]+)$/;

/**
 * The end user of the threads `keys` (an inbox entry's): the first customer who wrote, `{ key,
 * name, mail }` (`key` their identity key, `mail` the address they are one person by), or null.
 */
export async function endUserOf(env, keys) {
  const first = await env.DB.prepare(`SELECT author_key AS key, author AS name FROM messages
    WHERE thread IN (SELECT value FROM json_each(?)) AND staff = 0 AND author_kind = 'person'
      AND author_key IS NOT NULL AND person IS NULL
    ORDER BY at, id LIMIT 1`).bind(JSON.stringify(keys || [])).first();
  const parts = first && ACCOUNT.exec(first.key);
  if (!parts) {
    return null;
  }
  const row = await env.DB.prepare(`SELECT COALESCE(display_name, name) AS name,
      LOWER(COALESCE(email, merge_email)) AS mail, staff, person FROM identities
    WHERE source = 'portal' AND tenant = ? AND user_id = ?`).bind(parts[1], parts[2]).first();
  if (row && (row.staff || row.person)) {
    return null;
  }
  return {
    key: first.key, name: (row && row.name) || first.name || null, mail: (row && row.mail) || null,
  };
}

/**
 * The accounts of `person` (`endUserOf`'s) in portal tenant `tenant` (its channel's lobby): theirs,
 * and those of the same address. Their threads are the ones these wrote in.
 */
export async function accountsOf(env, tenant, person) {
  if (!person) {
    return [];
  }
  if (!person.mail) {
    return [person.key];
  }
  const { results } = await env.DB.prepare(`SELECT 'portal:' || tenant || ':' || user_id AS key
    FROM identities WHERE source = 'portal' AND tenant = ?1 AND kind = 'person'
      AND person IS NULL AND COALESCE(staff, 0) = 0
      AND (merge_email = ?2 OR LOWER(email) = ?2) LIMIT 20`).bind(tenant, person.mail).all();
  return [...new Set([person.key, ...(results || []).map((r) => r.key)])];
}

/**
 * What a thread agent of channel `{ source, tenant, channelId, org?, team? }` (`org` and `team`
 * the channel's, which the knowledge base's costs are counted under) and inbox entry `keys`
 * works with in an individual channel, or null in a shared one: `{ name, mail?, slug, kb,
 * accounts }`, the end user, their knowledge base (made in Artifacts when first needed; null
 * where it cannot be) and their accounts; `{ name: null, slug: null, kb: null, accounts: [] }`
 * before any of them wrote. `ensure: false` makes no knowledge base, for who only asks whose
 * threads are whose.
 */
export async function individualOf(env, channel, keys, { ensure = true } = {}) {
  if (!await isIndividualChannel(env, channel)) {
    return null;
  }
  const person = await endUserOf(env, keys);
  if (!person) {
    return {
      name: null, slug: null, kb: null, accounts: [],
    };
  }
  const slug = await personSlug(person);
  const made = ensure ? await ensureKnowledgeBase(env, 'person', slug).catch((e) => {
    console.warn(JSON.stringify({ route: 'agent', kb: 'person', error: e.message }));
    return null;
  }) : null;
  if (made && (channel.org || channel.team)) {
    // Whose its costs are (src/cogs/rollup.js): the channel's customer and team. Written only when
    // that changed.
    await env.DB.prepare(`UPDATE knowledge_bases SET owner_org = ?2, owner_team = ?3 WHERE repo = ?1
        AND (owner_org IS NOT ?2 OR owner_team IS NOT ?3)`)
      .bind(made.repo, channel.org || null, channel.team || null).run()
      .catch((e) => console.warn(JSON.stringify({ route: 'agent', kb: 'person owner', error: e.message })));
  }
  return {
    name: person.name,
    slug,
    kb: made ? made.repo : repoName('person', slug),
    accounts: await accountsOf(env, channel.tenant, person),
  };
}

/**
 * The SQL (and what it binds) that keeps a query of threads `t` to those of `accounts`: a thread
 * one of them wrote in. For an individual channel's thread agent (src/agent/history.js).
 */
export const theirThreads = (accounts) => ({
  sql: ` AND EXISTS (SELECT 1 FROM messages pm WHERE pm.thread = t.thread
    AND pm.author_key IN (SELECT value FROM json_each(?)))`,
  bind: [JSON.stringify(accounts || [])],
});

/** Whether one of `accounts` wrote in any of the threads `keys`. */
export async function wroteIn(env, accounts, keys) {
  if (!(accounts || []).length) {
    return false;
  }
  return Boolean(await env.DB.prepare(`SELECT 1 FROM messages
    WHERE thread IN (SELECT value FROM json_each(?)) AND author_key IN (SELECT value FROM json_each(?))
    LIMIT 1`).bind(JSON.stringify(keys || []), JSON.stringify(accounts)).first());
}
