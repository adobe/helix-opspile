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
 * `npm run rank -- judge`: two threads of the sample side by side, as Clef was shown them, and
 * you say which the team should turn to first. Your answers go to `.rank/human.jsonl`; after
 * each, the page shows what Clef, the model and the hand-made score said, and how often each
 * agrees with you so far. Local, read-only on production: it serves `.rank/`.
 */

import { createServer } from 'node:http';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SLACK_EMOJI } from '../src/emoji.js';
import MARKDOWN from '../src/ui-markdown.bundle.js';
import { platformName } from '../src/platforms.js';
import {
  loadClassic, loadRank, random, summary,
} from './rank-lib.mjs';

const PAGE = new URL('./rank-judge.html', import.meta.url);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Your answers, of this sample. */
export async function readHuman(file, snap) {
  if (!existsSync(file)) {
    return [];
  }
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((h) => h.snap === snap);
}

/**
 * How often Clef, the model and the hand-made score pick what you picked, of the pairs you
 * decided (ties and skips aside); Clef's also by how sure it was, and when asking it the
 * other way round changed its mind.
 */
function confidenceBucket(conf) {
  if (conf >= 0.9) {
    return '90%+';
  }
  return conf >= 0.7 ? '70–90%' : '50–70%';
}

/** Who wrote a message, as the page tags it. */
function role(author) {
  if (author?.kind && author.kind !== 'person') {
    return 'bot';
  }
  return author?.staff ? 'staff' : 'customer';
}

export function agreementWithYou(human, games, score) {
  const byPair = new Map(games.map((g) => [`${g.a}|${g.b}`, g]));
  const out = {
    judged: human.length,
    decided: 0,
    ties: 0,
    skipped: 0,
    clef: { n: 0, agree: 0 },
    model: { n: 0, agree: 0 },
    classic: { n: 0, agree: 0 },
    byConfidence: {
      '90%+': { n: 0, agree: 0 }, '70–90%': { n: 0, agree: 0 }, '50–70%': { n: 0, agree: 0 },
    },
    clefFlipped: { n: 0, agree: 0 },
    tieClefConfidence: 0,
  };
  let tieConf = 0;
  for (const h of human) {
    const g = byPair.get(`${h.a}|${h.b}`);
    if (h.pick === 'skip') {
      out.skipped += 1;
    } else if (h.pick === 'tie') {
      out.ties += 1;
      tieConf += g ? Math.max(g.p, 1 - g.p) : 0;
    } else if (g) {
      out.decided += 1;
      const you = h.p > 0.5;
      const count = (bucket, verdict) => Object.assign(bucket, {
        n: bucket.n + 1, agree: bucket.agree + (verdict === you ? 1 : 0),
      });
      count(out.clef, g.p > 0.5);
      const conf = Math.max(g.p, 1 - g.p);
      count(out.byConfidence[confidenceBucket(conf)], g.p > 0.5);
      if ((g.ab > 0.5) !== (g.ba < 0.5)) {
        count(out.clefFlipped, g.p > 0.5);
      }
      const m = score.model(h.a) - score.model(h.b);
      if (m) {
        count(out.model, m > 0);
      }
      const c = score.classic(h.a) - score.classic(h.b);
      if (c) {
        count(out.classic, c > 0);
      }
    }
  }
  out.tieClefConfidence = out.ties ? tieConf / out.ties : 0;
  return out;
}

/** A thread as the page shows it. */
function view(rec, now, staffByName) {
  const t = rec.entry;
  const emoji = (name) => SLACK_EMOJI[String(name).replace(/::skin-tone-\d/, '')] || `:${name}:`;
  return {
    key: rec.key,
    title: t.title || '(no title)',
    customer: t.org_name || t.org,
    orgType: t.org_type || null,
    channel: t.channel_name,
    platform: platformName(t.source),
    kind: t.kind,
    summary: summary(t, now),
    permalink: t.permalink || null,
    messages: (rec.messages || []).filter((m) => !m.deletedAt).map((m) => ({
      at: m.at,
      who: m.author?.name || m.author?.kind || 'someone',
      as: role(m.author),
      org: m.author?.org || null,
      body: m.body || '',
      reactions: (m.reactions || []).map((r) => ({
        emoji: emoji(r.emoji),
        names: r.names,
        staff: r.names.filter((n) => staffByName.get(n)).length,
      })),
    })),
  };
}

const MODES = {
  random: () => true,
  close: (g) => Math.abs(g.p - 0.5) < 0.2,
  'model-vs-clef': (g, s) => (s.model(g.a) > s.model(g.b)) !== (g.p > 0.5),
  'model-vs-classic': (g, s) => (s.model(g.a) > s.model(g.b)) !== (s.classic(g.a) > s.classic(g.b)),
};

export async function judge({
  port, threadsFile, humanFile, readGames,
}) {
  const data = JSON.parse(await readFile(threadsFile, 'utf8'));
  const snap = data.pulledAt;
  const byKey = new Map(data.threads.map((t) => [t.key, t]));
  const staffByName = new Map(Object.entries(data.staff || {}));
  const games = (await readGames()).filter((g) => byKey.has(g.a) && byKey.has(g.b));
  if (!games.length) {
    throw new Error('no games of Clef\'s to compare with: run `npm run rank -- duel` first');
  }
  // Scores are read again from ui/rank.js when it changes (a train run while judging).
  let rank = null;
  let rankSource = null;
  const scores = async () => {
    const src = await readFile(new URL('../ui/rank.js', import.meta.url), 'utf8');
    if (src !== rankSource) {
      rankSource = src;
      const Rank = loadRank(src);
      const classic = loadClassic(snap);
      const memo = (f) => {
        const m = new Map();
        return (k) => {
          if (!m.has(k)) {
            m.set(k, f(byKey.get(k).entry));
          }
          return m.get(k);
        };
      };
      rank = {
        model: memo((e) => Rank.score(e, snap) ?? 0),
        classic: memo((e) => classic(e)),
      };
    }
    return rank;
  };
  const rnd = random(Date.now() % 100000);
  const page = await readFile(PAGE, 'utf8');
  const emoji = JSON.stringify(SLACK_EMOJI);
  const stats = async () => agreementWithYou(
    await readHuman(humanFile, snap),
    games,
    await scores(),
  );

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const body = (req) => new Promise((ok) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
    });
    req.on('end', () => ok(s ? JSON.parse(s) : {}));
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        return send(res, 200, page, 'text/html; charset=utf-8');
      }
      if (url.pathname === '/markdown.js') {
        return send(res, 200, MARKDOWN, 'text/javascript; charset=utf-8');
      }
      if (url.pathname === '/emoji.json') {
        return send(res, 200, emoji, 'application/json');
      }
      if (url.pathname === '/api/pair') {
        const s = await scores();
        const done = new Set((await readHuman(humanFile, snap)).map((h) => `${h.a}|${h.b}`));
        const mode = MODES[url.searchParams.get('mode')] || MODES.random;
        const open = games.filter((g) => !done.has(`${g.a}|${g.b}`) && mode(g, s));
        if (!open.length) {
          return send(res, 200, { done: true, stats: await stats() });
        }
        const g = open[Math.floor(rnd() * open.length)];
        // Which side each is on is chance, not the order Clef was asked in.
        const swap = rnd() < 0.5;
        const [l, r] = swap ? [g.b, g.a] : [g.a, g.b];
        return send(res, 200, {
          a: g.a,
          b: g.b,
          left: view(byKey.get(l), snap, staffByName),
          right: view(byKey.get(r), snap, staffByName),
          now: snap,
          open: open.length,
        });
      }
      if (url.pathname === '/api/judge' && req.method === 'POST') {
        const j = await body(req);
        const g = games.find((x) => x.a === j.a && x.b === j.b);
        if (!g || !['left', 'right', 'tie', 'skip'].includes(j.pick)) {
          return send(res, 400, { error: 'no such pair or pick' });
        }
        const leftIsA = j.left === j.a;
        let p = 0.5;
        if (j.pick === 'left' || j.pick === 'right') {
          p = (j.pick === 'left') === leftIsA ? 1 : 0;
        }
        const answer = {
          snap, a: g.a, b: g.b, pick: j.pick, p, left: j.left, ms: j.ms ?? null,
        };
        answer.at = new Date().toISOString();
        await appendFile(humanFile, `${JSON.stringify(answer)}\n`, { mode: 0o600 });
        const s = await scores();
        // Everything as "left comes first".
        const left = (pa) => (leftIsA ? pa : 1 - pa);
        return send(res, 200, {
          clef: left(g.p),
          clefAsked: leftIsA ? [g.ab, 1 - g.ba] : [g.ba, 1 - g.ab],
          model: left(sigmoid(s.model(g.a) - s.model(g.b))),
          classic: left(0.5 + Math.sign(s.classic(g.a) - s.classic(g.b)) / 2),
          stats: await stats(),
        });
      }
      if (url.pathname === '/api/undo' && req.method === 'POST') {
        if (existsSync(humanFile)) {
          const lines = (await readFile(humanFile, 'utf8')).split('\n').filter(Boolean);
          const i = lines.map((l) => JSON.parse(l).snap).lastIndexOf(snap);
          if (i >= 0) {
            const [undone] = lines.splice(i, 1);
            await writeFile(humanFile, lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
            return send(res, 200, { undone: JSON.parse(undone), stats: await stats() });
          }
        }
        return send(res, 200, { undone: null, stats: await stats() });
      }
      if (url.pathname === '/api/stats') {
        return send(res, 200, await stats());
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
  await new Promise((ok) => {
    server.listen(port, '127.0.0.1', ok);
  });
  console.log(`${games.length} of Clef's games on ${byKey.size} threads; judge them at`
    + ` http://localhost:${port}/ (Ctrl-C to stop)`);
  return server;
}
