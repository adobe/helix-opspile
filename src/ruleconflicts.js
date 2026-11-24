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
 * Conflicts between team rules, for the admin team to settle in its inbox, a thread each: two rules
 * of two teams that both match a channel opspile knows. The lowest priority decides (src/rules.js),
 * so a conflict is no error, but often an accident: a prefix of one team's (`^aem-`) that also
 * takes the channels a narrower rule of another's was meant for. Computed from the rules and the
 * channels every time, never curated.
 *
 * Manual assignments (`channel_id` rules) are never in a conflict: they are how one is settled for
 * one channel, so a channel one of them decides is in none. Neither is a rule that matches every
 * channel it may (the fallback to the admin team).
 *
 * Side `a` is the broader rule (it matches more channels), `b` the narrower. Either side can win
 * (`win.a`, `win.b`): the other's pattern leaves the winner's out (`^(?!winner)loser`, on the same
 * field), so the channels both match are filed under the winner, and the other team can follow
 * them (`follow`): a follow rule (target `follow`, src/followrules.js) of the channels both match
 * (`^(?=winner)loser`) shares them with it. Or it is meant: `keep` hides it while its rules and
 * channels stay as they were (`rule_conflict_keeps.fingerprint`). A conflict neither side can win
 * by a pattern (the rules read different things of a channel, a platform the other rule is not
 * for) is one of the other conflicts (`section: 'other'`): kept, or changed by hand.
 */

import { isHolding } from './shares.js';
import { loadRules } from './lookup.js';
import { knownChannels } from './followrules.js';
import { sha256 } from './raw.js';
import { valueOf } from './rules.js';

const MAX_PATTERN = 500;
const PATTERN_FIELDS = ['name', 'group_name'];

const ordered = (rules) => [...rules].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
const isManual = (r) => r.field === 'channel_id';
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

/** The lookahead that holds where pattern `b` matches (`(?=…)`) or does not (`(?!…)`). */
function lookahead(b, sign) {
  const sb = scanPattern(b);
  if (sb.backref) {
    return null;
  }
  return b.startsWith('^') && !sb.alt ? `(?${sign}${sb.out.slice(1)})`
    : `(?${sign}[\\s\\S]*?(?:${sb.out}))`;
}

/** Pattern `a` with a lookahead before it, at the start, so `a`'s groups keep their numbers. */
function withLookahead(a, look) {
  if (!look) {
    return null;
  }
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

/**
 * Pattern `a` without what pattern `b` matches (`a` and not `b`, both case-insensitive, on one
 * value): `^(?!b)` before `a`. Null when it cannot be written.
 */
export const excluding = (a, b) => withLookahead(a, lookahead(b, '!'));

/** Pattern `a` where pattern `b` matches too: `^(?=b)` before `a`; null when it cannot be. */
export const intersecting = (a, b) => withLookahead(a, lookahead(b, '='));

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

const matches = (r, c) => valueOf(r, c, 'team') !== null;

/**
 * How `winner` wins over `loser` on `channels`: `loser`'s pattern without `winner`'s (`pattern`),
 * and the follow rule of `loser`'s team for what both match (`follow`: `{ pattern, source }`, or
 * null when the team follows nothing); or `{ why }` it cannot.
 */
function winning(winner, loser, channels) {
  if (winner.field !== loser.field || !PATTERN_FIELDS.includes(loser.field)) {
    return { why: 'the two rules read different things of a channel, so one cannot leave the other out' };
  }
  if (winner.source && winner.source !== loser.source) {
    return { why: `the winning rule is for ${winner.source} only: leaving it out would leave out the other platforms' channels too` };
  }
  const pattern = excluding(loser.pattern, winner.pattern);
  if (!pattern) {
    return { why: 'one pattern cannot be written into the other (it refers back to a group)' };
  }
  const both = intersecting(loser.pattern, winner.pattern);
  if (pattern.length > MAX_PATTERN || (both && both.length > MAX_PATTERN)) {
    return { why: `the pattern would be longer than ${MAX_PATTERN} characters` };
  }
  const left = { ...loser, pattern };
  const shared = both && { ...loser, pattern: both, source: winner.source || loser.source };
  const wrong = channels.find((c) => matches(left, c) !== (matches(loser, c) && !matches(winner, c))
    || (shared && matches(shared, c) !== (matches(loser, c) && matches(winner, c))));
  if (wrong) {
    return { why: 'the rewritten pattern would not match what it should' };
  }
  const follows = shared && !isHolding(loser.value) && !template(loser);
  return {
    ok: true,
    rule: loser.id,
    pattern,
    // Left with no channel opspile knows: it goes, or becomes the follow rule itself.
    empty: !channels.some((c) => matches(left, c)),
    follow: follows ? { pattern: both, source: shared.source } : null,
  };
}

/**
 * The conflicts between the team rules of `rules` on `channels` (as src/followrules.js
 * `knownChannels` gives them, the archived ones left out), each with its `key` and `fingerprint`.
 */
export async function findRuleConflicts(rules, channels) {
  const live = channels.filter((c) => !c.archived);
  const teamRules = ordered(rules.filter((r) => r.target === 'team'));
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
  // The rules that match every channel they may (fallbacks).
  const fallback = new Set(teamRules.filter((r) => {
    const may = live.filter((c) => !r.source || r.source === c.source).length;
    return may > 1 && hits.get(r.id).length === may;
  }).map((r) => r.id));
  const groups = new Map();
  live.forEach((c, n) => {
    const m = perChannel[n].filter((x) => !fallback.has(x.rule.id));
    // Assigned by hand: settled for this channel, whatever the rules say.
    if (m.some((x) => isManual(x.rule))) {
      return;
    }
    for (let i = 0; i < m.length; i += 1) {
      for (let j = i + 1; j < m.length; j += 1) {
        const [x, y] = [m[i], m[j]];
        if (x.value !== y.value) {
          const key = `rule:${Math.min(x.rule.id, y.rule.id)}|rule:${Math.max(x.rule.id, y.rule.id)}`;
          const g = groups.get(key) || { key, rules: [x.rule, y.rule], channels: [] };
          // The first rule that matches it decides, of these two or another.
          g.channels.push({ channel: c, winner: m[0].value });
          groups.set(key, g);
        }
      }
    }
  });
  const out = [];
  for (const g of groups.values()) {
    // a is the broader; of two as broad, b is the newer one.
    const [ra, rb] = [...g.rules].sort((p, q) => (hits.get(q.id).length - hits.get(p.id).length)
      || (p.id - q.id));
    const overlap = g.channels.sort((p, q) => String(p.channel.name)
      .localeCompare(String(q.channel.name)));
    const side = (r) => ({
      key: `rule:${r.id}`,
      team: r.value,
      rules: [shown(r)],
      matches: hits.get(r.id).length,
      wins: overlap.filter((o) => o.winner === r.value).length,
    });
    const win = {
      a: winning(ra, rb, live),
      b: winning(rb, ra, live),
    };
    for (const w of Object.values(win)) {
      w.ok = Boolean(w.ok);
    }
    const conflict = {
      key: g.key,
      section: win.a.ok || win.b.ok ? 'rules' : 'other',
      a: side(ra),
      b: side(rb),
      channels: overlap.map((o) => ({ ...channelOf(o.channel), winner: o.winner })),
      win,
    };
    // eslint-disable-next-line no-await-in-loop
    conflict.fingerprint = await sha256(JSON.stringify([
      g.key,
      ...[ra, rb].map((r) => [r.id, r.priority, r.source, r.field, r.pattern, r.value]),
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
 * What settling conflict `c` with side `side` (`a` or `b`) winning changes of `rules`: the loser's
 * pattern leaves the winner's out, and with `follow` its team gets a follow rule of what both
 * match. A loser left with no channel opspile knows goes instead, or with `follow` becomes the
 * follow rule, as it is. `{ next, updates, deletes, inserts }` (`next`: the rules after it, to
 * plan the moves with; `updates`: `{ id, pattern?, target? }`), or `{ error }`.
 */
export function settlement(c, side, rules, { follow = false } = {}) {
  const way = c.win && c.win[side];
  if (!way) {
    return { error: 'side is a or b' };
  }
  if (!way.ok) {
    return { error: way.why };
  }
  if (follow && !way.follow) {
    return { error: 'the other team cannot follow them: the admin team holds what no team has' };
  }
  const loser = rules.find((r) => r.id === way.rule);
  const winner = side === 'a' ? c.a : c.b;
  const updates = [];
  const deletes = [];
  const inserts = [];
  if (way.empty && follow) {
    updates.push({ id: loser.id, target: 'follow' });
  } else if (way.empty) {
    deletes.push(loser.id);
  } else {
    updates.push({ id: loser.id, pattern: way.pattern });
    if (follow) {
      inserts.push({
        target: 'follow',
        priority: loser.priority,
        source: way.follow.source,
        field: loser.field,
        pattern: way.follow.pattern,
        value: loser.value,
        note: `what ${winner.team}'s rule #${winner.rules[0].id} files (rule conflict)`.slice(0, 200),
      });
    }
  }
  const changed = new Map(updates.map((u) => [u.id, u]));
  const next = [
    ...rules.filter((r) => !deletes.includes(r.id))
      .map((r) => (changed.has(r.id) ? { ...r, ...changed.get(r.id) } : r)),
    ...inserts.map((r, i) => ({ ...r, id: Number.MAX_SAFE_INTEGER - i })),
  ];
  return {
    next, updates, deletes, inserts,
  };
}
