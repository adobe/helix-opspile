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

import { sha256 } from './raw.js';
import { LAYER_IDS, techLayers } from './stack.js';
import { isTechId, MAX_TECH_ID } from './techid.js';

/**
 * Extraction rules and the tech stack, as configuration of the ops teams (D1, migration 0043):
 *
 * - `extraction_rules`: regular expressions (or scripts) that find facts in a thread's messages,
 *   such as an Edge Delivery `org/site` in a hostname, a CVE id or a URL, or that detect a
 *   technology the customer uses (an Akamai error reference means Akamai). They run on every
 *   relabel (src/label.js), exact and cheap; loose facts are left to Clairic.
 * - `tech_stack`: the technologies worth knowing at a glance for a customer, each one Clef
 *   yes/no question ("Does this thread show that the customer uses …?"), kept per thread
 *   (labels.tech, thread_tech). Most rows are compiled from the
 *   teams' catalogs (src/catalog.js, `path` set); a row without a path was saved here.
 *
 * The admin team's rules apply to every channel; any other team's to the channels it owns
 * (threads.team), on top of the admin team's. Technologies are the union of every team's
 * (`techFor`): a team's own of an id replaces the others' in its channels, and turned off,
 * removes it there; elsewhere the admin team's is asked (else the first team's by name), with
 * the aliases of them all.
 *
 * A regex rule has a `pattern` (JavaScript, always global; `flags` adds i, m, s or u), a `value`
 * template (`$0` the match, `$1`… its groups; `$0` when empty), a `transform` (lower or upper)
 * and an `exclude` pattern: values it matches are dropped. It writes a fact (`target` fact, its
 * `field`) or detects a technology (`target` tech, `field` its id). A fact's rule has a `label`
 * too (migration 0108): what the inbox calls its field, "Site" for `site` (`factLabels`).
 *
 * A script rule is an ES module whose default export gets the thread and returns what it found:
 *
 *   export default function (thread) {
 *     // thread: { text, messages: [{ at, author, staff, bot, text }], channel, platform,
 *     //   customer }
 *     return [{ field: 'site', value: 'org/site' }, { tech: 'akamai' }];
 *   }
 *
 * It runs in a Dynamic Worker of its own (the LOADER binding), without network access, within
 * SCRIPT_MS; without LOADER, scripts do not run.
 */

/** The team whose rules and technologies apply to every channel (src/roles.js ADMIN_TEAM). */
export const GLOBAL_TEAM = 'admin';
export const MAX_PER_FIELD = 20;
export const MAX_RULES = 100;
export const MAX_TECH = 100;
export const MAX_PATTERN = 600;
export const MAX_SCRIPT = 20000;
const MAX_VALUE = 300;
const MAX_NAME = 80;
/** A fact's label: a word or two, as the inbox shows it next to the value. */
export const MAX_LABEL = 40;
const MAX_DESCRIPTION = 300;
/** Matches a rule looks at before it stops, whatever it found. */
const MAX_MATCHES = 500;
/** How long a script may take, and how much of the thread it gets. */
export const SCRIPT_MS = 2000;
const SCRIPT_CPU_MS = 200;
const SCRIPT_TEXT = 100000;
const MAX_RESULTS = 100;
const COMPATIBILITY_DATE = '2026-10-01';

export const ID = /^[a-z][a-z0-9_]{0,31}$/;
const FLAGS = /^[imsu]*$/;
const KINDS = ['regex', 'script'];
const TARGETS = ['fact', 'tech'];
const TRANSFORMS = ['lower', 'upper'];

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Whether `pattern` repeats a group that itself repeats without bound, as `(a+)+`, `(\w*)*`
 * or `(?:x|y+){2,}`: the shape that backtracks exponentially on text that almost matches. A
 * regular expression cannot be stopped once it runs, and the Worker's clock stands still while
 * it does, so this is checked before a rule runs, not timed while it does. `(?:\.x+)*` is
 * refused too, though harmless: write it with one repetition, as `[x.]*x`.
 */
export function nestedRepeat(pattern) {
  const src = String(pattern || '');
  // Per open group: whether something in it repeats without bound.
  const groups = [];
  let inner = false;
  // Whether the atom just read repeats without bound inside (a closed group's `inner`).
  let last = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      i += 1;
      last = false;
    } else if (c === '[') {
      // A character class: to its closing bracket.
      i += 1;
      if (src[i] === '^') {
        i += 1;
      }
      if (src[i] === ']') {
        i += 1;
      }
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '\\') {
          i += 1;
        }
        i += 1;
      }
      last = false;
    } else if (c === '(') {
      groups.push(inner);
      inner = false;
      last = false;
    } else if (c === ')') {
      last = inner;
      inner = (groups.pop() || false) || inner;
    } else if (c === '*' || c === '+' || (c === '{' && /^\{\d*,\}/.test(src.slice(i)))) {
      if (last) {
        return true;
      }
      inner = true;
      last = false;
      if (c === '{') {
        i = src.indexOf('}', i);
      }
    } else {
      last = false;
    }
  }
  return false;
}

/** A rule's regular expressions, compiled: `{ re, exclude }`, or `{ error }`. */
export function compile(rule) {
  const flags = String(rule.flags || '');
  if (!FLAGS.test(flags)) {
    return { error: 'flags are i, m, s or u' };
  }
  if (!rule.pattern) {
    return { error: 'give a pattern' };
  }
  const unique = [...new Set(`g${flags}`)].join('');
  let re;
  let exclude = null;
  try {
    re = new RegExp(String(rule.pattern), unique);
  } catch (e) {
    return { error: `the pattern is not a regular expression: ${e.message}` };
  }
  if (re.test('')) {
    return { error: 'the pattern matches empty text: it would match everywhere' };
  }
  if (nestedRepeat(rule.pattern) || nestedRepeat(rule.exclude)) {
    return {
      error: 'the pattern repeats a group that repeats itself, as (a+)+: on text that almost'
        + ' matches, that takes forever. Repeat once, as [a.]*a instead of (?:\\.?a+)+',
    };
  }
  re.lastIndex = 0;
  if (rule.exclude) {
    try {
      exclude = new RegExp(String(rule.exclude), flags.includes('i') ? 'i' : '');
    } catch (e) {
      return { error: `exclude is not a regular expression: ${e.message}` };
    }
  }
  return { re, exclude };
}

/** `template` with `$0`… filled from `match`; `$$` is a dollar sign. */
export function fill(template, match) {
  return String(template || '$0')
    .replace(/\$(\$|\d)/g, (_, d) => (d === '$' ? '$' : (match[Number(d)] ?? '')));
}

/** What a regex rule finds in `text`: its values (facts or tech ids), in order, unique. */
export function matches(rule, text, compiled = compile(rule)) {
  if (compiled.error) {
    return [];
  }
  const { re, exclude } = compiled;
  re.lastIndex = 0;
  const out = [];
  let n = 0;
  for (const m of String(text || '').matchAll(re)) {
    n += 1;
    if (n > MAX_MATCHES) {
      break;
    }
    let v = fill(rule.value, m).trim().slice(0, MAX_VALUE);
    if (rule.transform === 'lower') {
      v = v.toLowerCase();
    } else if (rule.transform === 'upper') {
      v = v.toUpperCase();
    }
    if (v && !(exclude && exclude.test(v)) && !out.includes(v)) {
      out.push(v);
    }
  }
  return out;
}

/** Results of a script (or of a rule), as `{ facts, tech }`; anything else is left out. */
function results(list) {
  const facts = [];
  const tech = [];
  for (const r of (Array.isArray(list) ? list : []).slice(0, MAX_RESULTS)) {
    if (r && typeof r === 'object' && typeof r.tech === 'string' && isTechId(r.tech)) {
      tech.push(r.tech);
    } else if (r && typeof r === 'object' && typeof r.field === 'string' && ID.test(r.field)
      && r.value != null && String(r.value).trim()) {
      facts.push({ field: r.field, value: String(r.value).trim().slice(0, MAX_VALUE) });
    }
  }
  return { facts, tech };
}

// The Dynamic Worker around a script: it reads the thread and answers with the script's results.
const RUNNER = `import extract from './rule.js';
export default {
  async fetch(request) {
    const thread = await request.json();
    try {
      const out = await extract(thread);
      return Response.json({ results: Array.isArray(out) ? out : [] });
    } catch (e) {
      return Response.json({ error: String((e && e.message) || e) });
    }
  },
};
`;

/**
 * Runs a script rule on `thread` (see the comment at the top) in a Dynamic Worker without
 * network access: `{ facts, tech }`, or `{ error }`.
 */
export async function runScript(env, rule, thread) {
  if (!env.LOADER) {
    return { error: 'scripts need the Worker Loader binding (LOADER), which this deployment does not have' };
  }
  const code = String(rule.script || '');
  if (!/export\s+default/.test(code)) {
    return { error: 'a script default-exports a function: export default function (thread) { … }' };
  }
  let timer;
  try {
    const id = `extract-${(await sha256(code)).slice(0, 32)}`;
    const worker = env.LOADER.get(id, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: 'runner.js',
      modules: { 'runner.js': RUNNER, 'rule.js': code },
      globalOutbound: null,
      limits: { cpuMs: SCRIPT_CPU_MS },
    }));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), SCRIPT_MS);
    });
    const res = await Promise.race([worker.getEntrypoint().fetch('http://rule/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(thread),
    }), timeout]);
    if (!res) {
      return { error: `the script took longer than ${SCRIPT_MS / 1000} seconds` };
    }
    const body = await res.json();
    return body.error ? { error: String(body.error).slice(0, 300) } : results(body.results);
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/** A thread as scripts get it: its text and its messages, with who wrote them. */
export function scriptInput(thread, messages) {
  const live = (messages || []).filter((m) => !m.deletedAt);
  let budget = SCRIPT_TEXT;
  const shown = [];
  for (const m of live) {
    const text = String(m.body || '').slice(0, Math.max(0, budget));
    budget -= text.length;
    const a = m.author || {};
    shown.push({
      at: m.at || null,
      author: a.name || null,
      staff: Boolean(a.staff),
      bot: a.kind === 'bot',
      text,
    });
  }
  return {
    text: shown.map((m) => m.text).join('\n'),
    messages: shown,
    channel: (thread && thread.channel_name) || null,
    platform: (thread && thread.source) || null,
    customer: (thread && thread.org) || null,
  };
}

/**
 * Applies `rules` to a thread's messages: the facts (`{ field, value }`, unique, at most
 * MAX_PER_FIELD per field, in rule order) and the technologies detected (ids, unique). Script
 * rules need `env`; a failing one is skipped.
 */
export async function extract(env, rules, thread, messages) {
  const bodies = (messages || []).filter((m) => !m.deletedAt).map((m) => String(m.body || ''));
  const text = bodies.join('\n');
  const byField = new Map();
  const tech = new Set();
  const add = (field, value) => {
    const list = byField.get(field) || [];
    if (!list.includes(value) && list.length < MAX_PER_FIELD) {
      list.push(value);
    }
    byField.set(field, list);
  };
  const scripts = rules.filter((r) => r.kind === 'script');
  const ran = scripts.length && env && env.LOADER
    ? await Promise.all(scripts.map((r) => runScript(env, r, scriptInput(thread, messages))))
    : [];
  for (const r of rules) {
    if (r.kind === 'script') {
      const out = ran[scripts.indexOf(r)];
      if (out && !out.error) {
        out.facts.forEach((f) => add(f.field, f.value));
        out.tech.forEach((t) => tech.add(t));
      }
    } else if (r.target === 'tech') {
      if (matches(r, text).length) {
        tech.add(r.field);
      }
    } else {
      matches(r, text).forEach((v) => add(r.field, v));
    }
  }
  const facts = [];
  for (const [field, values] of byField) {
    values.forEach((value) => facts.push({ field, value }));
  }
  return { facts, tech: [...tech] };
}

// ---- configuration --------------------------------------------------------------------------

const ruleOut = (r) => ({
  id: r.id,
  team: r.team,
  name: r.name,
  kind: r.kind,
  target: r.target,
  field: r.field,
  label: r.label || '',
  pattern: r.pattern || '',
  flags: r.flags || '',
  value: r.value || '',
  transform: r.transform || '',
  exclude: r.exclude || '',
  script: r.script || '',
  enabled: Boolean(r.enabled),
  by: r.changed_by || null,
  at: r.changed_at || null,
});
const techOut = (t) => ({
  id: t.id,
  team: t.team,
  tech: t.tech,
  name: t.name,
  description: t.description,
  product: t.product || null,
  aliases: t.aliases || null,
  layer: t.layer || null,
  enabled: Boolean(t.enabled),
  // Compiled from the team's catalog (src/catalog.js): the file, what it is, whose it is.
  path: t.path || null,
  kind: t.kind || null,
  vendor: t.vendor || null,
  by: t.changed_by || null,
  at: t.changed_at || null,
});

/** The rules of `team` (all of them, also those turned off), in the order they run. */
export async function teamRules(env, team) {
  const { results: rows } = await env.DB.prepare(`SELECT * FROM extraction_rules WHERE team = ?
    ORDER BY position, id`).bind(team).all();
  return (rows || []).map(ruleOut);
}

/** The technologies of `team` (all of them, also those turned off), by name. */
export async function teamTech(env, team) {
  const { results: rows } = await env.DB.prepare(`SELECT * FROM tech_stack WHERE team = ?
    ORDER BY name, tech`).bind(team).all();
  return (rows || []).map(techOut);
}

/** The rules that apply to the channels of `team`: the admin team's, then its own; on only. */
export async function rulesFor(env, team) {
  const { results: rows } = await env.DB.prepare(`SELECT * FROM extraction_rules
    WHERE enabled = 1 AND (team = ? OR team = ?)
    ORDER BY team != ?, position, id`).bind(GLOBAL_TEAM, team || GLOBAL_TEAM, GLOBAL_TEAM).all();
  return (rows || []).map(ruleOut);
}

/** Aliases, comma-separated, of `rows`, each name once (the first spelling). */
function joinAliases(rows) {
  const seen = new Map();
  for (const r of rows) {
    for (const a of String(r.aliases || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!seen.has(a.toLowerCase())) {
        seen.set(a.toLowerCase(), a);
      }
    }
  }
  return [...seen.values()].join(', ') || null;
}

/**
 * The technologies Clef asks about in the channels of `team`: the union of every team's. An id
 * `team` has is its own (which may turn it off); any other is shared: the admin team's when it
 * is on, else the first team's by name that is on, with the aliases of every team's that is on.
 * Off only where every team has it off. On only, by id.
 */
export async function techFor(env, team) {
  const { results: rows } = await env.DB.prepare(`SELECT * FROM tech_stack
    ORDER BY tech, team = ? DESC, team = ? DESC, team`).bind(team || GLOBAL_TEAM, GLOBAL_TEAM).all();
  const by = new Map();
  for (const r of rows || []) {
    by.set(r.tech, [...(by.get(r.tech) || []), r]);
  }
  const out = [];
  for (const list of by.values()) {
    const [first] = list;
    if (first.team === team && team !== GLOBAL_TEAM) {
      out.push(first);
    } else {
      // The admin team's first (ordered so), else the first team's by name: the first that is on.
      const on = list.filter((r) => r.enabled);
      if (on.length) {
        out.push({ ...on[0], aliases: joinAliases(on) });
      }
    }
  }
  return out.filter((r) => r.enabled).map(techOut).sort((x, y) => x.tech.localeCompare(y.tech));
}

/**
 * The names of every technology any team has, by id: `team`'s own name, else the admin
 * team's, else another team's.
 */
export async function techNames(env, team = null) {
  if (!env || !env.DB) {
    return {};
  }
  // `team`'s own names first: a team that renamed one of the admin team's sees its name.
  const [{ results: rows }, { results: moved }] = await Promise.all([
    env.DB.prepare(`SELECT tech, name FROM tech_stack
      ORDER BY team = ? DESC, team = ? DESC, team`).bind(team || GLOBAL_TEAM, GLOBAL_TEAM).all(),
    // What labels from before a move name (src/catalog.js): the technology it is now.
    env.DB.prepare('SELECT old, tech FROM tech_moves ORDER BY team = ? DESC, team')
      .bind(GLOBAL_TEAM).all(),
  ]);
  const out = {};
  for (const r of rows || []) {
    out[r.tech] = out[r.tech] || r.name;
  }
  for (const m of moved || []) {
    if (!out[m.old] && out[m.tech]) {
      out[m.old] = out[m.tech];
    }
  }
  return out;
}

/**
 * What the inbox calls the facts of every field a rule labels, by field: the first label of
 * `team`'s rules, else of the admin team's, else of another team's, in the order they run,
 * those turned off too (the facts they found stay). A field no rule labels is not in it.
 */
export async function factLabels(env, team = null) {
  if (!env || !env.DB) {
    return {};
  }
  const { results: rows } = await env.DB.prepare(`SELECT field, label FROM extraction_rules
    WHERE target = 'fact' AND field IS NOT NULL AND label IS NOT NULL AND label != ''
    ORDER BY team = ? DESC, team = ? DESC, team, position, id`)
    .bind(team || GLOBAL_TEAM, GLOBAL_TEAM).all();
  const out = {};
  for (const r of rows || []) {
    out[r.field] = out[r.field] || r.label;
  }
  return out;
}

/**
 * The layer of every technology any team has, by id (src/stack.js), as techNames names them:
 * `team`'s own, else the admin team's, else another team's; a row without one takes the next.
 */
export async function techLayerMap(env, team = null) {
  if (!env || !env.DB) {
    return {};
  }
  const { results: rows } = await env.DB.prepare(`SELECT tech, layer FROM tech_stack
    WHERE layer IS NOT NULL ORDER BY team = ? DESC, team = ? DESC, team`)
    .bind(team || GLOBAL_TEAM, GLOBAL_TEAM).all();
  return techLayers(rows);
}

/** A rule from what someone gave, checked: `{ rule }` or `{ error }`. `old` for an update. */
export function checkRule(input, old = {}) {
  const get = (k) => (input[k] === undefined ? old[k] : input[k]);
  const rule = {
    name: clean(get('name'), MAX_NAME),
    kind: clean(get('kind') || 'regex', 10),
    target: clean(get('target') || 'fact', 10),
    field: clean(get('field'), MAX_TECH_ID),
    label: clean(get('label'), MAX_LABEL).replace(/\s+/g, ' '),
    pattern: String(get('pattern') ?? '').trim(),
    flags: clean(get('flags'), 8),
    value: clean(get('value'), 120),
    transform: clean(get('transform'), 10),
    exclude: String(get('exclude') ?? '').trim(),
    script: String(get('script') ?? ''),
    enabled: get('enabled') === undefined ? true : Boolean(get('enabled')),
  };
  if (!rule.name) {
    return { error: 'give the rule a name: what it finds' };
  }
  if (!KINDS.includes(rule.kind)) {
    return { error: `kind is ${KINDS.join(' or ')}` };
  }
  if (rule.transform && !TRANSFORMS.includes(rule.transform)) {
    return { error: `transform is ${TRANSFORMS.join(' or ')}, or empty` };
  }
  if (rule.kind === 'script') {
    if (!rule.script.trim()) {
      return { error: 'give the script' };
    }
    if (rule.script.length > MAX_SCRIPT) {
      return { error: `a script has at most ${MAX_SCRIPT} characters` };
    }
    if (!/export\s+default/.test(rule.script)) {
      return { error: 'a script default-exports a function: export default function (thread) { … }' };
    }
    return {
      rule: {
        // A script's facts may be of any field: its label names the one it gives, if any.
        ...rule,
        target: 'fact',
        field: rule.field || null,
        label: rule.field ? rule.label : '',
        pattern: '',
        flags: '',
        value: '',
        transform: '',
        exclude: '',
      },
    };
  }
  if (!TARGETS.includes(rule.target)) {
    return { error: `target is ${TARGETS.join(' or ')}` };
  }
  if (rule.target === 'tech' ? !isTechId(rule.field) : !ID.test(rule.field)) {
    return {
      error: rule.target === 'tech' ? 'give the id of the technology it detects: its path in the catalog, such as fastly/cdn, or a short id (lower case, digits and _)'
        : 'give the field it writes: lower case letters, digits and _, such as site or ticket',
    };
  }
  if (rule.pattern.length > MAX_PATTERN || rule.exclude.length > MAX_PATTERN) {
    return { error: `a pattern has at most ${MAX_PATTERN} characters` };
  }
  const compiled = compile(rule);
  if (compiled.error) {
    return { error: compiled.error };
  }
  // A technology is named in the tech stack, not by its rule.
  return { rule: { ...rule, label: rule.target === 'tech' ? '' : rule.label, script: '' } };
}

/** A technology from what someone gave, checked: `{ tech }` or `{ error }`. */
/** Names, comma-separated, each trimmed, once: at most MAX_ALIASES characters in all. */
const MAX_ALIASES = 1000;
function aliasList(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const seen = new Set();
  const names = list.map((n) => String(n ?? '').replace(/\s+/g, ' ').trim())
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  return names.join(', ').slice(0, MAX_ALIASES);
}

export function checkTech(input, old = {}) {
  const get = (k) => (input[k] === undefined ? old[k] : input[k]);
  const tech = {
    tech: clean(get('tech'), 32),
    name: clean(get('name'), MAX_NAME),
    description: clean(get('description'), MAX_DESCRIPTION),
    // The product or category it is part of (migration 0056): none when not given.
    product: clean(get('product'), MAX_NAME) || null,
    // Other names it goes by, for matching the products the threads name (migration 0057).
    aliases: aliasList(get('aliases')) || null,
    // Where in a customer's stack it is (src/stack.js LAYERS, migration 0068): none when not given.
    layer: clean(get('layer'), 16) || null,
    enabled: get('enabled') === undefined ? true : Boolean(get('enabled')),
  };
  if (tech.layer && !LAYER_IDS.includes(tech.layer)) {
    return { error: `layer is one of ${LAYER_IDS.join(', ')}, or empty` };
  }
  if (!ID.test(tech.tech)) {
    return { error: 'give the technology an id: lower case letters, digits and _, such as akamai' };
  }
  if (!tech.name) {
    return { error: 'give the technology the name the inbox shows' };
  }
  if (!tech.description) {
    return { error: 'describe it for Clef, as in "Does this thread show that the customer uses <description>?"' };
  }
  return { tech };
}

/**
 * Saves a rule of `team`, a new one or the one `id` names, as `by`: `{ rule }` or `{ error }`
 * (`status` 404 when `id` is not one of the team's).
 */
export async function saveRule(env, team, input, by) {
  const id = input.id == null ? null : Number(input.id);
  const old = id ? await env.DB.prepare('SELECT * FROM extraction_rules WHERE id = ? AND team = ?')
    .bind(id, team).first() : null;
  if (id && !old) {
    return { error: `no rule ${id} in ${team}`, status: 404 };
  }
  const { rule, error } = checkRule(input, old ? ruleOut(old) : {});
  if (error) {
    return { error };
  }
  const at = new Date().toISOString();
  if (old) {
    await env.DB.prepare(`UPDATE extraction_rules SET name = ?, kind = ?, target = ?, field = ?,
        label = ?, pattern = ?, flags = ?, value = ?, transform = ?, exclude = ?, script = ?,
        enabled = ?, changed_by = ?, changed_at = ? WHERE id = ?`)
      .bind(
        rule.name,
        rule.kind,
        rule.target,
        rule.field,
        rule.label || null,
        rule.pattern,
        rule.flags,
        rule.value,
        rule.transform || null,
        rule.exclude,
        rule.script,
        rule.enabled ? 1 : 0,
        by,
        at,
        id,
      ).run();
  } else {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM extraction_rules WHERE team = ?')
      .bind(team).first();
    if (n >= MAX_RULES) {
      return { error: `a team has at most ${MAX_RULES} rules` };
    }
    const { p } = await env.DB.prepare(`SELECT COALESCE(MAX(position), 0) + 10 AS p
      FROM extraction_rules WHERE team = ?`).bind(team).first();
    await env.DB.prepare(`INSERT INTO extraction_rules (team, name, kind, target, field, label,
        pattern, flags, value, transform, exclude, script, position, enabled, created_by,
        changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        team,
        rule.name,
        rule.kind,
        rule.target,
        rule.field,
        rule.label || null,
        rule.pattern,
        rule.flags,
        rule.value,
        rule.transform || null,
        rule.exclude,
        rule.script,
        p,
        rule.enabled ? 1 : 0,
        by,
        by,
        at,
      ).run();
  }
  const row = old ? await env.DB.prepare('SELECT * FROM extraction_rules WHERE id = ?').bind(id).first()
    : await env.DB.prepare('SELECT * FROM extraction_rules WHERE team = ? ORDER BY id DESC LIMIT 1')
      .bind(team).first();
  return { rule: ruleOut(row) };
}

/** Deletes rule `id` of `team`: `{ ok }` or `{ error, status }`. */
export async function deleteRule(env, team, id) {
  const { meta } = await env.DB.prepare('DELETE FROM extraction_rules WHERE id = ? AND team = ?')
    .bind(Number(id), team).run();
  return meta && meta.changes ? { ok: true } : { error: `no rule ${id} in ${team}`, status: 404 };
}

/** Why a technology of the catalog is not changed here: its file is. */
const catalogOnly = (row, team) => (row.team === team
  ? `${row.name} is kept in kb-team-${row.team} at ${row.path}: change that file (enabled: false turns it off)`
  : `${row.name} is kept in kb-team-${row.team} at ${row.path}: to change it for the channels of ${team}, write the same path in kb-team-${team}`);

/** Saves technology `input.tech` of `team`, new or changed, as `by`: `{ tech }` or `{ error }`. */
export async function saveTech(env, team, input, by) {
  const id = String(input.tech || '').trim();
  const rowOf = (slug) => env.DB.prepare('SELECT * FROM tech_stack WHERE team = ? AND tech = ?')
    .bind(slug, id).first();
  const old = id ? await rowOf(team) : null;
  // A team's first change to one of the admin team's starts from it: `{ tech, enabled: false }`
  // turns it off for the team's channels, `{ tech, name }` renames it there.
  const shared = !old && id && team !== GLOBAL_TEAM ? await rowOf(GLOBAL_TEAM) : null;
  const base = old || shared;
  if (base && base.path) {
    return { error: catalogOnly(base, team) };
  }
  const { tech, error } = checkTech(input, base ? { ...techOut(base), enabled: true } : {});
  if (error) {
    return { error };
  }
  if (!old) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM tech_stack WHERE team = ?')
      .bind(team).first();
    if (n >= MAX_TECH) {
      return { error: `a team has at most ${MAX_TECH} technologies` };
    }
  }
  await env.DB.prepare(`INSERT INTO tech_stack (team, tech, name, description, product, aliases,
      layer, enabled, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (team, tech) DO UPDATE SET name = excluded.name,
      description = excluded.description, product = excluded.product,
      aliases = excluded.aliases, layer = excluded.layer, enabled = excluded.enabled,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(
      team,
      tech.tech,
      tech.name,
      tech.description,
      tech.product,
      tech.aliases,
      tech.layer,
      tech.enabled ? 1 : 0,
      by,
      new Date().toISOString(),
    ).run();
  const row = await env.DB.prepare('SELECT * FROM tech_stack WHERE team = ? AND tech = ?')
    .bind(team, tech.tech).first();
  return { tech: techOut(row) };
}

/** Deletes the technology `tech` of `team`: `{ ok }` or `{ error, status }`. */
export async function deleteTech(env, team, tech) {
  const row = await env.DB.prepare('SELECT * FROM tech_stack WHERE team = ? AND tech = ?')
    .bind(team, String(tech || '')).first();
  if (row && row.path) {
    return { error: catalogOnly(row, team) };
  }
  const { meta } = await env.DB.prepare('DELETE FROM tech_stack WHERE team = ? AND tech = ?')
    .bind(team, String(tech || '')).run();
  return meta && meta.changes ? { ok: true } : { error: `no technology ${tech} in ${team}`, status: 404 };
}

/**
 * What a rule (saved, or as given, unsaved) finds in `text`, or in the messages of a thread:
 * `{ facts, tech }`, or `{ error }` when the rule is not valid or its script failed.
 */
export async function testRule(env, input, { text, thread = null, messages = null } = {}) {
  const { rule, error } = checkRule(input);
  if (error) {
    return { error };
  }
  // Text to try a rule on reads as one message by a customer.
  const list = messages || [{ body: String(text || ''), author: { kind: 'person', name: 'A customer' } }];
  if (rule.kind === 'script') {
    const out = await runScript(env, rule, scriptInput(thread, list));
    return out;
  }
  const found = (await extract(env, [rule], thread, list));
  return found;
}

/** The configuration a team's page shows: its own rules and technologies, and the admin team's. */
export async function config(env, team) {
  const global = team === GLOBAL_TEAM;
  // Asked together: /api/* sends the reads of one tick to D1 as one batch (src/d1batch.js).
  const [rules, tech, globalRules, globalTech] = await Promise.all([
    teamRules(env, team),
    teamTech(env, team),
    global ? null : teamRules(env, GLOBAL_TEAM),
    global ? null : teamTech(env, GLOBAL_TEAM),
  ]);
  return {
    team,
    global,
    rules,
    tech,
    inherited: global ? null : { rules: globalRules, tech: globalTech },
    scripts: Boolean(env.LOADER),
  };
}
