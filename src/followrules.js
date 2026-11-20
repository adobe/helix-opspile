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

/**
 * Follow rules (migration 0086): a rule of target `follow` shares every channel it matches with
 * its team, as a share added by hand does (`channel_teams`, src/shares.js), unless the channel is
 * filed under that team. Everything that reads shares reads `channel_teams` (in SQL too), so the
 * rules' shares are written there, `added_by` `rule:<id>`: `syncFollowRules` adds the ones the
 * rules want and takes away those of a rule that no longer matches, after every rule change and on
 * the cron (a channel seen for the first time, or renamed, is followed within a run). A share by
 * hand of the same channel and team stays as it is, whatever the rules say.
 */

import { loadRules, toChannel } from './lookup.js';
import { classify, followers } from './rules.js';

/** `added_by` of a share a follow rule made. */
export const RULE_SHARE = 'rule:';
export const isRuleShare = (addedBy) => String(addedBy || '').startsWith(RULE_SHARE);

const shareKey = (s) => `${s.source}\n${s.channelId ?? s.channel_id}\n${s.team}`;
const BATCH = 50;

/**
 * The shares the follow rules of `rules` want for `channels` (as `toChannel` gives them):
 * `Map<key, { source, channelId, team, rule }>`, the first matching rule of each team.
 */
export function wantedFollows(rules, channels) {
  const out = new Map();
  if (!rules.some((r) => r.target === 'follow')) {
    return out;
  }
  for (const c of channels) {
    const fs = followers(rules, c);
    if (fs.length) {
      const filed = classify(rules, c).team;
      for (const { rule, team } of fs) {
        const w = {
          source: c.source, channelId: c.channelId, team, rule: rule.id,
        };
        if (team !== filed && !out.has(shareKey(w))) {
          out.set(shareKey(w), w);
        }
      }
    }
  }
  return out;
}

/** Every channel opspile knows, as the rules read it. */
export async function knownChannels(env) {
  const { results } = await env.DB.prepare(`SELECT source, tenant, channel_id, name, group_name,
      shared, connected, archived_at FROM channels`).all();
  return (results || []).map((r) => ({
    ...toChannel(r, r.source, r.channel_id), tenant: r.tenant, archived: Boolean(r.archived_at),
  }));
}

/**
 * Writes the follow rules' shares: adds what `rules` (all of them, or the rules in D1) want, and
 * takes away the shares a rule made that they no longer want. Returns `{ added, removed }`.
 */
export async function syncFollowRules(env, rules = null) {
  const all = rules || await loadRules(env);
  const { results: have } = await env.DB.prepare(`SELECT source, channel_id, team, added_by
    FROM channel_teams`).all();
  const made = (have || []).filter((h) => isRuleShare(h.added_by));
  if (!all.some((r) => r.target === 'follow') && !made.length) {
    return { added: 0, removed: 0 };
  }
  const want = wantedFollows(all, await knownChannels(env));
  const { results: teamRows } = await env.DB.prepare('SELECT slug FROM teams').all();
  const teams = new Set((teamRows || []).map((t) => t.slug));
  const there = new Set((have || []).map(shareKey));
  const at = new Date().toISOString();
  const statements = [
    ...[...want.values()].filter((w) => !there.has(shareKey(w)) && teams.has(w.team))
      .map((w) => env.DB.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_by,
          added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .bind(w.source, String(w.channelId), w.team, `${RULE_SHARE}${w.rule}`, at)),
    // Only a rule's: a share by hand of the same channel and team is never taken away here.
    ...made.filter((h) => !want.has(shareKey(h)))
      .map((h) => env.DB.prepare(`DELETE FROM channel_teams WHERE source = ? AND channel_id = ?
          AND team = ? AND added_by = ?`).bind(h.source, h.channel_id, h.team, h.added_by)),
  ];
  const added = statements.length - made.filter((h) => !want.has(shareKey(h))).length;
  for (let i = 0; i < statements.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(statements.slice(i, i + BATCH));
  }
  return { added, removed: statements.length - added };
}
