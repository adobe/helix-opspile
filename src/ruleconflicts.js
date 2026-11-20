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
 * Conflicts between team rules, for the admin team to settle under Requests: two rules that file
 * a channel opspile knows under two teams. The lowest priority decides (src/rules.js), so a
 * conflict is no error, but often an accident: a prefix of one team's (`^aem-`) that also takes
 * the channels a narrower rule of another's was meant for. Computed from the rules and the
 * channels every time, never curated.
 *
 * A conflict has two sides: one rule, or one team's manual assignments (`channel_id` rules) that
 * meet the same rule of another team, grouped. Side `a` is the broader (it matches more channels),
 * `b` the narrower. The ways to settle one:
 *
 * - `follow`: a wins. b's rule becomes a follow rule (target `follow`, src/followrules.js): the
 *   channels are filed under a, and shared with b. A manual assignment of one channel becomes a
 *   share of it instead, as adding a team to a channel another team holds makes.
 * - `exclude`: b wins. a's rule leaves b's out: its pattern gets b's as a negative lookahead (on
 *   the same field), or a's manual assignments of those channels go. A rule cannot leave single
 *   channels out, so b's manual assignments against a's rule have no `exclude`: those are the
 *   other conflicts (`section: 'other'`), which `follow` or `keep` settle.
 * - `keep`: it is meant. A kept conflict stays hidden while its rules and channels stay as they
 *   were (`rule_conflict_keeps.fingerprint`).
 *
 * A rule that matches every channel it may (the fallback to the admin team) conflicts with none.
 */

import { isHolding } from './shares.js';
import { loadRules } from './lookup.js';
import { knownChannels } from './followrules.js';
import { sha256 } from './raw.js';
import { valueOf } from './rules.js';

const MAX_PATTERN = 500;
const PATTERN_FIELDS = ['name', 'group_name'];

const ordered = (rules) => [...rules].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
const isPin = (r) => r.field === 'channel_id';
const template = (r) => /\$\d/.test(r.value);

/**
 * A regular expression's source, read: the same expression with its capturing groups made
 * non-capturing (`out`), whether it has a top-level alternative (`alt`), and whether it refers
 * back to a group (`backref`), which no rewrite keeps.
 */
export function scanPattern(pattern) {
  let out = '';
  let depth = 0;
  let alt = false;
  let backref = false;
  let inClass = false;
  const s = String(pattern);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1] || '';
      if (!inClass && (/[1-9]/.test(next) || (next === 'k' && s[i + 2] === '<'))) {
        backref = true;
      }
      out += ch + next;
      i += 1;
    } else if (inClass) {
      inClass = ch !== ']';
      out += ch;
    } else if (ch === '[') {
      inClass = true;
      out += ch;
    } else if (ch === '(') {
      depth += 1;
      if (s[i + 1] !== '?') {
        out += '(?:';
      } else if (s[i + 2] === '<' && s[i + 3] !== '=' && s[i + 3] !== '!') {
        // A named group: non-capturing, its name dropped.
        const end = s.indexOf('>', i);
        out += '(?:';
        i = end < 0 ? i : end;
      } else {
        out += ch;
      }
    } else if (ch === ')') {
      depth -= 1;
      out += ch;
    } else {
      if (ch === '|' && depth === 0) {
        alt = true;
      }
      out += ch;
    }
  }
  return { out, alt, backref };
}

/**
 * Pattern `a` without what pattern `b` matches (`a` and not `b`, both case-insensitive, on one
 * value): `^(?!b)` before `a`, so `a`'s groups keep their numbers. Null when it cannot be written.
 */
export function excluding(a, b) {
  const sb = scanPattern(b);
  if (sb.backref) {
    return null;
  }
  const look = b.startsWith('^') && !sb.alt ? `(?!${sb.out.slice(1)})` : `(?![\\s\\S]*?(?:${sb.out}))`;
  const sa = scanPattern(a);
  const body = a.startsWith('^') && !sa.alt ? a.slice(1) : `[\\s\\S]*?(?:${a})`;
  const pattern = `^${look}${body}`;
  try {
    RegExp(pattern, 'i');
  } catch {
    return null;
  }
  return pattern;
}

/** A rule as a conflict shows it. */
const shown = (r) => ({
  id: r.id,
  priority: r.priority,
  source: r.source || null,
  field: r.field,
  pattern: r.pattern,
  value: r.value,
  note: r.note || null,
  updatedBy: r.updated_by || null,
  updatedAt: r.updated_at || null,
});

/** A channel as a conflict shows it. */
const channelOf = (c) => ({
  source: c.source, channelId: c.channelId, name: c.name, groupName: c.groupName, shared: c.shared,
});

/**
 * The side of rule `r` in a conflict: the rule itself, or its team's manual assignments.
 */
const sideKey = (r) => (isPin(r) ? `pins:${r.value}` : `rule:${r.id}`);

/** How rule `a` can leave out what rule `b` matches, checked on `channels`; or why it cannot. */
function excludePattern(a, b, channels) {
  if (a.field !== b.field || !PATTERN_FIELDS.includes(a.field)) {
    return { why: 'the two rules read different things of a channel, so one cannot leave the other out' };
  }
  if (b.source && b.source !== a.source) {
    return { why: `the narrower rule is for ${b.source} only: leaving it out would leave out the other platforms' channels too` };
  }
  const pattern = excluding(a.pattern, b.pattern);
  if (!pattern) {
    return { why: 'the narrower rule\'s pattern cannot be written into the other one (it refers back to a group)' };
  }
  if (pattern.length > MAX_PATTERN) {
    return { why: `the pattern would be longer than ${MAX_PATTERN} characters` };
  }
  const next = { ...a, pattern };
  const wrong = channels.find((c) => (valueOf(next, c, 'team') !== null)
    !== (valueOf(a, c, 'team') !== null && valueOf(b, c, 'team') === null));
  if (wrong) {
    return { why: 'the rewritten pattern would not match what the rule matches without the other one' };
  }
  return { pattern };
}

/**
 * The conflicts between the team rules of `rules` on `channels` (as src/followrules.js
 * `knownChannels` gives them, the archived ones left out), each with its `key` and `fingerprint`.
 */
export async function findRuleConflicts(rules, channels) {
  const live = channels.filter((c) => !c.archived);
  const teamRules = ordered(rules.filter((r) => r.target === 'team'));
  // What each rule matches, and the rules that match every channel they may (fallbacks).
  const hits = new Map(teamRules.map((r) => [r.id, []]));
  const perChannel = live.map((c) => {
    const m = [];
    for (const r of teamRules) {
      const value = valueOf(r, c, 'team');
      if (value !== null) {
        m.push({ rule: r, value });
        hits.get(r.id).push(c);
      }
    }
    return m;
  });
  const fallback = new Set(teamRules.filter((r) => {
    const may = live.filter((c) => !r.source || r.source === c.source).length;
    return may > 1 && hits.get(r.id).length === may;
  }).map((r) => r.id));
  const groups = new Map();
  live.forEach((c, n) => {
    const m = perChannel[n].filter((x) => !fallback.has(x.rule.id));
    for (let i = 0; i < m.length; i += 1) {
      for (let j = i + 1; j < m.length; j += 1) {
        const [x, y] = [m[i], m[j]];
        const [kx, ky] = [sideKey(x.rule), sideKey(y.rule)];
        if (x.value !== y.value && kx !== ky) {
          const key = [kx, ky].sort().join('|');
          const g = groups.get(key) || { key, sides: new Map(), channels: new Map() };
          for (const s of [x, y]) {
            const k = sideKey(s.rule);
            const side = g.sides.get(k) || { key: k, rules: new Map(), team: s.value };
            side.rules.set(s.rule.id, s.rule);
            g.sides.set(k, side);
          }
          // The first rule that matches it decides, of these two or another.
          g.channels.set(`${c.source}:${c.channelId}`, { channel: c, winner: m[0].value });
          groups.set(key, g);
        }
      }
    }
  });
  const out = [];
  for (const g of groups.values()) {
    const sides = [...g.sides.values()].map((s) => {
      const list = ordered([...s.rules.values()]);
      const matched = new Map();
      for (const r of list) {
        for (const c of hits.get(r.id)) {
          matched.set(`${c.source}:${c.channelId}`, c);
        }
      }
      return {
        key: s.key, team: s.team, pins: s.key.startsWith('pins:'), rules: list, matched,
      };
    });
    // a is the broader side; of two as broad, b is the newer one.
    sides.sort((p, q) => (q.matched.size - p.matched.size)
      || (Math.max(...p.rules.map((r) => r.id)) - Math.max(...q.rules.map((r) => r.id))));
    const [a, b] = sides;
    const overlap = [...g.channels.values()].sort((p, q) => String(p.channel.name)
      .localeCompare(String(q.channel.name)));
    const won = (side) => overlap.filter((o) => o.winner === side.team).length;
    const follow = (() => {
      if (isHolding(b.team)) {
        return { ok: false, why: 'the admin team holds the channels no team has: it follows none' };
      }
      if (b.rules.some(template)) {
        return { ok: false, why: 'the narrower rule names its team from the channel ($1): it cannot follow' };
      }
      return {
        ok: true,
        rules: b.rules.filter((r) => !b.pins || hits.get(r.id).length !== 1).map((r) => r.id),
        shares: b.pins ? b.rules.filter((r) => hits.get(r.id).length === 1).map((r) => r.id) : [],
      };
    })();
    const exclude = (() => {
      if (a.pins) {
        const inside = a.rules.filter((r) => hits.get(r.id).every((c) => g.channels.has(`${c.source}:${c.channelId}`)));
        return inside.length === a.rules.length ? { ok: true, deletes: inside.map((r) => r.id) }
          : { ok: false, why: 'some of the manual assignments match more channels than these' };
      }
      if (b.pins) {
        return {
          ok: false,
          why: `a rule cannot leave single channels out; the manual assignments already win over the rule${b.rules.length === 1 ? '' : 's'} of the other team`,
        };
      }
      const e = excludePattern(a.rules[0], b.rules[0], live);
      return e.pattern ? { ok: true, rule: a.rules[0].id, pattern: e.pattern }
        : { ok: false, why: e.why };
    })();
    const side = (s) => ({
      key: s.key,
      team: s.team,
      pins: s.pins,
      rules: s.rules.map(shown),
      matches: s.matched.size,
      wins: won(s),
    });
    const conflict = {
      key: g.key,
      section: exclude.ok ? 'rules' : 'other',
      a: side(a),
      b: side(b),
      channels: overlap.map((o) => ({ ...channelOf(o.channel), winner: o.winner })),
      follow,
      exclude,
    };
    // eslint-disable-next-line no-await-in-loop
    conflict.fingerprint = await sha256(JSON.stringify([
      g.key,
      ...[a, b].flatMap((s) => s.rules
        .map((r) => [r.id, r.priority, r.source, r.field, r.pattern, r.value])),
      overlap.map((o) => `${o.channel.source}:${o.channel.channelId}`),
    ]));
    out.push(conflict);
  }
  const rank = (x) => (x.section === 'rules' ? 0 : 1);
  return out.sort((p, q) => rank(p) - rank(q)
    || q.channels.length - p.channels.length || p.key.localeCompare(q.key));
}

/** The conflicts as they are now, with whether each is kept (`kept`: who, when, why). */
export async function ruleConflicts(env, { rules = null, kept: withKept = true } = {}) {
  const [all, channels, keeps] = await Promise.all([
    rules || loadRules(env),
    knownChannels(env),
    env.DB.prepare('SELECT key, fingerprint, kept_by, kept_at, note FROM rule_conflict_keeps').all(),
  ]);
  const keptBy = new Map((keeps.results || []).map((k) => [k.key, k]));
  const list = (await findRuleConflicts(all, channels)).map((c) => {
    const k = keptBy.get(c.key);
    return k && k.fingerprint === c.fingerprint
      ? { ...c, kept: { by: k.kept_by, at: k.kept_at, note: k.note || null } } : c;
  });
  return withKept ? list : list.filter((c) => !c.kept);
}

/**
 * What settling conflict `c` with `action` (`follow` or `exclude`) changes of `rules`: the rules
 * after it (`next`, to plan the moves with), and the changes to write: `updates`
 * (`{ id, target?, pattern? }`), `deletes` (rule ids) and `shares` (`{ source, channelId, team }`,
 * of a manual assignment that becomes a share). `{ error }` when it cannot be settled so.
 */
export function settlement(c, action, rules, channels) {
  const way = c[action];
  if (!way) {
    return { error: 'action is follow, exclude or keep' };
  }
  if (!way.ok) {
    return { error: way.why };
  }
  const updates = [];
  const deletes = [];
  const shares = [];
  if (action === 'follow') {
    updates.push(...way.rules.map((id) => ({ id, target: 'follow' })));
    for (const id of way.shares) {
      const r = rules.find((x) => x.id === id);
      const ch = channels.find((x) => !x.archived && valueOf(r, x, 'team') !== null);
      deletes.push(id);
      if (ch) {
        shares.push({ source: ch.source, channelId: ch.channelId, team: c.b.team });
      }
    }
  } else if (way.deletes) {
    deletes.push(...way.deletes);
  } else {
    updates.push({ id: way.rule, pattern: way.pattern });
  }
  const changed = new Map(updates.map((u) => [u.id, u]));
  const next = rules.filter((r) => !deletes.includes(r.id))
    .map((r) => (changed.has(r.id) ? { ...r, ...changed.get(r.id) } : r));
  return {
    next, updates, deletes, shares,
  };
}
