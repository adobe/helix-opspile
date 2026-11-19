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
 * The ground truth of the product labels: channel threads marked by hand with the
 * technologies they involve, and how the labeling pipelines score against them. Reads
 * production, read-only (`cf d1 query`); everything it writes is in `.truth/`, which is never
 * committed (thread titles, customers, marks):
 *
 *   npm run truth -- sample --database <D1 id> [--profile <cf profile>] [--n 150] [--seed s]
 *     [--before <ISO time>] [--from .truth/sample.json]
 *   npm run truth -- score --database <D1 id> [--profile <cf profile>] [--json]
 *   npm run truth -- review --database <D1 id> --origin <inbox origin> [--out file.html]
 *
 * `sample` draws the threads (.truth/sample.json), `score` scores Clef with the rules
 * (`labels.tech`, `thread_tech`) and Clairic (`product` facts through src/products.js
 * `coveredBy`) against .truth/marks.json, and `review` writes a page to check and correct the
 * marks (.truth/review.html).
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GLOBAL_TEAM } from '../src/extract.js';
import { TECH_MIN } from '../src/label.js';
import { coveredBy, techIndex } from '../src/products.js';
import {
  NO_LAYER, drawSample, hubShare, labelSets, longTail, mapId, markSets, movesMap, pct,
  sameProduct, scoreRelation,
} from './truth-lib.mjs';
import { reviewPage } from './truth-review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.truth');

/** Entries the vocabulary has besides tech_stack's (docs: the plan's G3). */
const EXTRA = [{
  tech: 'adobe/aem-sites/managed-cdn',
  name: 'Adobe Managed CDN',
  layer: 'edge',
  description: 'the Adobe Managed CDN, in front of Edge Delivery or AEM as a Cloud Service',
}];

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    database: { type: 'string' },
    profile: { type: 'string' },
    n: { type: 'string', default: '150' },
    seed: { type: 'string', default: 'truth-1' },
    before: { type: 'string' },
    from: { type: 'string' },
    origin: { type: 'string', default: process.env.PUBLIC_ORIGIN || '' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
  },
});

const command = positionals[0];
const usage = 'usage: npm run truth -- sample|score|review --database <D1 id> [--profile <cf profile>]';
if (!['sample', 'score', 'review'].includes(command) || (!args.database && !args.offline)) {
  console.error(usage);
  process.exit(1);
}

const sq = (s) => `'${String(s).replaceAll("'", "''")}'`;

function query(sql) {
  const profile = args.profile ? ['--profile', args.profile] : [];
  const out = execFileSync('cf', ['d1', 'query', args.database, '-q', ...profile, '--sql', sql], {
    encoding: 'utf8', maxBuffer: 2 ** 30, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out)[0].results;
}

const read = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
function write(name, value) {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, name);
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** The tech stack's rows, and the vocabulary marked: each id once, the admin team's first. */
function catalog() {
  const rows = query('SELECT team, tech, name, description, layer, aliases, enabled FROM tech_stack');
  const byId = new Map();
  for (const r of [...rows].sort((a, b) => (b.team === GLOBAL_TEAM) - (a.team === GLOBAL_TEAM))) {
    if (r.enabled && !byId.has(r.tech)) {
      byId.set(r.tech, {
        tech: r.tech, name: r.name, layer: r.layer || 'other', description: r.description,
      });
    }
  }
  for (const e of EXTRA) {
    if (!byId.has(e.tech)) {
      byId.set(e.tech, e);
    }
  }
  return { rows, vocabulary: [...byId.values()].sort((a, b) => a.tech.localeCompare(b.tech)) };
}

/** A technology's layer in a team's channels: its own entry's, else the admin team's. */
function layerOf(rows) {
  const by = new Map(rows.filter((r) => r.layer).map((r) => [`${r.team}\u0000${r.tech}`, r.layer]));
  return (team, tech) => by.get(`${team}\u0000${tech}`) || by.get(`${GLOBAL_TEAM}\u0000${tech}`)
    || 'other';
}

const POPULATION = `SELECT t.thread, t.team, t.org, t.source, t.messages, t.root_at,
    COALESCE(l.title, t.title) AS title, l.tech, l.kind
  FROM threads t LEFT JOIN labels l ON l.thread = t.thread
  WHERE t.kind = 'channel' AND t.messages >= 3 AND t.team != '_unassigned'
    AND t.logical_thread IS NULL AND COALESCE(l.kind, '') NOT IN ('meeting', 'people')`;

/** The population: its threads that started before `before` (an ISO time), so a draw repeats. */
const population = (before) => query(`${POPULATION} AND t.root_at < ${sq(before)}`);

/** Threads per team and layer (the sampled layer). */
function printCounts(threads) {
  const layers = [...new Set(threads.map((t) => t.stratum))]
    .sort((a, b) => (a === NO_LAYER) - (b === NO_LAYER)
    || a.localeCompare(b));
  const teams = [...new Set(threads.map((t) => t.team))].sort();
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`${pad('team', 22)}${layers.map((l) => pad(l, 9)).join('')}total`);
  for (const team of teams) {
    const of = threads.filter((t) => t.team === team);
    console.log(`${pad(team, 22)}${layers.map((l) => pad(of.filter((t) => t.stratum === l).length || '', 9)).join('')}${of.length}`);
  }
}

function sample() {
  const { rows, vocabulary } = catalog();
  const layer = layerOf(rows);
  // Drawn again from the population an earlier draw kept (`--from`): the same threads,
  // whatever changed in production since.
  const earlier = args.from && JSON.parse(readFileSync(args.from, 'utf8'));
  const before = earlier?.before || args.before || new Date().toISOString();
  const threads = earlier ? earlier.population : population(before).map((t) => {
    const seen = labelSets(t.tech, [], { min: TECH_MIN }).uses;
    return {
      ...t,
      tech: undefined,
      asked: t.tech !== null,
      seen: [...seen].sort(),
      layers: [...new Set([...seen].map((id) => layer(t.team, id)))].sort(),
    };
  });
  const n = Number(args.n);
  const { picked, plan } = drawSample(threads, { n, seed: args.seed });
  const file = write('sample.json', {
    seed: args.seed,
    drawn_at: new Date().toISOString(),
    before,
    vocabulary,
    plan,
    threads: picked.sort((a, b) => a.team.localeCompare(b.team)
      || a.thread.localeCompare(b.thread)),
    population: threads,
  });
  const orgs = {};
  for (const t of picked) {
    orgs[t.org] = (orgs[t.org] || 0) + 1;
  }
  console.log(`${picked.length} of ${threads.length} threads, ${Object.keys(orgs).length} customers `
    + `(at most ${Math.max(...Object.values(orgs))} from one), into ${file}`);
  printCounts(picked);
}

const inList = (ids) => ids.map(sq).join(', ');

/** What production says of the marked threads, per pipeline, ids as they are now. */
function predictions(threads) {
  const hasMoves = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tech_moves'").length > 0;
  const moves = hasMoves ? movesMap(query('SELECT team, old, tech FROM tech_moves'), GLOBAL_TEAM) : null;
  const { rows } = catalog();
  const index = techIndex(rows.filter((r) => r.enabled));
  const labels = new Map();
  const tt = new Map();
  const products = new Map();
  // A few dozen threads at a time: the statement stays short.
  for (let i = 0; i < threads.length; i += 40) {
    const ids = inList(threads.slice(i, i + 40));
    query(`SELECT thread, tech FROM labels WHERE thread IN (${ids})`)
      .forEach((r) => labels.set(r.thread, r.tech));
    query(`SELECT thread, tech, p FROM thread_tech WHERE thread IN (${ids})`)
      .forEach((r) => tt.set(r.thread, [...(tt.get(r.thread) || []), r]));
    query(`SELECT thread, value FROM facts WHERE source = 'clairic' AND field = 'product' AND thread IN (${ids})`)
      .forEach((r) => products.set(r.thread, [...(products.get(r.thread) || []), r.value]));
  }
  const clef = new Map();
  const clefAbout = new Map();
  const clairic = new Map();
  for (const thread of threads) {
    const sets = labelSets(labels.get(thread) ?? null, tt.get(thread) || [], {
      min: TECH_MIN, moves,
    });
    clef.set(thread, sets.uses);
    clefAbout.set(thread, sets.about || sets.uses);
    clairic.set(thread, new Set((products.get(thread) || [])
      .map((name) => coveredBy(name, index)).filter(Boolean).map((id) => mapId(id, moves))));
  }
  const union = new Map(threads.map((t) => [t, new Set([...clef.get(t), ...clairic.get(t)])]));
  return {
    moves,
    index,
    asked: new Set(threads.filter((t) => labels.get(t) !== undefined && labels.get(t) !== null)),
    products,
    pipelines: {
      clef: { uses: clef, about: clefAbout },
      clairic: { uses: clairic, about: clairic },
      union: { uses: union, about: union },
    },
  };
}

function score() {
  const { threads: marks } = read('marks.json');
  const { vocabulary } = read('sample.json');
  const threads = Object.keys(marks);
  const got = predictions(threads);
  const vocab = [...new Set(vocabulary.map((v) => mapId(v.tech, got.moves)))].sort();
  const truth = {
    uses: new Map(threads.map((t) => [t, markSets(marks[t], got.moves).uses])),
    about: new Map(threads.map((t) => [t, markSets(marks[t], got.moves).about])),
  };
  const subset = (map, keep) => new Map([...map].filter(([t]) => keep.has(t)));
  const report = {
    threads: threads.length, asked: got.asked.size, moves: got.moves?.size || 0, scores: {},
  };
  const line = (cells) => console.log(cells.map((c, i) => String(c).padEnd(i ? 11 : 28)).join(''));
  console.log(`${threads.length} threads marked, ${got.asked.size} with a tech label; `
    + `${got.moves ? `${got.moves.size} moved ids mapped` : 'no tech_moves'}\n`);
  line(['pipeline · relation', 'P', 'R', 'F1', 'macroP', 'macroR', 'tp', 'fp', 'fn']);
  for (const [name, pipe] of Object.entries(got.pipelines)) {
    for (const rel of ['uses', 'about']) {
      for (const [label, keep] of [['all', null], ['asked', got.asked]]) {
        const t = keep ? subset(truth[rel], keep) : truth[rel];
        const s = scoreRelation(t, pipe[rel], vocab);
        report.scores[`${name}.${rel}.${label}`] = s;
        const o = s.overall;
        line([`${name} · ${rel}${keep ? ' (asked)' : ''}`, pct(o.precision), pct(o.recall), pct(o.f1),
          pct(o.macroPrecision), pct(o.macroRecall), o.tp, o.fp, o.fn]);
      }
    }
  }
  for (const rel of ['uses', 'about']) {
    console.log(`\nPer entry, ${rel} (all threads): marked n, then P / R per pipeline`);
    line(['entry', 'n', 'clef P', 'clef R', 'clairic P', 'clairic R']);
    for (const id of vocab) {
      const c = report.scores[`clef.${rel}.all`].per[id];
      const k = report.scores[`clairic.${rel}.all`].per[id];
      if (c.truth || c.guess || k.guess) {
        line([id.slice(0, 27), c.truth, pct(c.precision), pct(c.recall),
          pct(k.precision), pct(k.recall)]);
      }
    }
  }
  console.log('\nHub share (share of the marked threads per entry, top 10)');
  const hubs = {
    'marked uses': hubShare(truth.uses, threads.length),
    'marked about': hubShare(truth.about, threads.length),
    clef: hubShare(got.pipelines.clef.uses, threads.length),
    clairic: hubShare(got.pipelines.clairic.uses, threads.length),
  };
  report.hubs = hubs;
  for (const [name, list] of Object.entries(hubs)) {
    console.log(`  ${name.padEnd(13)} ${list.slice(0, 10).map((h) => `${h.id} ${pct(h.share)}`).join(', ')}`);
  }
  const covered = longTail(marks, (_, name) => Boolean(coveredBy(name, got.index)));
  const tails = {
    catalog: covered,
    clef: longTail(marks, (t, name) => {
      const id = coveredBy(name, got.index);
      return Boolean(id) && got.pipelines.clef.uses.get(t).has(mapId(id, got.moves));
    }),
    clairic: longTail(marks, (t, name) => (got.products.get(t) || [])
      .some((p) => sameProduct(p, name))),
  };
  report.longTail = tails;
  console.log(`\nLong tail: ${covered.names} names marked missing; the catalog now covers ${covered.hit}; `
    + `Clef names ${tails.clef.hit} (${pct(tails.clef.recall)}), Clairic ${tails.clairic.hit} (${pct(tails.clairic.recall)})`);
  if (args.json) {
    console.log(`\n${write(`score-${new Date().toISOString().slice(0, 10)}.json`, report)}`);
  }
}

function review() {
  const sampled = read('sample.json');
  const marks = existsSync(join(DIR, 'marks.json')) ? read('marks.json').threads : {};
  const threads = sampled.threads.filter((t) => marks[t.thread] || !Object.keys(marks).length);
  let said = {};
  if (!args.offline) {
    const got = predictions(threads.map((t) => t.thread));
    said = Object.fromEntries(threads.map((t) => [t.thread, {
      clef: [...got.pipelines.clef.uses.get(t.thread)].sort(),
      clairic: [...got.pipelines.clairic.uses.get(t.thread)].sort(),
      asked: got.asked.has(t.thread),
    }]));
  }
  const html = reviewPage({
    origin: args.origin.replace(/\/$/, ''),
    seed: sampled.seed,
    vocabulary: sampled.vocabulary,
    threads: threads.map((t) => ({
      thread: t.thread,
      team: t.team,
      org: t.org,
      title: t.title,
      layer: t.stratum,
      mark: marks[t.thread] || { tech: {}, missing: [], own: [] },
      said: said[t.thread] || null,
    })),
  });
  const file = args.out || write('review.html', html);
  if (args.out) {
    writeFileSync(args.out, html);
  }
  console.log(`${threads.length} threads, ${file}`);
}

({ sample, score, review })[command]();
