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
 * The rules engine that maps a channel to an ops team, an org (customer or vendor) and a
 * kind. Rules are rows in D1 (`rules`); see migrations/0001_index.sql.
 *
 * A rule of target `follow` (migration 0086) files nothing: every one that matches a channel
 * shares it with its team (`followers`), which src/followrules.js keeps in `channel_teams`.
 *
 * A merged org (migration 0091, src/orgmerge.js) is a rule of target `merge` that `loadRules`
 * adds (`mergeRule`): the org the other rules give is looked up among them last (`mergedOrg`), so
 * what they file under the merged slug, by a template or by hand, is filed under the one it was
 * merged into.
 */

export const UNASSIGNED = '_unassigned';

export const DEFAULTS = { team: UNASSIGNED, org: UNASSIGNED, kind: 'channel' };

/**
 * Lower-case slug for path segments: letters, digits and `-`. A leading `_` marks an
 * internal slug (`_unassigned`, `_test`) and is kept.
 */
export function slug(value) {
  const internal = String(value || '').startsWith('_') ? '_' : '';
  const s = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s ? `${internal}${s}` : UNASSIGNED;
}

function candidates(channel, field) {
  if (field === 'connected') {
    return channel.connected || [];
  }
  const value = {
    channel_id: channel.channelId,
    name: channel.name,
    group_name: channel.groupName,
  }[field];
  return value ? [value] : [];
}

// The rules are a few hundred patterns, each tried on every channel: compiled once. Without a
// `g` flag, `exec` keeps no state, so one RegExp serves every call.
const compiled = new Map();
function compile(pattern) {
  if (!compiled.has(pattern)) {
    if (compiled.size > 5000) {
      compiled.clear();
    }
    let re = null;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // a broken rule never matches
    }
    compiled.set(pattern, re);
  }
  return compiled.get(pattern);
}

/** A merge (an `org_merges` row) as the rules carry it: `slug` is filed under `into`. */
export const mergeRule = (m, i = 0) => ({
  id: -1 - i,
  target: 'merge',
  priority: 0,
  source: null,
  field: 'org',
  pattern: m.slug,
  value: m.into_slug ?? m.into,
  note: 'merged org',
});

/** Most merges followed one after another: a chain longer than this is a loop. */
const MAX_MERGES = 8;

/** The org `org` is filed under, after the merges among `rules`: itself when it was not merged. */
export function mergedOrg(rules, org) {
  const merges = rules.filter((r) => r.target === 'merge');
  let out = org;
  for (let i = 0; i < MAX_MERGES && merges.length; i += 1) {
    const from = out;
    const next = merges.find((r) => r.pattern === from);
    if (!next || next.value === out) {
      break;
    }
    out = next.value;
  }
  return out;
}

const ordered = (rules) => [...rules].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));

/** What `rule` gives `channel` for `target`, or null when it does not apply or match. */
export function valueOf(rule, channel, target = rule.target) {
  if (rule.target !== target || (rule.source && rule.source !== channel.source)) {
    return null;
  }
  const re = compile(rule.pattern);
  const hit = re && candidates(channel, rule.field).map((v) => re.exec(v)).find(Boolean);
  if (!hit) {
    return null;
  }
  const value = rule.value.replace(/\$(\d)/g, (_, n) => hit[Number(n)] || '');
  return target === 'kind' ? value : slug(value);
}

/**
 * Evaluates the rules for one channel.
 *
 * @param {object[]} rules rows of the `rules` table
 * @param {object} channel `{ source, channelId, name, groupName, connected }`
 * @returns {{ team: string, org: string, kind: string, matched: object }}
 */
export function classify(rules, channel) {
  const result = { ...DEFAULTS, matched: {} };
  const sorted = ordered(rules);
  for (const target of Object.keys(DEFAULTS)) {
    for (const rule of sorted) {
      const value = valueOf(rule, channel, target);
      if (value !== null) {
        result[target] = value;
        result.matched[target] = rule.id;
        break;
      }
    }
  }
  result.org = mergedOrg(rules, result.org);
  return result;
}

/**
 * Every rule for `target` that matches `channel`, in the order they are tried: the first one
 * decides (`classify`), the others are what would decide without it. `[{ rule, value }]`.
 */
export function matching(rules, channel, target) {
  return ordered(rules).flatMap((rule) => {
    const value = valueOf(rule, channel, target);
    if (value === null) {
      return [];
    }
    return [{ rule, value: target === 'org' ? mergedOrg(rules, value) : value }];
  });
}

/**
 * The teams the follow rules share `channel` with (target `follow`): every one that matches,
 * not only the first. `[{ rule, team }]`, in the order the rules are tried.
 */
export function followers(rules, channel) {
  return matching(rules, channel, 'follow').map(({ rule, value }) => ({ rule, team: value }));
}
