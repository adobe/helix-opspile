#!/usr/bin/env node
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
 * What the facts two threads share would link (src/factweights.js, src/threadlinks.js
 * `sharedFacts`, `explainFacts`; src/orgpartners.js's `facts` signal), measured on a D1 database
 * through the `cf` CLI, reading only: counts and the shapes of values, never names or text.
 *
 *   STAFF_DOMAINS=<domains> node scripts/fact-links-measure.mjs <database id>
 *     [--profile <cf profile>] [--days <n>] [--vectors <CONTENT index>]
 *     [--clef <n> --bucket <pile 2's bucket>]
 *
 * It reads the facts as the link job does (`factIndex`), finds for every customer's thread the
 * other customers' threads that share specific facts (of FACTS_MIN or more), active within
 * FACTS_DAYS of each other (`--days`), takes out what a partner of both explains (the partners
 * each customer has, `partnersOf`, and those whose people posted in each thread,
 * `partnerDomains`), and with `--vectors` compares the two threads' vectors (RELATED_MIN); with
 * `--clef n`, n of those are asked as the job asks (`sameState`, their messages read from pile
 * 2). It then counts the partner pairs with a `facts` signal and the hints (`orgPartners`,
 * without Clef). Values are shown by their shape, never as they are, but the product's own
 * vocabulary (a doc page, a configuration file). Every statement that is not a SELECT is refused,
 * not sent: nothing is written anywhere.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  factIndex, FIELD_WEIGHTS, keyWeight, linkFact, SKIP_FIELDS, SPECIFIC, spreadOf,
} from '../src/factweights.js';
import {
  CANDIDATE, LIKELY, orgPartners, partnersOf,
} from '../src/orgpartners.js';
import { partnerDomains } from '../src/partners.js';
import { partnerOf } from '../src/profiles.js';
import {
  explainFacts, FACTS_DAYS, FACTS_K, FACTS_MIN, RELATED_MIN, RELATED_P, RELATED_SURE, SAME_QUESTION,
  sameState, sharedFacts,
} from '../src/threadlinks.js';
import { CLEF } from '../src/label.js';
import { threadVectorId } from '../src/vectors.js';

const [db, ...rest] = process.argv.slice(2);
if (!db) {
  console.error('usage: node scripts/fact-links-measure.mjs <database id> [--profile <profile>]');
  process.exit(2);
}
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const profile = opt('--profile') ? ['--profile', opt('--profile')] : [];
const vectorIndex = opt('--vectors');
const sample = Number(opt('--clef')) || 0;
const bucket = opt('--bucket');
const days = Number(opt('--days')) || FACTS_DAYS;
const run = promisify(execFile);
const DAY = 86400 * 1000;

function query(sql, params) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return { results: [], meta: { changes: 0 } };
  }
  const out = execFileSync('cf', [...profile, 'd1', 'query', db, '--body', JSON.stringify({ sql, params })], {
    encoding: 'utf8', maxBuffer: 1024 * 1024 * 512,
  });
  return { results: JSON.parse(out)[0].results || [], meta: { changes: 0 } };
}

/** D1, read-only, over the CLI. */
const DB = {
  prepare(sql) {
    const stmt = {
      args: [],
      bind(...a) {
        stmt.args = a;
        return stmt;
      },
      async all() {
        return query(sql, stmt.args);
      },
      async first() {
        return query(sql, stmt.args).results[0] || null;
      },
      async run() {
        return query(sql, stmt.args);
      },
      async raw() {
        return query(sql, stmt.args).results.map((r) => Object.values(r));
      },
    };
    return stmt;
  },
  async batch(list) {
    return Promise.all(list.map((s) => s.all()));
  },
};
const cfJson = async (args) => JSON.parse((await run('cf', [...profile, ...args], {
  encoding: 'utf8', maxBuffer: 1024 * 1024 * 64,
})).stdout);
const CHANNELS = {
  async put() {
    return null;
  },
  async list({ prefix }) {
    const objects = await cfJson(['r2', 'objects', 'list', '--bucket-name', bucket, '--prefix', prefix]);
    return { objects: objects.map((o) => ({ key: o.key, etag: o.etag })), truncated: false };
  },
  async get(key) {
    try {
      const { stdout } = await run('cf', [...profile, 'r2', 'objects', 'get', key, '--bucket-name', bucket], {
        encoding: 'utf8', maxBuffer: 1024 * 1024 * 64,
      });
      return { text: async () => stdout };
    } catch {
      return null;
    }
  },
};
const env = { DB, STAFF_DOMAINS: process.env.STAFF_DOMAINS || '', ...(bucket ? { CHANNELS } : {}) };
const all = async (sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const count = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const sorted = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));

/** Runs `fn` on each of `items`, `n` at a time. */
async function pool(items, n, fn) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const x = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      out.push(await fn(x));
    }
  }));
  return out;
}

/** A value as the report shows it: its shape, no name (`aemcs_env pN-eN`, a pull request). */
function shape(field, value) {
  const k = linkFact(field, value);
  if (!k) {
    return `${field} (denied)`;
  }
  const kf = k.key.slice(0, k.key.indexOf(':'));
  const v = k.key.slice(k.key.indexOf(':') + 1);
  if (kf === 'aemcs_env') {
    return 'aemcs_env pN-eN';
  }
  if (kf === 'site' || kf === 'repo') {
    return `${kf} <owner>/<repo>`;
  }
  if (kf === 'doc' || kf === 'tool') {
    return `${kf} <page>`;
  }
  const gh = v.match(/^github\.com\/([^/]+)\/[^/]+\/(pull|issues|commit|discussions)\//);
  if (gh) {
    return `github ${{
      pull: 'pull request', issues: 'issue', commit: 'commit', discussions: 'discussion',
    }[gh[2]]}${['adobe', 'adobe-rnd', 'adobe-commerce', 'hlxsites'].includes(gh[1]) ? ' (an Adobe repository)' : ''}`;
  }
  if (kf === 'url') {
    const [host, ...path] = v.split('/');
    const kind = /\.adobeaemcloud\.com$/.test(host) ? 'AEM Cloud Service host'
      : (/--.*\.(aem|hlx)\.(live|page)$/.test(host) && 'Edge Delivery site')
      || (/^admin\.(hlx\.page|aem\.live|da\.live)$/.test(host) && 'admin API') || 'other host';
    return `url, ${kind}, ${path.length} path segment${path.length === 1 ? '' : 's'}`;
  }
  return `${field} <value>`;
}

// ---- the index --------------------------------------------------------------------------------

const index = await factIndex(env);
const orgRows = await all('SELECT slug, type FROM orgs UNION SELECT slug, \'merged\' FROM org_merges');
const typeOf = new Map();
for (const r of orgRows) {
  typeOf.set(r.slug, typeOf.get(r.slug) === 'merged' ? 'merged' : r.type);
}
const type = (org) => typeOf.get(org) || 'customer';
const keysOfEntry = new Map();
for (const [key, k] of index.keys) {
  for (const e of k.entries) {
    if (!keysOfEntry.has(e)) {
      keysOfEntry.set(e, new Map());
    }
    keysOfEntry.get(e).set(key, k);
  }
}
const sharedKeys = [...index.keys].filter(([key]) => spreadOf(index, key).orgs.size >= 2);
const weighed = sharedKeys.map(([key, k]) => ({
  key, k, w: keyWeight(index, key, k.base), ...spreadOf(index, key),
}));
const ofType = (e, types) => types.includes(type((index.entries.get(e) || {}).org));
const cp = ['customer', 'partner'];
const entriesSharing = (list) => new Set(list.flatMap((x) => [...x.entries]
  .filter((e) => ofType(e, cp))));
const zero = new Map();
for (const x of weighed.filter((y) => y.w === 0)) {
  let why = 'common: in more orgs\' threads than COMMON_ORGS, or most threads';
  const field = x.key.slice(0, x.key.indexOf(':'));
  if ((FIELD_WEIGHTS[field] ?? 1) <= 0.1) {
    why = `near-zero field (${field})`;
  }
  count(zero, why);
}
const top = weighed.filter((x) => x.w > 0).sort((a, b) => b.w - a.w || b.df - a.df);
// A sample: of each band of weight, the values of the most threads.
const bandOf = (w) => {
  if (w >= 0.9) {
    return '0.9–1';
  }
  if (w >= SPECIFIC) {
    return `${SPECIFIC}–0.9`;
  }
  if (w >= 0.3) {
    return `0.3–${SPECIFIC}`;
  }
  return w > 0 ? '0–0.3' : '0';
};
const NEAR_ZERO = new Set(['doc', 'config_file', 'admin_api', 'tool', 'http_status']);
const sampled = {};
for (const band of ['0.9–1', `${SPECIFIC}–0.9`, `0.3–${SPECIFIC}`, '0–0.3', '0']) {
  sampled[band] = weighed.filter((x) => bandOf(x.w) === band).sort((a, b) => b.df - a.df)
    .slice(0, 5)
    .map((x) => ({
      // The product's own vocabulary is no customer's: a doc page, a configuration file, a tool.
      value: NEAR_ZERO.has(x.k.field) ? `${x.k.field} ${x.k.value}` : shape(x.k.field, x.k.value),
      w: x.w,
      threads: x.df,
      orgs: x.orgs.size,
    }));
}
// What the deny list takes out, of the values two orgs' channel threads share.
const rawShared = await all(`SELECT f.field, f.value, COUNT(DISTINCT t.org) AS orgs,
    COUNT(DISTINCT COALESCE(t.logical_thread, t.thread)) AS threads
  FROM facts f JOIN threads t ON t.thread = f.thread
  WHERE t.kind = 'channel' AND SUBSTR(t.org, 1, 1) != '_' GROUP BY f.field, f.value HAVING orgs >= 2`);
const denied = new Map();
for (const r of rawShared) {
  if (!SKIP_FIELDS.has(r.field) && !linkFact(r.field, r.value)) {
    count(denied, r.field);
  }
}
const specificShapes = new Map();
for (const x of top.filter((y) => y.w >= SPECIFIC)) {
  count(specificShapes, shape(x.k.field, x.k.value));
}

// ---- across customers -------------------------------------------------------------------------

const customers = [...new Set([...index.entries.values()].map((e) => e.org))].filter((o) => type(o) === 'customer');
const isCustomer = new Set(customers);
// The candidates every customer's entry would have, before the partners: pairs within FACTS_DAYS.
const raw = new Map();
for (const [e, keys] of keysOfEntry) {
  const info = index.entries.get(e);
  if (isCustomer.has(info.org)) {
    const own = new Map([...keys].map(([key, k]) => [key, {
      field: k.field, value: k.value, base: k.base,
    }]));
    const since = info.last ? new Date(Date.parse(info.last) - days * DAY).toISOString() : null;
    const found = sharedFacts(index, { entry: e, org: info.org, keys: own }, {
      allow: (o) => isCustomer.has(o), since,
    }).filter((m) => m.score >= FACTS_MIN);
    for (const m of found) {
      const other = index.entries.get(m.key);
      if (Math.abs(Date.parse(other.last) - Date.parse(info.last)) <= days * DAY) {
        const id = e < m.key ? `${e}\n${m.key}` : `${m.key}\n${e}`;
        if (!raw.has(id)) {
          raw.set(id, { a: e, b: m.key, match: m });
        }
      }
    }
  }
}
// The partners of each customer (confirmed or likely), and whose people posted in each thread.
const involved = [...new Set([...raw.values()].flatMap((x) => [x.a, x.b]))];
const orgsInvolved = [...new Set(involved.map((e) => index.entries.get(e).org))];
const partnersBy = new Map(await pool(orgsInvolved, 8, async (o) => [o,
  new Set((await partnersOf(env, o)).filter((p) => p.type === 'partner').map((p) => p.slug))]));
const domains = await partnerDomains(env);
const posting = new Map(involved.map((e) => [e, new Set()]));
for (let i = 0; i < involved.length; i += 200) {
  // eslint-disable-next-line no-await-in-loop
  const list = await all(`SELECT DISTINCT COALESCE(t.logical_thread, t.thread) AS entry,
      LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain
    FROM threads t JOIN messages m ON m.thread = t.thread
    JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
    WHERE (t.thread IN (SELECT value FROM json_each(?1)) OR t.logical_thread IN (SELECT value FROM json_each(?1)))
      AND m.staff = 0 AND m.deleted = 0 AND m.counted = 1 AND i.email LIKE '%_@_%'
      AND COALESCE(i.staff, 0) = 0`, JSON.stringify(involved.slice(i, i + 200)));
  for (const r of list) {
    const p = partnerOf(r.domain, domains);
    if (p && p.org && type(p.org) === 'partner' && posting.has(r.entry)) {
      posting.get(r.entry).add(p.org);
    }
  }
}
const side = (e) => new Set([...(partnersBy.get(index.entries.get(e).org) || []),
  ...posting.get(e)]);
const keyPartners = (key) => new Set([...spreadOf(index, key).orgs].filter((o) => type(o) === 'partner'));
const explainedWhy = new Map();
const kept = [];
let explained = 0;
for (const x of raw.values()) {
  const mine = side(x.a);
  const theirs = side(x.b);
  const m = explainFacts(x.match, { mine, theirs, keyPartners });
  if (m.score >= FACTS_MIN) {
    kept.push({ ...x, match: m });
  } else {
    explained += 1;
    const [first] = m.explained;
    const p = first.by[0];
    const how = [];
    const pa = partnersBy.get(index.entries.get(x.a).org) || new Set();
    const pb = partnersBy.get(index.entries.get(x.b).org) || new Set();
    if (pa.has(p) && pb.has(p)) {
      how.push('a partner of both');
    }
    if (posting.get(x.a).has(p) && posting.get(x.b).has(p)) {
      how.push('its people posted in both');
    }
    if (keyPartners(first.key).has(p)) {
      how.push('its own threads name it');
    }
    count(explainedWhy, how.join(', ') || 'a partner of one, its people in the other');
  }
}
// The K best a thread would keep, at most.
const perEntry = new Map();
for (const x of kept) {
  count(perEntry, x.a);
  count(perEntry, x.b);
}
const recentSince = new Date(Date.now() - FACTS_DAYS * DAY).toISOString();
const isRecent = (x) => index.entries.get(x.a).last >= recentSince
  && index.entries.get(x.b).last >= recentSince;

// ---- the vectors, and Clef ---------------------------------------------------------------------

let vectorStats = null;
let clefStats = null;
if (vectorIndex && kept.length) {
  const entries = [...new Set(kept.flatMap((x) => [x.a, x.b]))];
  const members = [];
  for (let i = 0; i < entries.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    members.push(...await all(`SELECT thread, COALESCE(logical_thread, thread) AS entry FROM threads
      WHERE embedded IS NOT NULL AND (thread IN (SELECT value FROM json_each(?1))
        OR logical_thread IN (SELECT value FROM json_each(?1)))`, JSON.stringify(entries.slice(i, i + 200))));
  }
  const ids = await Promise.all(members.map(async (r) => ({
    ...r, id: await threadVectorId(r.thread),
  })));
  const values = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += 20) {
    batches.push(ids.slice(i, i + 20));
  }
  await pool(batches, 4, async (b) => {
    const got = await cfJson(['vectorize', 'get-by-ids', vectorIndex, '--body', JSON.stringify({ ids: b.map((x) => x.id) })]);
    for (const v of got || []) {
      values.set(v.id, v.values);
    }
  });
  const vectorOf = new Map();
  for (const e of entries) {
    const vs = ids.filter((x) => x.entry === e).map((x) => values.get(x.id)).filter(Boolean);
    if (vs.length) {
      const sum = vs[0].map((_, i) => vs.reduce((n, v) => n + v[i], 0));
      vectorOf.set(e, sum);
    }
  }
  const cos = (a, b) => {
    let d = 0;
    let na = 0;
    let nb = 0;
    a.forEach((x, i) => {
      d += x * b[i];
      na += x * x;
      nb += b[i] * b[i];
    });
    return d / Math.sqrt(na * nb);
  };
  const scored = kept.map((x) => ({
    ...x,
    score: vectorOf.has(x.a) && vectorOf.has(x.b)
      ? cos(vectorOf.get(x.a), vectorOf.get(x.b)) : null,
  }));
  const passing = scored.filter((x) => x.score !== null && x.score >= RELATED_MIN);
  vectorStats = {
    withVectors: scored.filter((x) => x.score !== null).length,
    atLeastRelatedMin: passing.length,
    atLeastRelatedSure: passing.filter((x) => x.score >= RELATED_SURE).length,
    recentAtLeastRelatedMin: passing.filter(isRecent).length,
  };
  if (sample && bucket) {
    const step = Math.max(1, Math.floor(passing.length / sample));
    const picked = passing.filter((_, i) => i % step === 0).slice(0, sample);
    const answers = (await pool(picked, 4, async (x) => {
      const state = await sameState(env, x.a, x.b, { shared: x.match.shared, cross: true })
        .catch(() => null);
      if (!state) {
        return null;
      }
      const res = await cfJson(['ai', 'run', CLEF, '--body', JSON.stringify({
        model: 'clef', state, questions: { same: { type: 'noul', instructions: SAME_QUESTION } },
      })]).catch(() => null);
      const p = res && res.answers && res.answers.same && res.answers.same.noul;
      return typeof p === 'number' ? p : null;
    })).filter((p) => p !== null);
    clefStats = {
      asked: answers.length,
      same: answers.filter((p) => p >= RELATED_P).length,
      threshold: RELATED_P,
    };
  }
}

// ---- partners as a hint -----------------------------------------------------------------------

// Pairs of a partner and a customer whose threads name the same specific value, linked or not.
const hintPairs = new Set();
for (const x of weighed.filter((y) => y.w >= SPECIFIC)) {
  const orgs = [...x.orgs];
  for (const p of orgs.filter((o) => type(o) === 'partner')) {
    for (const c of orgs.filter((o) => type(o) === 'customer')) {
      hintPairs.add(`${c}\n${p}`);
    }
  }
}
const hintCustomers = [...new Set([...hintPairs].map((k) => k.split('\n')[0]))];
const partnersOfHint = new Map(await pool(hintCustomers, 8, async (o) => [o,
  new Set((await partnersOf(env, o)).map((p) => p.slug))]));
const hintLinked = [...hintPairs].filter((k) => {
  const [c, p] = k.split('\n');
  return partnersOfHint.get(c).has(p);
}).length;
const res = await orgPartners(env, { id: 0, email: 'measure', teams: [{ slug: 'admin' }] });
const { pairs } = await res.json();
const withFacts = pairs.filter((x) => (x.signals || []).some((g) => g.kind === 'facts'));
const factsWeight = (x) => x.signals.find((g) => g.kind === 'facts').weight;
const linked = (x) => Boolean(x.confirmed) || (!x.dismissed && x.p !== null && x.p >= LIKELY);

console.log(JSON.stringify({
  entries: index.n,
  entriesOfCustomersAndPartners: [...index.entries.values()]
    .filter((e) => cp.includes(type(e.org))).length,
  valuesSharedByTwoOrgsOrMore: sharedKeys.length,
  entriesSharingAValueWithAnotherOrg: entriesSharing(weighed).size,
  entriesSharingASpecificValue: entriesSharing(weighed.filter((x) => x.w >= SPECIFIC)).size,
  sharedValuesByWeight: Object.fromEntries(['0.9–1', `${SPECIFIC}–0.9`, `0.3–${SPECIFIC}`, '0–0.3', '0']
    .map((b) => [b, weighed.filter((x) => bandOf(x.w) === b).length])),
  sharedValuesOfNoWeight: sorted(zero),
  specificSharedValuesByShape: sorted(specificShapes),
  rawValuesSharedByTwoOrgsOrMore: rawShared.length,
  deniedByField: sorted(denied),
  sample: sampled,
  acrossCustomers: {
    window: days,
    candidatePairs: raw.size,
    orgPairs: new Set([...raw.values()].map((x) => [index.entries.get(x.a).org, index.entries.get(x.b).org].sort().join('\n'))).size,
    explainedByAPartner: explained,
    explainedHow: sorted(explainedWhy),
    keptPairs: kept.length,
    keptOrgPairs: new Set(kept.map((x) => [index.entries.get(x.a).org, index.entries.get(x.b).org].sort().join('\n'))).size,
    keptPairsActiveInTheLastWindow: kept.filter(isRecent).length,
    threadsWithMoreThanK: [...perEntry.values()].filter((n) => n > FACTS_K).length,
    ...(vectorStats ? { vectors: vectorStats } : {}),
    ...(clefStats ? { clef: clefStats } : {}),
  },
  partnerHints: {
    pairsWhoseThreadsShareASpecificValue: hintPairs.size,
    ofThemConfirmedOrLikely: hintLinked,
    pairsWithAFactsSignal: withFacts.length,
    candidatesOnlyThroughIt: withFacts
      .filter((x) => x.candidate && x.score - factsWeight(x) < CANDIDATE).length,
    ofThemLinkedAlready: withFacts.filter(linked).length,
    carriedByPartnerPeople: withFacts.filter((x) => x.signals.find((g) => g.kind === 'facts').carried).length,
    hintsForTheAdminTeam: withFacts.filter((x) => x.hint && !x.confirmed && !x.dismissed).length,
  },
}, null, 2));
