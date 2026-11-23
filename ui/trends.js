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

/*
 * The counting of the Topics page's trends (ui/trendview.js draws them), over what
 * GET /api/topics/trends sends (src/trends.js `trendsData`): a thread is
 * `[id, week, channel, org, team, source, kind, topic, areas, tech, weeks]`, `weeks` its messages
 * as `[week, count, …]`. Its global `Trends`, with nothing of the page in it, so Node tests it.
 *
 * A week counts in one of three units:
 * - `channels` (the default): the channels with a message in a matching thread that week, each
 *   once, of the channels with any. A chatty channel counts no more than a quiet one, as a person
 *   searching ten times counts once in Google Trends, and the history import (more, shorter
 *   threads, never re-threaded) counts as the live inbox does.
 * - `messages`: the messages of the matching threads, by the week each was written.
 * - `threads`: the matching threads, in the week each started.
 *
 * What is moving (`moving`) is said of each topic, area or technology from three things: how
 * often it comes up (its channel-weeks: absolute), how much more or less often than before (its
 * share now against its share in the BASE weeks before: relative, and as a Poisson z, how sure
 * that is for so many), and whether that is speeding up or slowing down (the slope of its share
 * over the last weeks against the slope of the weeks before: acceleration). So:
 * - **trending**: up on before, surely, often enough, and not falling again; the faster it is
 *   rising, the higher.
 * - **declining**: down on before, surely, from often enough.
 * - **peaked**: it had a peak, well above what is usual for it (1.8 times), that is over: its
 *   peak is more than PEAK_AGO weeks back and it is at most 60% of it now. What is trending
 *   again is not listed as peaked, nor what peaked as declining.
 * Each is also said of how many customers it is about, and whether it is mostly one's: one
 * customer's project is not a trend, and counts half.
 */
(() => {
  const RECENT = 6;
  const BASE = 12;
  const PEAK_AGO = 4;
  const UNITS = ['channels', 'messages', 'threads'];
  // The least a list counts from, in channel-weeks (a message is less: MESSAGE_FACTOR times).
  const MIN_RECENT = 6;
  const MIN_BASE = 8;
  const MIN_SEEN = 2;
  const MIN_PEAK = 12;
  const MESSAGE_FACTOR = 4;
  const MOSTLY_ONE = 0.6;

  const I = {
    id: 0, week: 1, channel: 2, org: 3, team: 4, source: 5, kind: 6, topic: 7, areas: 8, tech: 9, weeks: 10,
  };

  /** The weeks a thread counts in, with how much, in `unit`. */
  function parts(t, unit) {
    if (unit === 'threads') return [[t[I.week], 1]];
    const w = t[I.weeks];
    const out = [];
    for (let i = 0; i < w.length; i += 2) out.push([w[i], unit === 'messages' ? w[i + 1] : 1]);
    return out;
  }

  /**
   * Per week, in `unit`, the threads `pick` keeps: `{ counts, orgs }`, `orgs` per week the units
   * of each customer (by its index).
   */
  function weekly(data, pick, unit = 'channels') {
    const n = data.weeks.length;
    const counts = new Array(n).fill(0);
    const orgs = Array.from({ length: n }, () => new Map());
    const seen = new Set();
    for (const t of data.threads) {
      if (!pick(t)) continue;
      for (const [w, c] of parts(t, unit)) {
        if (unit === 'channels') {
          const k = t[I.channel] * 1024 + w;
          if (seen.has(k)) continue;
          seen.add(k);
        }
        counts[w] += c;
        orgs[w].set(t[I.org], (orgs[w].get(t[I.org]) || 0) + c);
      }
    }
    return { counts, orgs };
  }

  /** The mean of `a` over `r` weeks each side (fewer at the ends). */
  function smooth(a, r) {
    if (!r) return [...a];
    return a.map((_, i) => {
      let s = 0;
      let k = 0;
      for (let j = Math.max(0, i - r); j <= Math.min(a.length - 1, i + r); j += 1) {
        s += a[j];
        k += 1;
      }
      return s / k;
    });
  }

  const sum = (a, from, to) => {
    let s = 0;
    for (let i = Math.max(0, from); i <= to; i += 1) s += a[i] || 0;
    return s;
  };

  /** The least-squares slope of `a` from `from` to `to`. */
  function slope(a, from, to) {
    const xs = [];
    for (let i = Math.max(0, from); i <= to; i += 1) xs.push(i);
    if (xs.length < 2) return 0;
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = xs.reduce((s, x) => s + a[x], 0) / xs.length;
    let num = 0;
    let den = 0;
    for (const x of xs) {
      num += (x - mx) * (a[x] - my);
      den += (x - mx) ** 2;
    }
    return den ? num / den : 0;
  }

  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  /**
   * What a series says: `counts` and `totals` per week, `last` the newest full week, `first` the
   * first with anything. Shares are of the totals; the slopes are per week, as a fraction of its
   * usual share (so a rare topic doubling is as fast as a common one doubling).
   */
  function stats(counts, totals, { last, first = 0 }) {
    const rA = last - RECENT + 1;
    const bA = Math.max(first, rA - BASE);
    const cR = sum(counts, rA, last);
    const nR = sum(totals, rA, last);
    const cB = sum(counts, bA, rA - 1);
    const nB = sum(totals, bA, rA - 1);
    const pB = (cB + 0.5) / (nB + 1);
    const expected = pB * nR;
    const z = (cR - expected) / Math.sqrt(expected + 1);
    const lift = ((cR + 0.5) / (nR + 1)) / pB;
    const share = counts.map((c, i) => (totals[i] ? c / totals[i] : 0));
    const s = smooth(share, 1);
    const shown = s.slice(first, last + 1);
    const usual = shown.reduce((a, b) => a + b, 0) / (shown.length || 1) || 1e-9;
    const rising = slope(s, last - 3, last) / usual;
    const before = slope(s, last - 7, last - 4) / usual;
    // The peak, of a smoother line: a peak is weeks of it, not one busy week.
    const wide = smooth(share, 2);
    let peak = first;
    for (let i = first; i <= last; i += 1) if (wide[i] > wide[peak]) peak = i;
    const now = (wide[last] + wide[last - 1] + wide[last - 2]) / 3;
    return {
      recent: cR,
      base: cB,
      perWeek: cR / RECENT,
      lift,
      z,
      slope: rising,
      accel: rising - before,
      peak: {
        week: peak, share: wide[peak], count: sum(counts, peak - 2, peak + 2),
      },
      now,
      usual: median(wide.slice(first, last + 1).filter((_, i) => totals[first + i] > 0)),
    };
  }

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  /** The customers of some weeks of a series: `{ orgs, top }`, `top` the biggest one's share. */
  function customers(orgs, from, to) {
    const by = new Map();
    for (let w = Math.max(0, from); w <= to; w += 1) {
      for (const [o, c] of orgs[w] || []) by.set(o, (by.get(o) || 0) + c);
    }
    const all = [...by.values()].reduce((a, b) => a + b, 0);
    return { orgs: by.size, top: all ? Math.max(...by.values()) / all : 0 };
  }

  /**
   * How a series is moving: `{ trending, declining, peaked }`, a score each or null, from its
   * `stats` and the customers of its weeks. `factor` scales the least counted (messages).
   */
  function classify(st, orgs, { last, first = 0, factor = 1 }) {
    const rA = last - RECENT + 1;
    const out = { trending: null, declining: null, peaked: null };
    // Up on a before it had: what was never there before is new to Clef (an area just added).
    if (st.recent >= MIN_RECENT * factor && st.base >= MIN_SEEN * factor && st.lift >= 1.3 && st.z >= 2 && st.slope > -0.08) {
      const who = customers(orgs, rA, last);
      out.trending = {
        score: st.z * (1 + clamp(st.accel, -0.5, 1)) * (who.top > MOSTLY_ONE ? 0.5 : 1),
        ...who,
      };
    }
    // Not at the first weeks either: a line starts where the channels began to be read.
    const peakOver = st.peak.week <= last - PEAK_AGO && st.peak.week >= first + 2
      && st.peak.share >= 1.8 * st.usual && st.now <= 0.6 * st.peak.share && st.peak.count >= MIN_PEAK * factor;
    if (peakOver && !out.trending) {
      const who = customers(orgs, st.peak.week - 2, st.peak.week + 2);
      const height = (st.peak.share - Math.max(st.now, st.usual)) / st.peak.share;
      out.peaked = { score: height * Math.sqrt(st.peak.count) * (who.top > MOSTLY_ONE ? 0.5 : 1), ...who };
    }
    if (!out.peaked && st.base >= MIN_BASE * factor && st.lift <= 0.75 && st.z <= -2) {
      const who = customers(orgs, rA - BASE, rA - 1);
      out.declining = { score: -st.z * (1 + clamp(-st.accel, -0.5, 1)) * (who.top > MOSTLY_ONE ? 0.5 : 1), ...who };
    }
    return out;
  }

  /** The newest full week: this one once most of it is over, else the one before. */
  function lastFull(data, now = Date.now()) {
    const n = data.weeks.length;
    const into = (now - Date.parse(`${data.weeks[n - 1]}T00:00:00Z`)) / (7 * 864e5);
    return { last: into >= 0.85 ? n - 1 : n - 2, partial: Math.min(1, Math.max(0, into)) };
  }

  /**
   * The first week that counts: with a fifth of a usual week's, at least. Before it are a few
   * threads of months before the channels were read.
   */
  const firstOf = (totals) => {
    const usual = median(totals.filter((x) => x > 0));
    return Math.max(0, totals.findIndex((x) => x > 0 && x >= usual / 5));
  };

  /**
   * What is moving among the series `keysOf` makes of each thread `keep` keeps: `{ trending,
   * declining, peaked }`, the strongest first, and `items`, every series by its key, each
   * `{ key, list, score, stats, orgs, top, spark, counts }` (`list` the one it is in, or null).
   */
  function moving(data, { keep = () => true, keysOf, unit = 'channels', now = Date.now() }) {
    const { last } = lastFull(data, now);
    const totals = weekly(data, keep, unit).counts;
    const first = firstOf(totals);
    const n = data.weeks.length;
    const series = new Map();
    const seen = new Set();
    for (const t of data.threads) {
      if (!keep(t)) continue;
      const keys = keysOf(t);
      if (!keys.length) continue;
      for (const [w, c] of parts(t, unit)) {
        for (const k of keys) {
          if (unit === 'channels') {
            const u = `${k}|${t[I.channel]}|${w}`;
            if (seen.has(u)) continue;
            seen.add(u);
          }
          let s = series.get(k);
          if (!s) {
            s = { counts: new Array(n).fill(0), orgs: Array.from({ length: n }, () => new Map()) };
            series.set(k, s);
          }
          s.counts[w] += c;
          s.orgs[w].set(t[I.org], (s.orgs[w].get(t[I.org]) || 0) + c);
        }
      }
    }
    const factor = unit === 'messages' ? MESSAGE_FACTOR : 1;
    const out = { trending: [], declining: [], peaked: [] };
    const items = new Map();
    for (const [key, s] of series) {
      const st = stats(s.counts, totals, { last, first });
      const c = classify(st, s.orgs, { last, first, factor });
      const spark = s.counts.slice(first, last + 1).map((x, i) => (totals[first + i] ? x / totals[first + i] : 0));
      const list = Object.keys(out).find((l) => c[l]) || null;
      const item = {
        key, list, ...(list ? c[list] : customers(s.orgs, last - RECENT + 1, last)), score: list ? c[list].score : 0,
        stats: st, spark, first, counts: s.counts,
      };
      items.set(key, item);
      if (list) out[list].push(item);
    }
    for (const l of Object.values(out)) l.sort((a, b) => b.score - a.score);
    return {
      ...out, items, totals, last, first,
    };
  }

  globalThis.Trends = {
    I, RECENT, BASE, PEAK_AGO, UNITS, MOSTLY_ONE,
    parts, weekly, smooth, stats, classify, moving, lastFull, firstOf, customers,
  };
})();
