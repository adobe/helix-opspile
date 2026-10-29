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
 * `npm run rank -- behavior`: what the teams do, not what anyone says they should. For every
 * thread of the sample, from the production API (read-only): who on its team has read it, and
 * how (opened in opspile, posted, reacted: `watermarks`), and each time a customer wrote,
 * whether and how soon Adobe answered. Then, by what a thread or a message is like, how likely
 * it is to be opened and to be answered within a day, and whether the model's score, Clef's
 * ratings and the old score point at the threads that are.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadClassic, loadRank } from './rank-lib.mjs';

const H = 3600000;
const ALARM = /\b(urgent|asap|down|outage|broken|blocked|blocker|critical|escalat\w*|not working|fails?|failing|error|5\d\d)\b/i;
const THANKS = /\b(thanks|thank you|thx|ty|cheers|merci|danke|appreciate)\b/i;

/** 1 answered within a day, 0 not, null when a day has not gone by yet. */
function answeredInADay(reply, at, now) {
  if (reply && Date.parse(reply.at) - at <= 24 * H) {
    return 1;
  }
  return now - at > 24 * H ? 0 : null;
}

/** How a thread stands: resolved with ✅ by staff, by Clef, or open. */
function resolvedOf(e) {
  if (e.resolution?.verdict === 'resolved') {
    return '✅ by staff';
  }
  return (e.label?.resolved_p ?? 0) >= 0.5 ? 'Clef: resolved' : 'open';
}

/** The times a customer wrote (a run of customer messages ends with the last), and the answers. */
export function customerTurns(messages, now) {
  const live = messages.filter((m) => !m.deletedAt && m.author)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const person = (m) => m.author.kind === 'person' || !m.author.kind;
  const turns = [];
  let run = [];
  const close = (i) => {
    if (!run.length) {
      return;
    }
    const last = run[run.length - 1];
    const reply = live.slice(i).find((m) => person(m) && m.author.staff);
    const at = Date.parse(last.at);
    const text = run.map((m) => m.body || '').join('\n');
    turns.push({
      at,
      first: turns.length === 0 && live.indexOf(run[0]) === 0,
      messages: run.length,
      text,
      replyH: reply ? (Date.parse(reply.at) - at) / H : null,
      // Answered within a day, where a day has gone by.
      day: answeredInADay(reply, at, now),
    });
    run = [];
  };
  live.forEach((m, i) => {
    if (!person(m)) {
      return;
    }
    if (!m.author.staff) {
      run.push(m);
    } else {
      close(i);
    }
  });
  close(live.length);
  return turns;
}

const rate = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** Area under the ROC curve: how often a positive scores above a negative. */
export function auc(scores, labels) {
  const pos = [];
  const neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) {
    return NaN;
  }
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) {
        wins += 1;
      } else if (p === n) {
        wins += 0.5;
      }
    }
  }
  return wins / (pos.length * neg.length);
}

/** Logistic regression with an intercept (w[0]), L2 on the rest, by gradient descent. */
export function logistic(X, y, { l2 = 1, iterations = 3000, step = 0.5 } = {}) {
  const d = X[0].length + 1;
  const w = new Array(d).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    const g = w.map((v, k) => (k ? l2 * v : 0));
    X.forEach((x, i) => {
      const z = w[0] + x.reduce((s, v, k) => s + v * w[k + 1], 0);
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      g[0] += e;
      x.forEach((v, k) => {
        g[k + 1] += e * v;
      });
    });
    for (let k = 0; k < d; k += 1) {
      w[k] -= (step * g[k]) / X.length;
    }
  }
  return w;
}

function table(title, rows, cols) {
  const head = `\n### ${title}\n\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`;
  return head + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const hrs = (x) => (Number.isFinite(x) ? `${x < 10 ? x.toFixed(1) : Math.round(x)} h` : '–');

function segments(items, by, outcomes) {
  const groups = new Map();
  for (const it of items) {
    const k = by(it);
    if (k !== null && k !== undefined) {
      if (!groups.has(k)) {
        groups.set(k, []);
      }
      groups.get(k).push(it);
    }
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length)
    .map(([k, list]) => [k, list.length, ...outcomes.map((o) => o(list))]);
}

export async function behavior(opts, {
  threadsFile, outFile, ratingsFile, get,
}) {
  const data = JSON.parse(await readFile(threadsFile, 'utf8'));
  const now = data.pulledAt;
  const cache = `${outFile}.json`;
  let reads = existsSync(cache) ? JSON.parse(await readFile(cache, 'utf8')) : null;
  if (!reads || reads.snap !== now || opts.refresh) {
    reads = { snap: now, threads: {} };
    const list = data.threads;
    for (let i = 0; i < list.length; i += 8) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(list.slice(i, i + 8).map(async (t) => {
        const r = await get(`/api/thread?thread=${encodeURIComponent(t.key)}`
          + `${t.team ? `&team=${encodeURIComponent(t.team)}` : ''}`);
        reads.threads[t.key] = (r.watermarks || []).map((w) => ({
          person: w.person, read_at: w.read_at, via: w.via,
        }));
      }));
      process.stdout.write(`\r${Math.min(i + 8, list.length)}/${list.length} threads' readers`);
    }
    process.stdout.write('\n');
    await writeFile(cache, JSON.stringify(reads), { mode: 0o600 });
  }
  const Rank = loadRank();
  const classic = loadClassic(now);
  const ratings = existsSync(ratingsFile) ? JSON.parse(await readFile(ratingsFile, 'utf8')) : {};
  const URG = ['low', 'normal', 'high', 'critical'];
  const urgencyOf = (e) => (e.label?.urgency == null ? '(none)' : URG[Math.min(3, Math.round(e.label.urgency))]);

  // Threads: opened in opspile by someone on the team; read by how many of it.
  const threads = data.threads.filter((t) => t.entry.kind !== 'alert').map((t) => {
    const e = t.entry;
    const ws = reads.threads[t.key] || [];
    const last = e.last_at || e.any_at;
    return {
      t,
      e,
      opened: ws.some((w) => w.via === 'open') ? 1 : 0,
      readers: new Set(ws.map((w) => w.person)).size,
      caughtUp: ws.filter((w) => last && w.read_at >= last).length,
      model: Rank.score(e, now) ?? 0,
      classic: classic(e),
      clef: ratings[t.key]?.bt ?? null,
      ageD: (now - Date.parse(last)) / (24 * H),
    };
  });
  // Customer turns: answered within a day, and how soon.
  const turns = data.threads.filter((t) => t.entry.kind !== 'alert').flatMap((t) => customerTurns(t.messages, now)
    .map((x) => ({ ...x, e: t.entry })));
  const decided = turns.filter((x) => x.day !== null);

  const out = [`# What the teams do (snapshot ${new Date(now).toISOString()})`,
    `\n${threads.length} conversations; ${turns.length} times a customer wrote, ${decided.length} of them more than a day ago.`];
  const T = [
    (l) => pct(rate(l.map((x) => x.opened))),
    (l) => (rate(l.map((x) => x.readers))).toFixed(1),
  ];
  const tcols = ['', 'threads', 'opened in opspile', 'team readers (mean)'];
  const R = [
    (l) => pct(rate(l.filter((x) => x.day !== null).map((x) => x.day))),
    (l) => hrs(median(l.filter((x) => x.replyH !== null).map((x) => x.replyH))),
    (l) => pct(rate(l.map((x) => (x.replyH === null ? 0 : 1)))),
  ];
  const rcols = ['', 'customer turns', 'answered within a day', 'median time to answer', 'answered at all'];
  const bucket = (x, cuts, names) => names[cuts.findIndex((c) => x < c)] ?? names[names.length - 1];

  out.push('\n## Which threads get looked at');
  out.push(table('By kind', segments(threads, (x) => x.e.label?.label_kind || '(none)', T), tcols));
  out.push(table('By urgency', segments(threads, (x) => urgencyOf(x.e), T), tcols));
  out.push(table('By who has the next move', segments(threads, (x) => x.e.waiting_on || 'nobody', T), tcols));
  out.push(table('By resolved', segments(threads, (x) => resolvedOf(x.e), T), tcols));
  out.push(table('By org type', segments(threads, (x) => x.e.org_type || '(none)', T), tcols));
  out.push(table('By platform', segments(threads, (x) => x.e.source, T), tcols));
  out.push(table('By size', segments(threads, (x) => bucket(x.e.messages || 0, [3, 10, 30], ['1–2', '3–9', '10–29', '30+']), T), tcols));
  out.push(table('By last activity', segments(threads, (x) => bucket(x.ageD, [1, 7, 30], ['< 1 day', '1–7 days', '7–30 days', '30+ days']), T), tcols));
  out.push(table('By team', segments(threads, (x) => x.e.team, T), tcols));

  out.push('\n## Which customer messages get answered');
  out.push(table('By kind of thread', segments(turns, (x) => x.e.label?.label_kind || '(none)', R), rcols));
  out.push(table('By urgency', segments(turns, (x) => urgencyOf(x.e), R), rcols));
  out.push(table('First message or follow-up', segments(turns, (x) => (x.first ? 'opens the thread' : 'follow-up'), R), rcols));
  out.push(table('Asks a question', segments(turns, (x) => (/\?/.test(x.text) ? 'has ?' : 'no ?'), R), rcols));
  out.push(table('Alarm words', segments(turns, (x) => (ALARM.test(x.text) ? 'yes' : 'no'), R), rcols));
  out.push(table('Says thanks', segments(turns, (x) => (THANKS.test(x.text) ? 'yes' : 'no'), R), rcols));
  out.push(table('Length', segments(turns, (x) => bucket(x.text.length, [80, 300, 1000], ['< 80 chars', '80–300', '300–1000', '1000+']), R), rcols));
  out.push(table('Messages in the turn', segments(turns, (x) => bucket(x.messages, [2, 4], ['1', '2–3', '4+']), R), rcols));
  out.push(table('Weekday (UTC)', segments(turns, (x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(x.at).getUTCDay()], R), rcols));
  out.push(table('Hour (UTC)', segments(turns, (x) => bucket(new Date(x.at).getUTCHours(), [6, 12, 18], ['00–06', '06–12', '12–18', '18–24']), R), rcols));
  out.push(table('By org type', segments(turns, (x) => x.e.org_type || '(none)', R), rcols));
  out.push(table('By platform', segments(turns, (x) => x.e.source, R), rcols));
  out.push(table('By team', segments(turns, (x) => x.e.team, R), rcols));

  // What raises the odds of an answer within a day, all at once (logistic regression).
  const F = {
    question: (x) => (/\?/.test(x.text) ? 1 : 0),
    alarm: (x) => (ALARM.test(x.text) ? 1 : 0),
    thanks: (x) => (THANKS.test(x.text) ? 1 : 0),
    long: (x) => (x.text.length >= 300 ? 1 : 0),
    opensThread: (x) => (x.first ? 1 : 0),
    weekend: (x) => ([0, 6].includes(new Date(x.at).getUTCDay()) ? 1 : 0),
    urgent: (x) => ((x.e.label?.urgency ?? 0) >= 1.5 ? 1 : 0),
    incident: (x) => (x.e.label?.label_kind === 'incident' ? 1 : 0),
    access: (x) => (x.e.label?.label_kind === 'access' ? 1 : 0),
    other: (x) => (x.e.label?.label_kind === 'other' ? 1 : 0),
    partner: (x) => (x.e.org_type === 'partner' ? 1 : 0),
    teams: (x) => (x.e.source === 'teams' ? 1 : 0),
  };
  const names = Object.keys(F);
  if (decided.length >= 30) {
    const w = logistic(decided.map((x) => names.map((n) => F[n](x))), decided.map((x) => x.day));
    out.push(table(
      'Odds of an answer within a day, everything else equal (logistic regression)',
      names.map((n, k) => [n, `× ${Math.exp(w[k + 1]).toFixed(2)}`, decided.filter((x) => F[n](x)).length])
        .sort((a, b) => Number(b[1].slice(2)) - Number(a[1].slice(2))),
      ['', 'odds', 'turns with it'],
    ));
  }

  // Do the scores point where the teams go? Older threads have had longer to be opened, so
  // each score is compared within threads of about the same age, then averaged.
  const ages = [1, 3, 7, 14, Infinity];
  const stratified = (score, list) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < ages.length; i += 1) {
      const band = list.filter((x) => x.ageD < ages[i] && (i === 0 || x.ageD >= ages[i - 1]));
      const a = auc(band.map(score), band.map((x) => x.opened));
      if (Number.isFinite(a)) {
        sum += a * band.length;
        n += band.length;
      }
    }
    return n ? sum / n : NaN;
  };
  const withClef = threads.filter((x) => x.clef !== null);
  out.push(table('How well each score picks the threads that were opened, among threads of about the same age (AUC; 50% is chance)', [
    ['model', pct(stratified((x) => x.model, threads))],
    ['Clef\'s ratings', pct(stratified((x) => x.clef, withClef))],
    ['old score', pct(stratified((x) => x.classic, threads))],
    ['size (messages)', pct(stratified((x) => x.e.messages || 0, threads))],
    ['urgency', pct(stratified((x) => x.e.label?.urgency ?? 0, threads))],
  ], ['score', 'AUC']));
  const report = out.join('\n');
  await writeFile(outFile, `${report}\n`, { mode: 0o600 });
  return report;
}
