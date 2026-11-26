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
 * How many partner threads get a customer, and how surely (src/threadlinks.js), measured on a
 * D1 database through the `cf` CLI, reading only: counts, never names or text.
 *
 *   STAFF_DOMAINS=<domains> node scripts/thread-orgs-measure.mjs <database id>
 *     [--profile <cf profile>] [--clef <n> --bucket <pile 2's bucket>]
 *
 * The customers each partner works for are the candidate pairs src/orgpartners.js finds (Clef is
 * not asked, so they stand for the likely ones), the text is the threads' titles (the Worker reads
 * their messages too, and asks Clef), and the partners in a customer's threads are those of
 * src/partners.js's domains. Every statement that is not a SELECT is refused, not sent.
 *
 * With `--clef <n>`, n of the last 90 days' partner threads whose partner has customers are
 * measured as the Worker does it, too: their messages read from pile 2 (`--bucket`) and Clef asked
 * about each customer (Workers AI through `cf ai run`). Nothing is written anywhere.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { orgPartners, ownerOf } from '../src/orgpartners.js';
import { partnerDomains } from '../src/partners.js';
import { partnerOf } from '../src/profiles.js';
import { stateOf, threadMessages } from '../src/label.js';
import {
  ABOUT_MIN, aboutOf, aboutQuestion, aboutScores, ASK_CUSTOMERS,
} from '../src/threadlinks.js';

const [db, ...rest] = process.argv.slice(2);
if (!db) {
  console.error('usage: node scripts/thread-orgs-measure.mjs <database id> [--profile <profile>]');
  process.exit(2);
}
const at = rest.indexOf('--profile');
const profile = at >= 0 ? ['--profile', rest[at + 1]] : [];
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const sample = Number(opt('--clef')) || 0;
const bucket = opt('--bucket');
const run = promisify(execFile);

/** A table or column the database has not yet (migrations not applied there): no rows. */
const NOT_YET = /\borg_partners\b|\bthread_orgs\b|\bthread_links\b|p\.excluded|p\.org\b/;

function query(sql, params) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return { results: [], meta: { changes: 0 } };
  }
  if (NOT_YET.test(sql)) {
    return { results: [], meta: { changes: 0 } };
  }
  const out = execFileSync('cf', [...profile, 'd1', 'query', db, '--body', JSON.stringify({ sql, params })], {
    encoding: 'utf8', maxBuffer: 1024 * 1024 * 512,
  });
  const parsed = JSON.parse(out);
  return { results: parsed[0].results || [], meta: { changes: 0 } };
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
// The Worker's vars it needs, from the environment (STAFF_DOMAINS: Adobe's own mail domains).
const env = { DB, STAFF_DOMAINS: process.env.STAFF_DOMAINS || '' };

/** Pile 2, read-only, over the CLI: `list` and `get`, as src/filecache.js asks. */
const cfJson = async (args) => JSON.parse((await run('cf', [...profile, ...args], {
  encoding: 'utf8', maxBuffer: 1024 * 1024 * 64,
})).stdout);
const CHANNELS = {
  // src/filecache.js keeps a snapshot of a large folder: refused here, nothing is written.
  async put() {
    return null;
  },
  async list({ prefix, cursor }) {
    const objects = await cfJson(['r2', 'objects', 'list', '--bucket-name', bucket, '--prefix', prefix,
      ...(cursor ? ['--cursor', cursor] : [])]);
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
/** Workers AI over the CLI: Clef only. */
const AI = {
  async run(model, input) {
    return cfJson(['ai', 'run', model, '--body', JSON.stringify(input)]);
  },
};

const band = (p) => {
  if (p >= 0.9) {
    return '0.9+';
  }
  if (p >= 0.8) {
    return '0.8–0.9';
  }
  if (p >= 0.7) {
    return '0.7–0.8';
  }
  if (p >= 0.6) {
    return '0.6–0.7';
  }
  return '0.5–0.6';
};
const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const res = await orgPartners(env, { id: 0, email: 'measure', teams: [{ slug: 'admin' }] });
const { pairs } = await res.json();
const byPartner = new Map();
for (const p of pairs.filter((x) => x.candidate)) {
  byPartner.set(p.partner, [...(byPartner.get(p.partner) || []), p.customer]);
}
const orgs = new Map((await DB.prepare('SELECT slug, name, icon, type FROM orgs').all()).results
  .map((o) => [o.slug, o]));

const threads = (await DB.prepare(`SELECT t.*, COALESCE(l.title, t.title) AS title FROM threads t JOIN orgs o ON o.slug = t.org AND o.type = 'partner'
  LEFT JOIN labels l ON l.thread = t.thread
  WHERE t.kind = 'channel' AND t.last_at IS NOT NULL AND t.logical_thread IS NULL`).all()).results;
const facts = (await DB.prepare(`SELECT f.thread, f.field, f.value FROM facts f
  JOIN threads t ON t.thread = f.thread JOIN orgs o ON o.slug = t.org AND o.type = 'partner'`).all()).results;
const factsBy = new Map();
for (const f of facts) {
  factsBy.set(f.thread, [...(factsBy.get(f.thread) || []), f]);
}
const owned = (await DB.prepare(`SELECT DISTINCT t.org, f.field, f.value
  FROM facts f JOIN threads t ON t.thread = f.thread LEFT JOIN orgs o ON o.slug = t.org
  WHERE COALESCE(o.type, 'customer') != 'partner' AND SUBSTR(t.org, 1, 1) != '_'
    AND (f.field IN ('site', 'repo') OR (f.field = 'url' AND (f.value LIKE '%.aem.%'
      OR f.value LIKE '%.hlx.%' OR f.value LIKE '%github.com/%')))`).all()).results;
const owners = new Map();
for (const r of owned) {
  const o = ownerOf(r.field, r.value);
  if (o) {
    if (!owners.has(o)) {
      owners.set(o, new Set());
    }
    owners.get(o).add(r.org);
  }
}

const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
const stats = {
  partnerThreads: threads.length,
  recent: 0,
  withCustomers: 0,
  about: 0,
  aboutRecent: 0,
  several: 0,
  buckets: new Map(),
  via: new Map(),
};
for (const t of threads) {
  const recent = t.last_at >= since;
  if (recent) {
    stats.recent += 1;
  }
  const customers = (byPartner.get(t.org) || []).map((s) => ({ slug: s, ...(orgs.get(s) || {}) }));
  t.customers = customers;
  if (customers.length) {
    stats.withCustomers += 1;
    const scores = aboutScores({
      customers, facts: factsBy.get(t.thread) || [], owners, channel: t.channel_name, title: t.title, text: '',
    });
    const about = aboutOf(scores);
    if (about.length) {
      stats.about += 1;
      if (recent) {
        stats.aboutRecent += 1;
      }
      if (about.length > 1) {
        stats.several += 1;
      }
      count(stats.buckets, band(about[0].p));
      for (const v of about[0].via.split(',')) {
        count(stats.via, v);
      }
    }
  }
}

// As the Worker does it, for a sample: the messages' words, and Clef.
const clefStats = {
  sampled: 0, about: 0, several: 0, buckets: new Map(), via: new Map(), factsOnly: 0,
};
if (sample && bucket) {
  const pool = threads.filter((t) => t.last_at >= since && t.customers.length)
    .sort((a, b) => String(a.thread).localeCompare(String(b.thread)));
  // Every k-th, for a spread over partners and time.
  const step = Math.max(1, Math.floor(pool.length / sample));
  const picked = pool.filter((_, i) => i % step === 0).slice(0, sample);
  const one = async (t) => {
    const messages = await threadMessages({ ...env, CHANNELS }, t);
    const { customers } = t;
    const text = messages.filter((m) => !m.deletedAt).map((m) => m.body || '').join('\n');
    const scores = aboutScores({
      env,
      customers,
      facts: factsBy.get(t.thread) || [],
      owners,
      channel: t.channel_name,
      title: t.title,
      text,
    });
    const partner = (orgs.get(t.org) || {}).name || t.org;
    const ask = customers.slice(0, ASK_CUSTOMERS);
    const state = `This channel is of ${partner}, a partner of Adobe's (an agency or system integrator)`
      + ` that works for several of Adobe's customers.\n${stateOf({ ...t, org_type: 'partner' }, messages)}`;
    const questions = Object.fromEntries(ask.map((c, i) => [`about_${i}`, aboutQuestion(c, partner)]));
    const said = messages.length ? await AI.run('@cf/cloudflare/clef', { model: 'clef', state, questions })
      .catch(() => null) : null;
    const clef = new Map();
    ask.forEach((c, i) => {
      const p = Number(said && said.answers && said.answers[`about_${i}`] && said.answers[`about_${i}`].noul);
      if (Number.isFinite(p)) {
        clef.set(c.slug, p);
      }
    });
    return { about: aboutOf(scores, clef), factsOnly: aboutOf(scores).length > 0 };
  };
  for (let i = 0; i < picked.length; i += 4) {
    // eslint-disable-next-line no-await-in-loop
    const got = await Promise.all(picked.slice(i, i + 4).map((t) => one(t).catch(() => null)));
    for (const g of got.filter(Boolean)) {
      clefStats.sampled += 1;
      if (g.factsOnly) {
        clefStats.factsOnly += 1;
      }
      if (g.about.length) {
        clefStats.about += 1;
        if (g.about.length > 1) {
          clefStats.several += 1;
        }
        count(clefStats.buckets, band(g.about[0].p));
        for (const v of g.about[0].via.split(',')) {
          count(clefStats.via, v);
        }
      }
    }
  }
}

// The partners in customers' threads.
const domains = await partnerDomains(env);
const posted = (await DB.prepare(`SELECT COALESCE(t.logical_thread, t.thread) AS g, t.org,
    LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain
  FROM messages m JOIN threads t ON t.thread = m.thread
  JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
  LEFT JOIN orgs o ON o.slug = t.org
  WHERE COALESCE(o.type, 'customer') = 'customer' AND t.kind = 'channel' AND SUBSTR(t.org, 1, 1) != '_'
    AND m.staff = 0 AND m.deleted = 0 AND m.counted = 1 AND i.email LIKE '%_@_%'
  GROUP BY g, t.org, domain`).all()).results;
const customerThreads = new Set();
const partnersIn = new Map();
for (const r of posted) {
  customerThreads.add(r.g);
  const p = partnerOf(r.domain, domains);
  if (p && p.org && p.org !== r.org && (orgs.get(p.org) || {}).type === 'partner') {
    partnersIn.set(r.g, new Set([...(partnersIn.get(r.g) || []), p.org]));
  }
}
const pairsWith = new Set();
for (const p of pairs.filter((x) => x.candidate)) {
  pairsWith.add(p.partner);
}

console.log(JSON.stringify({
  candidatePairs: pairs.filter((x) => x.candidate).length,
  partnersWithCustomers: byPartner.size,
  partnerThreads: stats.partnerThreads,
  partnerThreadsLast90Days: stats.recent,
  partnerThreadsWhosePartnerHasCustomers: stats.withCustomers,
  partnerThreadsWithACustomer: stats.about,
  partnerThreadsWithACustomerLast90Days: stats.aboutRecent,
  withSeveralCustomers: stats.several,
  byConfidence: Object.fromEntries([...stats.buckets].sort()),
  byWhatSaidSo: Object.fromEntries(stats.via),
  customerThreadsWithPosters: customerThreads.size,
  customerThreadsWithAPartner: partnersIn.size,
  partnerOrgsInCustomerThreads: new Set([...partnersIn.values()].flatMap((s) => [...s])).size,
  ...(clefStats.sampled ? {
    sample: {
      threads: clefStats.sampled,
      withACustomer: clefStats.about,
      withACustomerFromFactsAndTitleAlone: clefStats.factsOnly,
      withSeveralCustomers: clefStats.several,
      byConfidence: Object.fromEntries([...clefStats.buckets].sort()),
      byWhatSaidSo: Object.fromEntries(clefStats.via),
      threshold: ABOUT_MIN,
    },
  } : {}),
}, null, 2));
