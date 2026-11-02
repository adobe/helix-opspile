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
import { dayOf } from './rollup.js';

/*
 * The COGS dashboard's numbers (`GET /api/admin/cogs`, the admin team): what the days from `from`
 * to `to` cost at list prices, from `cogs_usage` (src/cogs/rollup.js).
 *
 * Flow (requests, rows, tokens) costs what it used in the period, and per message and per thread:
 * divided by the messages and the new threads of the period, in what is selected. Stock (bytes,
 * vectors, the plan) costs a month: each series' average over the days it was measured, at its
 * price per month.
 *
 * Shared costs (work for nobody in particular: the inbox's lists, the cron, the buckets) are
 * spread over the customers and teams by their share of the period's messages (`allocate`, the
 * default; `allocate=none` keeps them as "Shared"), a team's own shared costs over its customers.
 * Filters (customer, team, service) apply after that, so a customer's cost includes its share.
 *
 * D1 adds the days up (a row per series for the period, however long), and the chart's days
 * without the customers (but for those picked, and the shared rows by team), so the answer stays
 * small for a long period too. The three sources count different metrics, so they add up.
 */

const MAX_DAYS = 400;
const DEFAULT_DAYS = 30;
const DAY_MS = 86400000;
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

/**
 * The flow per day and service, of what is selected: the rows of the customers picked (all, when
 * none are), and the shared ones by team, to be shared out.
 */
async function daysOf(env, from, to, orgs, teams) {
  const filters = [];
  const binds = [from, to, ...STOCKS];
  if (orgs.length) {
    filters.push(`(org = '' OR org IN (${orgs.map(() => '?').join(', ')}))`);
    binds.push(...orgs);
  }
  const { results } = await env.DB.prepare(`SELECT day, service, metric, detail,
      CASE WHEN org = '' THEN '' ELSE '*' END AS who, CASE WHEN org = '' THEN team ELSE '' END AS pool,
      ${orgs.length ? "CASE WHEN org = '' THEN '' ELSE org END" : "''"} AS org,
      ${teams.length ? 'team' : "''"} AS team, SUM(quantity) AS quantity
    FROM cogs_usage WHERE day >= ? AND day <= ? AND service != 'volume'
      AND service || '/' || metric NOT IN (${STOCKS.map(() => '?').join(', ')})
      ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
    GROUP BY day, service, metric, detail, who, pool, 7, 8`).bind(...binds).all();
  return results || [];
}

/** The dashboard's numbers. `url`'s parameters: from, to, service, org, team, allocate. */
export async function cogsReport(env, url, { now = Date.now() } = {}) {
  const { from, to, days } = period(url, now);
  const services = csv(url.searchParams.get('service'));
  const orgs = csv(url.searchParams.get('org'));
  const teams = csv(url.searchParams.get('team'));
  const spread = url.searchParams.get('allocate') !== 'none';

  const [rows, dayRows] = await Promise.all([
    seriesOf(env, from, to),
    daysOf(env, from, to, orgs, teams),
  ]);

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
  const spreadRows = spread ? allocate(priced, weights) : priced;

  const pick = (r) => (!orgs.length || orgs.includes(r.org))
    && (!teams.length || teams.includes(r.team));
  const inServices = (r) => !services.length || services.includes(r.service);
  const chosen = spreadRows.filter((r) => pick(r) && inServices(r));
  const flow = chosen.filter((r) => !isStock(r.service, r.metric));
  const stock = chosen.filter((r) => isStock(r.service, r.metric));
  const vol = volume.filter(pick);
  const messages = sum(vol.filter((r) => r.metric === 'messages'), (r) => r.quantity);
  const threads = sum(vol.filter((r) => r.metric === 'threads'), (r) => r.quantity);
  const flowUsd = sum(flow);

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
    const flowS = sum(mine.filter((r) => !isStock(r.service, r.metric)));
    return {
      id: s.id,
      name: s.name,
      flow: flowS,
      stock: sum(mine.filter((r) => isStock(r.service, r.metric))),
      perMessage: per(flowS, messages),
      perThread: per(flowS, threads),
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
  const dailyMap = new Map();
  for (const r of dayRows) {
    if (!known(r) || !inServices(r)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const f = r.who === SHARED ? shareOf(r.pool) : Number(pick(r));
    const usd = f ? costOf(r.service, r.metric, r.detail, r.quantity) * f : 0;
    if (usd) {
      const d = dailyMap.get(r.day) || {};
      d[r.service] = (d[r.service] || 0) + usd;
      dailyMap.set(r.day, d);
    }
  }
  const daily = [];
  for (let d = from; d <= to; d = dayOf(ms(d) + DAY_MS)) {
    daily.push({ day: d, services: dailyMap.get(d) || {} });
  }

  // Customers and teams: what they cost, of what is selected (but every customer, or team).
  const group = (key) => {
    const m = new Map();
    const of = (k) => m.get(k) || m.set(k, {
      key: k, flow: 0, shared: 0, stock: 0, messages: 0, threads: 0,
    }).get(k);
    const otherFilter = key === 'org' ? (r) => !teams.length || teams.includes(r.team)
      : (r) => !orgs.length || orgs.includes(r.org);
    for (const r of spreadRows.filter((x) => inServices(x) && otherFilter(x))) {
      const g = of(r[key]);
      if (isStock(r.service, r.metric)) {
        g.stock += r.usd;
      } else {
        g.flow += r.usd;
        g.shared += r.shared ? r.usd : 0;
      }
    }
    for (const r of volume.filter(otherFilter)) {
      const g = of(r[key]);
      g.messages += r.metric === 'messages' ? r.quantity : 0;
      g.threads += r.metric === 'threads' ? r.quantity : 0;
    }
    return [...m.values()].map((g) => ({
      ...g, perMessage: per(g.flow, g.messages), perThread: per(g.flow, g.threads),
    })).sort((a, b) => b.flow - a.flow || b.messages - a.messages);
  };

  const [orgNames, teamNames, firstDay] = await Promise.all([
    env.DB.prepare('SELECT slug, name, type FROM orgs').all().then((r) => r.results || []).catch(() => []),
    env.DB.prepare('SELECT slug, name FROM teams').all().then((r) => r.results || []).catch(() => []),
    env.DB.prepare('SELECT source, MIN(day) AS day FROM cogs_usage GROUP BY source').all()
      .then((r) => r.results || []).catch(() => []),
  ]);
  const orgInfo = new Map(orgNames.map((o) => [o.slug, o]));
  const teamInfo = new Map(teamNames.map((t) => [t.slug, t]));

  return {
    from,
    to,
    days,
    allocate: spread ? 'messages' : 'none',
    filters: { service: services, org: orgs, team: teams },
    totals: {
      flow: flowUsd,
      flowMonthly: (flowUsd / days) * 30.44,
      stock: sum(stock),
      messages,
      threads,
      perMessage: per(flowUsd, messages),
      perThread: per(flowUsd, threads),
    },
    services: byService,
    daily,
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
    since: Object.fromEntries(firstDay.map((r) => [r.source, r.day])),
    unpriced,
    prices: priceList(),
  };
}
