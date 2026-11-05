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

import {
  costOf, isStock, metricOf, priceList, serviceOf, SERVICES, unitPrice, VOLUME,
} from './prices.js';
import { dayOf, HOUR_DAYS } from './rollup.js';
import { draftCounts, draftsSince, openDrafts } from '../draftevents.js';

/*
 * The COGS dashboard's numbers (`GET /api/admin/cogs`, the admin team): what the days from `from`
 * to `to` cost at list prices, from `cogs_usage` (src/cogs/rollup.js).
 *
 * Flow (requests, rows, tokens) costs what it used in the period. The estimates (a month at this
 * rate, per message and per thread) only count from the first whole day every source has counted
 * (`estimateWindow`): the day the newest one started is partial, and before it, the period had
 * messages but not all of their cost. A month at this rate divides by the time the window has had
 * so far (today's hours, not a whole day); per message and per thread by the window's messages
 * and new threads, in what is selected. Stock (bytes,
 * vectors, the plan) costs a month: each series' average over the days it was measured, at its
 * price per month.
 *
 * Shared costs (work for nobody in particular: the inbox's lists, the cron, the buckets) are
 * spread over the customers and teams by their share of the period's messages (`allocate`, the
 * default; `allocate=none` keeps them as "Shared"), a team's own shared costs over its customers.
 * Filters (customer, team, service) apply after that, so a customer's cost includes its share.
 *
 * D1 adds the days up (a row per series for the period, however long), and the chart's columns
 * without the customers (but for those picked, and the shared rows by team), so the answer stays
 * small for a long period too. The three sources count different metrics, so they add up.
 *
 * The chart has about as many columns whatever the period (`chartUnit`): an hour each for a week
 * or less (from `cogs_hours`, while it has the hours), a day each up to DAILY_DAYS, a week (from
 * Monday, UTC) each for longer.
 */

const MAX_DAYS = 400;
const DEFAULT_DAYS = 30;
/** The longest period charted by the hour, and by the day. */
const HOURLY_DAYS = 7;
const DAILY_DAYS = 45;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHARED = '';

const ms = (day) => Date.parse(`${day}T00:00:00Z`);
/** A list parameter; `(shared)` (a customer) and `(none)` (a team) stand for the shared rows. */
const csv = (v) => [...new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => (s === '(shared)' || s === '(none)' ? SHARED : s)))];

/** The period asked for: `from` and `to`, both included, at most MAX_DAYS. */
export function period(url, now = Date.now()) {
  const today = dayOf(now);
  const asked = (k) => (DAY.test(url.searchParams.get(k) || '') ? url.searchParams.get(k) : null);
  let to = asked('to') || today;
  let from = asked('from') || dayOf(ms(to) - (DEFAULT_DAYS - 1) * DAY_MS);
  if (from > to) {
    [from, to] = [to, from];
  }
  const days = Math.round((ms(to) - ms(from)) / DAY_MS) + 1;
  if (days > MAX_DAYS) {
    return { from: dayOf(ms(to) - (MAX_DAYS - 1) * DAY_MS), to, days: MAX_DAYS };
  }
  return { from, to, days };
}

/**
 * How long the chart's columns are for the period: `hour`, `day` or `week`. By the hour only while
 * `cogs_hours` has the period's hours (the rollup keeps them for HOUR_DAYS, backfills one less).
 */
export function chartUnit({ from, days }, now = Date.now()) {
  if (days <= HOURLY_DAYS && from >= dayOf(now - (HOUR_DAYS - 1) * DAY_MS)) {
    return 'hour';
  }
  return days <= DAILY_DAYS ? 'day' : 'week';
}

const pad = (n) => String(n).padStart(2, '0');
/**
 * The part of the period the estimates count, `{ from, days }`: from the first whole day of the
 * source that started last (`since`: each source's first day), up to `now` (`days`, fractional).
 * Null when the period ends before it.
 */
export function estimateWindow({ from, to }, since, now = Date.now()) {
  const firsts = Object.values(since || {}).filter((d) => DAY.test(d || ''));
  const whole = firsts.length ? dayOf(ms(firsts.sort().at(-1)) + DAY_MS) : from;
  const start = whole > from ? whole : from;
  const days = (Math.min(now, ms(to) + DAY_MS) - ms(start)) / DAY_MS;
  return start <= to && days > 0 ? { from: start, days } : null;
}

/** The Monday of `day`'s week (UTC). */
const mondayOf = (day) => dayOf(ms(day) - ((new Date(ms(day)).getUTCDay() + 6) % 7) * DAY_MS);

/**
 * The chart's columns, `{ at, services }` (and `until`, a week's last day): an hour's `at` is
 * `YYYY-MM-DDTHH:00:00Z`, up to the hour of `now`; a day's and a week's `YYYY-MM-DD`, a week cut
 * to the period. `costs` maps a day (and hour, `YYYY-MM-DD HH`) to its costs per service.
 */
export function columns(unit, from, to, costs, now = Date.now()) {
  const out = [];
  const take = (key) => costs.get(key) || {};
  if (unit === 'hour') {
    for (let d = from; d <= to; d = dayOf(ms(d) + DAY_MS)) {
      for (let h = 0; h < 24 && ms(d) + h * HOUR_MS <= now; h += 1) {
        out.push({ at: `${d}T${pad(h)}:00:00Z`, services: take(`${d} ${pad(h)}`) });
      }
    }
    return out;
  }
  for (let d = from; d <= to; d = dayOf(ms(d) + DAY_MS)) {
    if (unit === 'day') {
      out.push({ at: d, services: take(d) });
    } else {
      const last = out[out.length - 1];
      if (!last || mondayOf(d) !== mondayOf(last.at)) {
        out.push({ at: d, until: d, services: {} });
      }
      const col = out[out.length - 1];
      col.until = d;
      for (const [id, v] of Object.entries(take(d))) {
        col.services[id] = (col.services[id] || 0) + v;
      }
    }
  }
  return out;
}

/**
 * How much of a shared row of `team` (`''`: nobody's) goes to whom: `weights` maps `org|team` to
 * the period's messages; a team's row goes to that team's customers, nobody's to everyone. Null
 * without messages to go by: the row stays shared.
 */
export function shares(weights, team) {
  const among = [...weights].filter(([k, w]) => w > 0 && (!team || k.slice(k.indexOf('|') + 1) === team));
  const total = among.reduce((n, [, w]) => n + w, 0);
  return total ? among.map(([k, w]) => [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1), w / total]) : null;
}

/** Shared rows (`org` ''), spread over customers and teams by `weights` (see `shares`). */
export function allocate(rows, weights) {
  const out = [];
  const cache = new Map();
  for (const r of rows) {
    if (r.org !== SHARED) {
      out.push(r);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!cache.has(r.team)) {
      cache.set(r.team, shares(weights, r.team));
    }
    const split = cache.get(r.team);
    if (!split) {
      out.push(r);
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const [org, team, part] of split) {
      out.push({
        ...r, org, team, quantity: r.quantity * part, usd: r.usd * part, shared: true,
      });
    }
  }
  return out;
}

const sum = (rows, f = (r) => r.usd) => rows.reduce((n, r) => n + f(r), 0);
const per = (usd, n) => (n > 0 ? usd / n : null);
const known = (r) => r.service !== VOLUME && serviceOf(r.service) && metricOf(r.service, r.metric);
/** A row's cost: a flow's for the period, a stock's a month at its average. */
const usdOf = (r) => (isStock(r.service, r.metric)
  ? costOf(r.service, r.metric, r.detail, r.quantity / Math.max(1, r.days))
  : costOf(r.service, r.metric, r.detail, r.quantity));

/** The stock metrics, for SQL: the chart has flow only. */
const STOCKS = SERVICES.flatMap((s) => s.metrics.filter((m) => m.stock).map((m) => `${s.id}/${m.id}`));

/** Every series of the period, its days added up (a stock's over the days it was measured). */
async function seriesOf(env, from, to) {
  const { results } = await env.DB.prepare(`SELECT service, metric, detail, org, team,
      SUM(quantity) AS quantity, COUNT(DISTINCT day) AS days
    FROM cogs_usage WHERE day >= ? AND day <= ?
    GROUP BY service, metric, detail, org, team`).bind(from, to).all();
  return results || [];
}

/** What became of the agents' drafts (src/draftevents.js), as `volume` rows of the period. */
export const DRAFT_METRICS = ['agent_drafts', 'drafts_sent', 'drafts_edited', 'drafts_discarded',
  'drafts_withdrawn', 'agent_posts'];

async function draftRows(env, from, to) {
  const counts = await draftCounts(env, new Date(ms(from)).toISOString(), new Date(ms(to) + DAY_MS)
    .toISOString()).catch(() => []);
  return counts.flatMap((r) => DRAFT_METRICS.filter((m) => r[m] > 0).map((metric) => ({
    service: VOLUME, metric, detail: '', org: r.org || '', team: r.team || '', quantity: r[metric], days: 1,
  })));
}

/** Every series of the period (`seriesOf`) and its drafts (`draftRows`). */
async function periodRows(env, from, to) {
  const [rows, drafts] = await Promise.all([seriesOf(env, from, to), draftRows(env, from, to)]);
  return [...rows, ...drafts];
}

/** The agents' drafts a person sent, as they were or edited. */
const acceptedOf = (d) => (d.drafts_sent || 0) + (d.drafts_edited || 0);

/**
 * The flow per day (`hourly`: and hour) and service, of what is selected: the rows of the
 * customers picked (all, when none are), and the shared ones by team, to be shared out.
 */
async function chartRows(env, from, to, orgs, teams, hourly) {
  const filters = [];
  const binds = [from, to, ...STOCKS];
  if (orgs.length) {
    filters.push(`(org = '' OR org IN (${orgs.map(() => '?').join(', ')}))`);
    binds.push(...orgs);
  }
  const { results } = await env.DB.prepare(`SELECT day, ${hourly ? 'hour' : '0'} AS hour,
      service, metric, detail,
      CASE WHEN org = '' THEN '' ELSE '*' END AS who, CASE WHEN org = '' THEN team ELSE '' END AS pool,
      ${orgs.length ? "CASE WHEN org = '' THEN '' ELSE org END" : "''"} AS org,
      ${teams.length ? 'team' : "''"} AS team, SUM(quantity) AS quantity
    FROM ${hourly ? 'cogs_hours' : 'cogs_usage'} WHERE day >= ? AND day <= ? AND service != 'volume'
      AND service || '/' || metric NOT IN (${STOCKS.map(() => '?').join(', ')})
      ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
    GROUP BY day, 2, service, metric, detail, who, pool, 8, 9`).bind(...binds).all();
  return results || [];
}

/**
 * A period's rows (`seriesOf`) priced and shared out: `volume`, the message `weights`, the priced
 * `rows` (shared out, unless not `spread`), and `unpriced`.
 */
function costed(rows, spread) {
  const volume = rows.filter((r) => r.service === VOLUME);
  const weights = new Map();
  for (const r of volume.filter((v) => v.metric === 'messages')) {
    const k = `${r.org}|${r.team}`;
    weights.set(k, (weights.get(k) || 0) + r.quantity);
  }
  const priced = rows.filter(known).map((r) => ({
    ...r,
    // A stock's quantity is its average over the days it was measured.
    quantity: isStock(r.service, r.metric) ? r.quantity / Math.max(1, r.days) : r.quantity,
    usd: usdOf(r),
  }));
  // Counted, but not priced here (a new model): shown, so that the price list can follow.
  const unpriced = [...new Set(rows
    .filter((r) => r.service !== VOLUME && (!known(r) || !unitPrice(r.service, r.metric, r.detail)))
    .map((r) => `${r.service}/${r.metric}${r.detail ? ` (${r.detail})` : ''}`))];
  return {
    volume, weights, rows: spread ? allocate(priced, weights) : priced, unpriced,
  };
}

/**
 * What `c` (`costed`) adds up to, in what `pick` and `inServices` select: flow, stock, messages
 * and threads, flow per service, and per customer and team (`group`: every customer, or team, of
 * the other filter).
 */
function totalsOf(c, {
  pick, inServices, orgs, teams,
}) {
  const chosen = c.rows.filter((r) => pick(r) && inServices(r));
  const vol = c.volume.filter(pick);
  const flowBy = new Map();
  for (const r of chosen.filter((x) => !isStock(x.service, x.metric))) {
    flowBy.set(r.service, (flowBy.get(r.service) || 0) + r.usd);
  }
  const group = (key) => {
    const m = new Map();
    const of = (k) => m.get(k) || m.set(k, {
      key: k, flow: 0, shared: 0, stock: 0, messages: 0, threads: 0,
    }).get(k);
    const otherFilter = key === 'org' ? (r) => !teams.length || teams.includes(r.team)
      : (r) => !orgs.length || orgs.includes(r.org);
    for (const r of c.rows.filter((x) => inServices(x) && otherFilter(x))) {
      const g = of(r[key]);
      if (isStock(r.service, r.metric)) {
        g.stock += r.usd;
      } else {
        g.flow += r.usd;
        g.shared += r.shared ? r.usd : 0;
      }
    }
    for (const r of c.volume.filter(otherFilter)) {
      const g = of(r[key]);
      g.messages += r.metric === 'messages' ? r.quantity : 0;
      g.threads += r.metric === 'threads' ? r.quantity : 0;
      if (DRAFT_METRICS.includes(r.metric)) {
        g.drafts = g.drafts || {};
        g.drafts[r.metric] = (g.drafts[r.metric] || 0) + r.quantity;
      }
    }
    return m;
  };
  const drafts = Object.fromEntries(DRAFT_METRICS.map((metric) => [metric,
    sum(vol.filter((r) => r.metric === metric), (r) => r.quantity)]));
  return {
    chosen,
    drafts,
    flow: sum(chosen.filter((r) => !isStock(r.service, r.metric))),
    stock: sum(chosen.filter((r) => isStock(r.service, r.metric))),
    messages: sum(vol.filter((r) => r.metric === 'messages'), (r) => r.quantity),
    threads: sum(vol.filter((r) => r.metric === 'threads'), (r) => r.quantity),
    flowBy,
    org: group('org'),
    team: group('team'),
  };
}

/** The dashboard's numbers. `url`'s parameters: from, to, service, org, team, allocate. */
export async function cogsReport(env, url, { now = Date.now() } = {}) {
  const { from, to, days } = period(url, now);
  const unit = chartUnit({ from, days }, now);
  const services = csv(url.searchParams.get('service'));
  const orgs = csv(url.searchParams.get('org'));
  const teams = csv(url.searchParams.get('team'));
  const spread = url.searchParams.get('allocate') !== 'none';

  const [rows, dayRows, firstDay, firstDraft, open] = await Promise.all([
    periodRows(env, from, to),
    chartRows(env, from, to, orgs, teams, unit === 'hour'),
    env.DB.prepare('SELECT source, MIN(day) AS day FROM cogs_usage GROUP BY source').all()
      .then((r) => r.results || []).catch(() => []),
    draftsSince(env).catch(() => null),
    openDrafts(env).catch(() => []),
  ]);
  const since = Object.fromEntries(firstDay.map((r) => [r.source, r.day]));
  const estimate = estimateWindow({ from, to }, since, now);
  // Per accepted draft counts from the first whole day of the drafts' events too.
  const draftsDay = firstDraft ? firstDraft.slice(0, 10) : null;
  const draftEstimate = draftsDay
    ? estimateWindow({ from, to }, { ...since, drafts: draftsDay }, now) : null;

  const pick = (r) => (!orgs.length || orgs.includes(r.org))
    && (!teams.length || teams.includes(r.team));
  const inServices = (r) => !services.length || services.includes(r.service);
  const select = {
    pick, inServices, orgs, teams,
  };
  const c = costed(rows, spread);
  const { weights, unpriced } = c;
  const all = totalsOf(c, select);
  // The estimates' part of the period: the same rows when it is the whole of it.
  const totalsFrom = async (start) => (start === from ? all
    : totalsOf(costed(await periodRows(env, start, to), spread), select));
  const est = estimate ? await totalsFrom(estimate.from) : null;
  let estD = null;
  if (draftEstimate) {
    estD = est && draftEstimate.from === estimate.from ? est : await totalsFrom(draftEstimate.from);
  }
  const perOf = (flow, n) => (est ? per(flow, n) : null);
  const perDraftOf = (flow) => (estD ? per(flow, acceptedOf(estD.drafts)) : null);
  const { chosen, messages, threads } = all;
  const flowUsd = all.flow;

  const byService = SERVICES.map((s) => {
    const mine = chosen.filter((r) => r.service === s.id);
    const metrics = new Map();
    for (const r of mine) {
      const k = `${r.metric}\u0000${r.detail}`;
      const m = metrics.get(k) || {
        metric: r.metric,
        detail: r.detail,
        quantity: 0,
        usd: 0,
        stock: isStock(r.service, r.metric),
      };
      m.quantity += r.quantity;
      m.usd += r.usd;
      metrics.set(k, m);
    }
    const estFlow = est ? est.flowBy.get(s.id) || 0 : 0;
    return {
      id: s.id,
      name: s.name,
      flow: all.flowBy.get(s.id) || 0,
      stock: sum(mine.filter((r) => isStock(r.service, r.metric))),
      perMessage: perOf(estFlow, est?.messages),
      perThread: perOf(estFlow, est?.threads),
      perAcceptedDraft: perDraftOf(estD ? estD.flowBy.get(s.id) || 0 : 0),
      metrics: [...metrics.values()].map((m) => {
        const def = metricOf(s.id, m.metric);
        const p = unitPrice(s.id, m.metric, m.detail);
        return {
          ...m, label: def.label, unit: def.unit, per: p ? p.per : null, price: p ? p.usd : null,
        };
      }).sort((a, b) => b.usd - a.usd || b.quantity - a.quantity),
    };
  }).filter((s) => s.metrics.length).sort((a, b) => (b.flow + b.stock) - (a.flow + a.stock));

  // The chart: what is picked's own, and its share of the shared rows (or the shared rows, when
  // they are not shared out and Shared is picked, or nobody is).
  const part = new Map();
  const shareOf = (pool) => {
    if (!part.has(pool)) {
      const split = spread ? shares(weights, pool) : null;
      let v;
      if (split) {
        v = split.filter(([org, team]) => pick({ org, team })).reduce((n, [, , p]) => n + p, 0);
      } else {
        v = pick({ org: SHARED, team: pool }) ? 1 : 0;
      }
      part.set(pool, v);
    }
    return part.get(pool);
  };
  const costs = new Map();
  for (const r of dayRows) {
    if (!known(r) || !inServices(r)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const f = r.who === SHARED ? shareOf(r.pool) : Number(pick(r));
    const usd = f ? costOf(r.service, r.metric, r.detail, r.quantity) * f : 0;
    if (usd) {
      const key = unit === 'hour' ? `${r.day} ${pad(r.hour)}` : r.day;
      const d = costs.get(key) || {};
      d[r.service] = (d[r.service] || 0) + usd;
      costs.set(key, d);
    }
  }

  // Customers and teams: what they cost, of what is selected (but every customer, or team), and
  // per message and thread in the estimates' part of the period.
  const group = (key) => [...all[key].values()].map(({ drafts: gd = {}, ...g }) => {
    const e = est ? est[key].get(g.key) : null;
    const ed = estD ? estD[key].get(g.key) : null;
    return {
      ...g,
      accepted: acceptedOf(gd),
      agentPosts: gd.agent_posts || 0,
      perMessage: e ? per(e.flow, e.messages) : null,
      perThread: e ? per(e.flow, e.threads) : null,
      perAcceptedDraft: ed ? per(ed.flow, acceptedOf(ed.drafts || {})) : null,
    };
  }).sort((a, b) => b.flow - a.flow || b.messages - a.messages);

  // The agents' drafts of what is selected: what became of them in the period, and those open.
  const dr = all.drafts;
  const accepted = acceptedOf(dr);
  const decided = accepted + dr.drafts_discarded + dr.drafts_withdrawn;
  const drafts = {
    started: dr.agent_drafts,
    sent: dr.drafts_sent,
    edited: dr.drafts_edited,
    discarded: dr.drafts_discarded,
    withdrawn: dr.drafts_withdrawn,
    agentPosts: dr.agent_posts,
    accepted,
    decided,
    acceptance: decided ? accepted / decided : null,
    open: sum(open.filter(pick), (r) => r.n),
    estimate: draftEstimate,
  };

  const [orgNames, teamNames] = await Promise.all([
    env.DB.prepare('SELECT slug, name, type FROM orgs').all().then((r) => r.results || []).catch(() => []),
    env.DB.prepare('SELECT slug, name FROM teams').all().then((r) => r.results || []).catch(() => []),
  ]);
  const orgInfo = new Map(orgNames.map((o) => [o.slug, o]));
  const teamInfo = new Map(teamNames.map((t) => [t.slug, t]));

  return {
    from,
    to,
    days,
    allocate: spread ? 'messages' : 'none',
    filters: { service: services, org: orgs, team: teams },
    estimate,
    totals: {
      flow: flowUsd,
      flowMonthly: est ? (est.flow / estimate.days) * 30.44 : null,
      stock: all.stock,
      messages,
      threads,
      perMessage: perOf(est?.flow, est?.messages),
      perThread: perOf(est?.flow, est?.threads),
      perAcceptedDraft: perDraftOf(estD?.flow),
      perAgentReply: estD
        ? per(estD.flow, acceptedOf(estD.drafts) + estD.drafts.agent_posts) : null,
    },
    drafts,
    services: byService,
    chart: { unit, columns: columns(unit, from, to, costs, now) },
    orgs: group('org').map((g) => ({
      ...g,
      org: g.key,
      name: g.key === SHARED ? 'Shared' : (orgInfo.get(g.key)?.name || g.key),
      type: orgInfo.get(g.key)?.type || (g.key === SHARED ? 'shared' : 'customer'),
    })),
    teams: group('team').map((g) => ({
      ...g,
      team: g.key,
      name: g.key === SHARED ? 'No team' : (teamInfo.get(g.key)?.name || g.key),
    })),
    since: { ...since, ...(draftsDay ? { drafts: draftsDay } : {}) },
    unpriced,
    prices: priceList(),
  };
}
