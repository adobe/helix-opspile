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

function compile(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null; // a broken rule never matches
  }
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
  const sorted = [...rules].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
  for (const target of Object.keys(DEFAULTS)) {
    for (const rule of sorted) {
      if (rule.target !== target || (rule.source && rule.source !== channel.source)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const re = compile(rule.pattern);
      const hit = re && candidates(channel, rule.field).map((v) => re.exec(v)).find(Boolean);
      if (hit) {
        const value = rule.value.replace(/\$(\d)/g, (_, n) => hit[Number(n)] || '');
        result[target] = target === 'kind' ? value : slug(value);
        result.matched[target] = rule.id;
        break;
      }
    }
  }
  return result;
}
