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

/**
 * A person's inbox settings (`person_settings`, one JSON object per person):
 *
 * - `mentions`: a notification when a message mentions them (on unless they turn it off)
 * - `threads`: a notification when someone writes in a thread of theirs, one they posted in, were
 *   mentioned in or put 👀 on (on unless they turn it off)
 * - `bells`: views whose threads notify them when they get a new message. A view is a team's
 *   inbox (its slug) or the personal view (`~personal`), with the filters set on it, picked
 *   (`sel`) and excluded (`not`), by facet: `{ view, sel: { kind: ['incident'] }, not: {} }`.
 * - `traces`: whether the thread agent's thinking shows under a thread (what it is doing while
 *   it works, its note once done); on unless they turn it off.
 * - `channelTraces`: the same, by channel id, where it differs: a channel's wins over `traces`.
 *
 * The browser shows the notifications and the agent's thinking (ui/inbox.js): the server keeps
 * the settings only.
 */
export const DEFAULTS = Object.freeze({
  mentions: true,
  threads: true,
  bells: Object.freeze([]),
  traces: true,
  channelTraces: Object.freeze({}),
});

export const PERSONAL = '~personal';
const MAX_BELLS = 20;
const MAX_FACETS = 20;
const MAX_VALUES = 50;
const MAX_VALUE = 200;
const FACET = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_CHANNELS = 500;
// A channel id on any platform: Slack's C…, Teams' 19:…@thread.tacv2, Discord's digits.
const CHANNEL = /^[^\s]{1,200}$/;

/** Facet id -> sorted, distinct string values; null when it is not a filter set. */
function cleanFilters(f) {
  if (f === undefined || f === null) {
    return {};
  }
  if (typeof f !== 'object' || Array.isArray(f)) {
    return null;
  }
  const entries = Object.entries(f);
  if (entries.length > MAX_FACETS) {
    return null;
  }
  const out = {};
  for (const [id, values] of entries) {
    if (!FACET.test(id) || !Array.isArray(values) || values.length > MAX_VALUES
      || !values.every((v) => typeof v === 'string' && v.length <= MAX_VALUE)) {
      return null;
    }
    if (values.length) {
      out[id] = [...new Set(values)].sort();
    }
  }
  return out;
}

/** The view a bell is on, if it is one of the person's: their team's, or the personal view. */
const viewOf = (me, view) => (view === PERSONAL
  || (me.teams || []).some((t) => t.slug === view) ? view : null);

/** A bell as stored, or null when it is not one. */
export function cleanBell(me, b) {
  if (!b || typeof b !== 'object' || typeof b.view !== 'string') {
    return null;
  }
  const view = viewOf(me, b.view);
  const sel = cleanFilters(b.sel);
  const not = cleanFilters(b.not);
  return view && sel && not ? { view, sel, not } : null;
}

/** The same view with the same filters (bells are compared by value). */
export const bellKey = (b) => JSON.stringify([b.view, Object.entries(b.sel).sort(),
  Object.entries(b.not).sort()]);

/**
 * Settings as the page gets them: the defaults where nothing is stored, and only the bells
 * of views the person still has (a team they left drops out).
 */
export function withDefaults(me, stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const seen = new Set();
  const bells = [];
  for (const b of Array.isArray(s.bells) ? s.bells : []) {
    const c = cleanBell(me, b);
    if (c && !seen.has(bellKey(c))) {
      seen.add(bellKey(c));
      bells.push(c);
    }
  }
  const channelTraces = {};
  const byChannel = s.channelTraces && typeof s.channelTraces === 'object' ? s.channelTraces : {};
  for (const [id, on] of Object.entries(byChannel).slice(0, MAX_CHANNELS)) {
    if (CHANNEL.test(id) && typeof on === 'boolean') {
      channelTraces[id] = on;
    }
  }
  return {
    mentions: typeof s.mentions === 'boolean' ? s.mentions : DEFAULTS.mentions,
    threads: typeof s.threads === 'boolean' ? s.threads : DEFAULTS.threads,
    bells,
    traces: typeof s.traces === 'boolean' ? s.traces : DEFAULTS.traces,
    channelTraces,
  };
}

/** The person's settings, with defaults. */
export async function readSettings(env, me) {
  const row = await env.DB.prepare('SELECT settings FROM person_settings WHERE person = ?')
    .bind(me.id).first();
  let stored = null;
  try {
    stored = row ? JSON.parse(row.settings) : null;
  } catch {
    stored = null;
  }
  return withDefaults(me, stored);
}

/**
 * The settings `now` with what `body` changes (`mentions`, `threads`, `bells`, `traces`,
 * `channelTraces`; `bells` replaces the list, `channelTraces` changes the channels it names, and
 * `null` lets a channel follow `traces` again): `{ settings }`, or `{ error }` when the body is
 * not settings.
 */
export function mergeSettings(me, now, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'expected a JSON object' };
  }
  const next = { ...now };
  for (const key of ['mentions', 'threads']) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') {
        return { error: `\`${key}\` is true or false` };
      }
      next[key] = body[key];
    }
  }
  if ('bells' in body) {
    if (!Array.isArray(body.bells) || body.bells.length > MAX_BELLS) {
      return { error: `\`bells\` is a list of at most ${MAX_BELLS} views` };
    }
    const bells = body.bells.map((b) => cleanBell(me, b));
    if (bells.some((b) => !b)) {
      return { error: 'a bell is { view, sel, not }: one of your teams or ~personal, and filters by facet' };
    }
    next.bells = bells;
  }
  if ('traces' in body) {
    if (typeof body.traces !== 'boolean') {
      return { error: '`traces` is true or false' };
    }
    next.traces = body.traces;
  }
  if ('channelTraces' in body) {
    const changes = body.channelTraces;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
      || !Object.entries(changes).every(([id, on]) => CHANNEL.test(id)
        && (on === null || typeof on === 'boolean'))) {
      return { error: '`channelTraces` is { <channel id>: true, false or null }' };
    }
    const merged = { ...now.channelTraces };
    for (const [id, on] of Object.entries(changes)) {
      if (on === null) {
        delete merged[id];
      } else {
        merged[id] = on;
      }
    }
    if (Object.keys(merged).length > MAX_CHANNELS) {
      return { error: `\`channelTraces\` has at most ${MAX_CHANNELS} channels` };
    }
    next.channelTraces = merged;
  }
  return { settings: withDefaults(me, next) };
}

/** `PUT /api/settings`: changes what the body has, keeps the rest; answers with them all. */
export async function saveSettings(env, me, body) {
  const { settings, error } = mergeSettings(me, await readSettings(env, me), body);
  if (error) {
    return json({ error }, 400);
  }
  await env.DB.prepare(`INSERT INTO person_settings (person, settings, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (person) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
    .bind(me.id, JSON.stringify(settings), new Date().toISOString()).run();
  return json(settings);
}
