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
 * How much a fact says about what a thread is about (docs/ARCHITECTURE.md, "Fact weights"): the
 * facts of the extraction rules and Clairic's (`facts`), each as a key that is the same whatever
 * form a thread wrote it in (`factKey`), weighted by tf-idf over the threads (`factWeights`). A
 * documentation page, a pull request, an error endpoint or an AEM Cloud Service environment that
 * few threads share weighs much; a status code, an admin API operation or a link every thread's
 * signature has weighs little, and placeholders (`org/site`, `https://main`), hosts no topic is
 * about (gmail.com, schema.org) and Clairic's free-text problem nothing.
 *
 * The topic map names and describes its topics with them (src/topicmap.js `topicFacts`), and the
 * Trends count a doc or a URL week by week as they count a word (src/trends.js). The thread links
 * weigh what two threads share with the same keys and weights (`linkFact`, `keyWeight`, below).
 */

import { isolateCache } from './isolatecache.js';

/**
 * Fields that say nothing of what a thread is about: Clairic's problem (free text, one value per
 * thread), and the dates of a deadline or a go-live.
 */
export const SKIP_FIELDS = new Set(['problem', 'deadline', 'go_live']);

/** Hosts whose links are about no topic, with any path. */
export const GENERIC_HOSTS = new Set(['gmail.com', 'schema.org', 'w3.org', 'example.com',
  'example.org', 'example.net', 'localhost', 'urldefense.com', 'safelinks.protection.outlook.com',
  'google.com', 'bit.ly', 'goo.gl', 'aka.ms']);

/** Hosts whose front page (a link with no path) is about no topic. */
const BARE_HOSTS = new Set(['github.com', 'adobe.com', 'aem.live', 'aem.page', 'hlx.live',
  'hlx.page', 'da.live', 'workers.dev', 'experience.adobe.com', 'experienceleague.adobe.com',
  'business.adobe.com', 'developer.adobe.com', 'tools.aem.live', 'admin.hlx.page', 'youtube.com',
  'microsoft.com', 'teams.microsoft.com', 'sharepoint.com', 'figma.com', 'npmjs.com',
  'cloudflare.com', 'fastly.com', 'akamai.com', 'vercel.app', 'netlify.app', 'pages.dev']);

/** Documentation sites: their pages are `doc` keys, as the extraction rules' aem.live pages. */
const DOC_HOSTS = new Set(['experienceleague.adobe.com', 'developer.adobe.com', 'docs.da.live',
  'helpx.adobe.com']);

/** A part of an `org/site` or `owner/repo` that stands for one: a placeholder in a how-to. */
const PLACEHOLDER = /^[<{[]?(?:your[-_]?|my[-_]?)?(?:org|owner|site|repo|project|name|user|branch|ref)s?[>}\]]?$/i;

const host = (h) => h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
const generic = (h) => GENERIC_HOSTS.has(h) || [...GENERIC_HOSTS].some((g) => h.endsWith(`.${g}`));

/** An aem.live page of the documentation, as the extraction rules write it (`docs/limits`). */
function aemDoc(h, path) {
  if (!['aem.live', 'hlx.live'].includes(h)) {
    return null;
  }
  const m = path.match(/^\/((?:docs|developer)\/[\w.-]+(?:\/[\w.-]+)*)$/);
  return m ? m[1].toLowerCase().replace(/\.html?$/, '') : null;
}

/** A URL's key (`url:host/path`, `doc:…`, `repo:…`, `tool:…`), or null when it names nothing. */
function urlKey(value) {
  const raw = String(value).trim().replace(/[)\].,;:'">]+$/, '');
  if (/^(?:mailto|tel|data|javascript|file|ftp|blob):/i.test(raw)) {
    return null;
  }
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return null;
  }
  const h = host(u.hostname);
  // A host with no dot is a placeholder or a machine (`https://main`, `http://localhost`).
  if (!h.includes('.') || /^\d+(?:\.\d+){3}$/.test(h) || generic(h)) {
    return null;
  }
  // Without the query, the fragment, a line and column (`aem.js:547:15`) and a trailing slash.
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // As it is: a stray `%` is part of no escape.
  }
  path = path.replace(/(?::\d+){1,2}$/, '').replace(/\/+$/, '');
  if (!path) {
    return BARE_HOSTS.has(h) ? null : `url:${h}`;
  }
  const doc = aemDoc(h, path);
  if (doc) {
    return `doc:${doc}`;
  }
  if (/^(?:aem|hlx)\.live$/.test(h) && /^\/(?:docs|developer)$/.test(path)) {
    return null;
  }
  if (DOC_HOSTS.has(h)) {
    // One page in every language is one page.
    return `doc:${h}${path.replace(/^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/i, '/en').toLowerCase()}`;
  }
  if (h === 'github.com') {
    const m = path.match(/^\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues|discussions|commit)\/(\w+))?/);
    if (!m || PLACEHOLDER.test(m[1]) || PLACEHOLDER.test(m[2])) {
      return null;
    }
    const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase();
    return m[3] ? `url:github.com/${repo}/${m[3]}/${m[4]}` : `repo:${repo}`;
  }
  if (h === 'tools.aem.live') {
    const m = path.match(/^\/tools\/([\w-]+)/);
    if (m) {
      return `tool:${m[1].toLowerCase()}`;
    }
  }
  return `url:${h}${path}`;
}

/** An `org/site` or `owner/repo`, lowercase, or null for a placeholder. */
function pairKey(field, value) {
  const v = String(value).trim().toLowerCase().replace(/\.git$/, '');
  const parts = v.split('/');
  if (parts.length < 2 || parts.some((p) => !p || PLACEHOLDER.test(p))) {
    return null;
  }
  return `${field}:${v}`;
}

/**
 * A fact's key: the same for every form of one value (`https://www.aem.live/docs/limits#x` and the
 * doc rule's `docs/limits` are `doc:docs/limits`; Clairic's error "404 Not Found" is
 * `http_status:404`), or null for what names nothing: a field of SKIP_FIELDS, a placeholder, a
 * generic host, a front page.
 */
export function factKey(field, value) {
  const f = String(field || '').trim();
  const v = String(value ?? '').trim();
  if (!f || !v || SKIP_FIELDS.has(f) || v.length > 400) {
    return null;
  }
  if (f === 'url' || f === 'affected_url') {
    return urlKey(v);
  }
  if (f === 'doc') {
    const d = v.toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\.html?$/, '');
    return /^(?:docs|developer)\/./.test(d) ? `doc:${d}` : null;
  }
  if (f === 'site' || f === 'repo') {
    return pairKey(f, v);
  }
  if (f === 'error') {
    // A status code with a word or two is the status; anything longer is what it says.
    const status = v.match(/^([1-5]\d\d)\b(?:\s+[\w-]+){0,3}\.?$/);
    return status ? `http_status:${status[1]}` : `error:${v.toLowerCase().replace(/\s+/g, ' ').slice(0, 160)}`;
  }
  if (f === 'header') {
    return `header:${v.toLowerCase().replace(/\\(?=[[\]])/g, '').replace(/\s+/g, ' ')}`;
  }
  return `${f}:${['ticket', 'cve'].includes(f) ? v.toUpperCase() : v.toLowerCase()}`;
}

/**
 * What a key is, to show it: `{ field, value, label, href }`, `href` the page of a doc or a URL
 * (an aem.live doc on www.aem.live), null for the rest.
 */
export function factOf(key) {
  const i = String(key).indexOf(':');
  const field = key.slice(0, i);
  const value = key.slice(i + 1);
  let href = null;
  if (field === 'doc') {
    href = /^(?:docs|developer)\//.test(value) ? `https://www.aem.live/${value}` : `https://${value}`;
  } else if (field === 'url') {
    href = `https://${value}`;
  } else if (field === 'repo') {
    href = `https://github.com/${value}`;
  }
  return {
    field, value, label: value, href,
  };
}

/**
 * The least a fact weighs to name a topic or be counted as a trend: a 404 or an admin API
 * operation that every other thread names weighs less.
 */
export const MIN_WEIGHT = 0.1;

/**
 * A field is of a few values (status codes, admin API operations, configuration files, tools)
 * when it has fewer distinct values than this share of the threads that have it, and at least
 * CATEGORICAL_THREADS of them: a value of it is weighed among those threads too.
 */
export const CATEGORICAL = 0.15;
const CATEGORICAL_THREADS = 20;

/** The inverse document frequency of a value in `df` of `n` documents, from 1 (one) to 0 (all). */
const idf = (df, n) => (n > 1 ? Math.log(n / Math.min(df, n)) / Math.log(n) : 0);

/**
 * The weights of the facts `rows` (`{ thread, field, value, org }`): `{ of, weights }`, `of` each
 * thread's keys (`Map<thread, Set<key>>`), `weights` each key's `{ key, field, weight, threads,
 * orgs }`. The weight is the key's idf over every thread (`threads`, the number counted: those
 * with no fact too; at least the threads of `rows`), normalised so that one thread's key weighs
 * 1 and one in every thread 0; for a field of a few values (CATEGORICAL), times its idf over the
 * threads with a fact of that field: a 404, one of twenty status codes, is in nearly half the
 * threads that have one, and weighs little even where it is rare among all threads. `orgs` counts
 * the customers (`org`) of its threads, for what is one customer's own (its site, its pages)
 * rather than a topic's.
 */
export function factWeights(rows, { threads = 0 } = {}) {
  const of = new Map();
  const seen = new Map();
  const fieldThreads = new Map();
  const fieldValues = new Map();
  for (const r of rows) {
    const key = factKey(r.field, r.value);
    if (key) {
      if (!of.has(r.thread)) {
        of.set(r.thread, new Set());
      }
      if (!of.get(r.thread).has(key)) {
        of.get(r.thread).add(key);
        const s = seen.get(key) || { threads: 0, orgs: new Set() };
        s.threads += 1;
        if (r.org) {
          s.orgs.add(r.org);
        }
        seen.set(key, s);
        const field = key.slice(0, key.indexOf(':'));
        if (!fieldThreads.has(field)) {
          fieldThreads.set(field, new Set());
          fieldValues.set(field, new Set());
        }
        fieldThreads.get(field).add(r.thread);
        fieldValues.get(field).add(key);
      }
    }
  }
  const n = Math.max(threads, of.size);
  const weights = new Map();
  for (const [key, s] of seen) {
    const field = key.slice(0, key.indexOf(':'));
    const nf = fieldThreads.get(field).size;
    const few = nf >= CATEGORICAL_THREADS && fieldValues.get(field).size < CATEGORICAL * nf;
    const weight = idf(s.threads, n) * (few ? idf(s.threads, nf) : 1);
    weights.set(key, {
      key, field, weight: Math.round(weight * 1000) / 1000, threads: s.threads, orgs: s.orgs.size,
    });
  }
  return { of, weights };
}

// ---- for thread links ------------------------------------------------------------------------

/*
 * The same keys and the same tf-idf (`factKey`, `factWeights`), for whether two threads are about
 * one thing (src/threadlinks.js `sharedFacts`, src/orgpartners.js's `facts` signal): what a key
 * weighs there is its tf-idf weight over the inbox entries (`factIndex`) times a base of its own
 * (`linkFact`): its field's (`FIELD_WEIGHTS`), how specific a URL is (`urlSpecificity`), and none
 * for the deny list (the documentation, support, sign-in and chat pages, placeholders) or for a
 * value in more than `COMMON_ORGS` orgs' threads, which is everyone's however rare.
 */

/**
 * Each key field's weight in a link, before its tf-idf. A team's own rule's field is
 * `OTHER_FIELD`. A `url` is scaled by how specific it is (`urlSpecificity`).
 */
export const FIELD_WEIGHTS = {
  aemcs_env: 1,
  repo: 1,
  site: 1,
  url: 1,
  ticket: 1,
  case: 1,
  commerce_project: 1,
  commerce_account: 1,
  figma_file: 0.5,
  cve: 0.5,
  // What many threads have whatever they are about: near zero.
  error: 0.1,
  header: 0.1,
  doc: 0.05,
  config_file: 0.05,
  admin_api: 0.05,
  tool: 0.05,
  http_status: 0.05,
  // Clairic's products from before: none (SKIP_FIELDS have no key).
  product: 0,
};
export const OTHER_FIELD = 0.3;
/** A fact of this weight or more is specific: two threads a candidate, a pair a hint. */
export const SPECIFIC = 0.6;
/** A value in the threads of more orgs than this is everyone's, however few threads have it. */
export const COMMON_ORGS = 6;
/** Adobe's own GitHub owners: their repositories are products many customers build on. */
export const ADOBE_OWNERS = new Set(['adobe', 'adobe-rnd', 'adobe-commerce']);
export const ADOBE_OWNED = 0.3;
/** Hosts of Adobe's products' own endpoints (with their subdomains): `ADOBE_OWNED` too. */
export const ADOBE_HOSTS = ['mcp.adobeaemcloud.com', 'adobeaem.workers.dev'];
/** A URL of a host alone, of one path segment. */
export const HOST_ONLY = 0.2;
export const ONE_SEGMENT = 0.6;

/**
 * Hosts whose pages are nobody's issue in a link (with their subdomains), beyond `GENERIC_HOSTS`:
 * Adobe's support, status and sign-in pages, chat and meetings, the web's references, vendors'
 * product pages, Adobe's shared documents and internal tools.
 */
export const DENY_HOSTS = [
  'business.adobe.com', 'status.adobe.com', 'aemstatus.net', 'feedbackprogram.adobe.com',
  'adobe.com', 'blog.adobe.com', 'adobelogin.com', 'auth.services.adobe.com', 'account.adobe.com',
  'adminconsole.adobe.com', 'login.microsoftonline.com', 'accounts.google.com', 'okta.com',
  'teams.microsoft.com', 'slack.com', 'zoom.us', 'meet.google.com', 'youtube.com', 'youtu.be',
  'loom.com', 'vimeo.com', 'day.com', 'developer.mozilla.org', 'developers.google.com',
  'support.google.com', 'docs.github.com', 'stackoverflow.com', 'chromewebstore.google.com',
  'techdocs.akamai.com', 'docs.fastly.com', 'fastly.com', 'developers.cloudflare.com',
  'cloudflare.com', 'learn.microsoft.com', 'wikipedia.org', 'npmjs.com', 'outlook.com',
  'microsoft.com', 'akamai.com', 'sharepoint.com', 'dynamics.com', 'office.com', 'adobe.net',
  'rum.hlx.page', 'rum.aem.live', 'aemcoder.adobe.io', 'docs.adobecommerce.live',
];
/** Hosts that are a product's own pages only themselves (aem.live's; its sites are subdomains). */
const DENY_EXACT = new Set(['aem.live', 'aem.page', 'hlx.live', 'hlx.page', 'da.live']);
/** GitHub's own pages, which `factKey` reads as a repository (`github.com/apps/<app>`). */
const GITHUB_PAGES = new Set(['apps', 'orgs', 'organizations', 'settings', 'marketplace', 'features',
  'pricing', 'sponsors', 'notifications', 'new', 'explore', 'topics', 'enterprise', 'login',
  'users', 'search', 'collections', 'about']);
/** Paths that are a host's sign-in or settings, the admin API's routes alone. */
const DENY_PATHS = [
  [/./, /^\/(login|logout|signin|sign-in|signup|auth|oauth|settings|profile|account)(\/|$)/],
  [/^(admin\.hlx\.page|admin\.aem\.live|admin\.da\.live|api\.aem\.live)$/, /^\/[^/]+\/?$/],
];
/** A placeholder or a cut value, in a fact as it was written. */
const LINK_PLACEHOLDER = /[{}<>$]|\.\.\.|…|\bx{3,}\b|\byour[-_]/i;
const PLACEHOLDER_NAMES = new Set(['org', 'site', 'owner', 'repo', 'repository', 'organization',
  'project', 'test', 'foo', 'bar', 'name', 'user', 'username', 'myorg', 'mysite', 'myrepo']);

const denied = (h) => DENY_EXACT.has(h) || DENY_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));

/**
 * How specific a `url:` key's host and path are: a GitHub pull request, issue, commit or
 * discussion 1; an Edge Delivery site or a product endpoint of Adobe's own `ADOBE_OWNED`; a host
 * alone `HOST_ONLY`, one path segment `ONE_SEGMENT`, more 1.
 */
export function urlSpecificity(h, path) {
  const seg = path.split('/').filter(Boolean);
  if (h === 'github.com' && ['pull', 'issues', 'commit', 'discussions'].includes(seg[2])) {
    return 1;
  }
  const site = h.match(/^[a-z0-9-]+--([a-z0-9-]+)\.(?:aem|hlx)\.(?:live|page)$/);
  const owner = site && site[1].split('--').pop();
  const product = ADOBE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  const adobe = (owner && ADOBE_OWNERS.has(owner)) || product ? ADOBE_OWNED : 1;
  if (!seg.length) {
    return Math.min(adobe, HOST_ONLY);
  }
  return adobe * (seg.length === 1 ? ONE_SEGMENT : 1);
}

/**
 * The base of a key in a link (`factKey`'s), before its tf-idf: its field's weight, a URL's
 * specificity, a repository of Adobe's own `ADOBE_OWNED`; 0 for the deny list's.
 */
export function linkBase(key) {
  const i = key.indexOf(':');
  const field = key.slice(0, i);
  const value = key.slice(i + 1);
  const weight = Object.hasOwn(FIELD_WEIGHTS, field) ? FIELD_WEIGHTS[field] : OTHER_FIELD;
  if (field === 'url') {
    const slash = value.indexOf('/');
    const h = slash < 0 ? value : value.slice(0, slash);
    const path = (slash < 0 ? '' : value.slice(slash)).toLowerCase();
    if (denied(h) || DENY_PATHS.some(([hp, pp]) => hp.test(h) && pp.test(path || '/'))) {
      return 0;
    }
    return weight * urlSpecificity(h, path);
  }
  if (field === 'site' || field === 'repo') {
    const [owner, name] = value.split('/');
    if (PLACEHOLDER_NAMES.has(owner) || PLACEHOLDER_NAMES.has(name)
      || (field === 'repo' && GITHUB_PAGES.has(owner))) {
      return 0;
    }
    return ADOBE_OWNERS.has(owner) ? weight * ADOBE_OWNED : weight;
  }
  return weight;
}

/**
 * A fact as a link reads it: `{ key, field, base }`, `key` its `factKey`, `base` its `linkBase`;
 * null where it says nothing (no key, a placeholder or a cut value, the deny list's). `field` is
 * the fact's own.
 */
export function linkFact(field, value) {
  const v = String(value ?? '').trim();
  const key = !LINK_PLACEHOLDER.test(v) && factKey(field, v);
  const base = key ? linkBase(key) : 0;
  return base > 0 ? { key, field: String(field), base } : null;
}

/** What a pair's shared facts say together: 1 − Π(1 − wᵢ). */
export const combined = (weights) => Math.round(
  (1 - weights.reduce((q, w) => q * (1 - w), 1)) * 1000,
) / 1000;

/** Facts (`[{ field, value }]`) as link keys: `Map<key, { field, value, base }>`, the best. */
export function keysOf(facts) {
  const out = new Map();
  for (const { field, value } of facts) {
    const k = linkFact(field, value);
    if (k && (!out.has(k.key) || out.get(k.key).base < k.base)) {
      out.set(k.key, { field: k.field, value: String(value).trim(), base: k.base });
    }
  }
  return out;
}

/** What the index is kept for in an isolate, as the owners are (src/threadlinks.js). */
export const INDEX_MS = 10 * 60 * 1000;

/**
 * Every channel thread's facts, by inbox entry (the document of the tf-idf), of every org but
 * Adobe's own and the unassigned channels: `{ n, weights, keys, entries }`, `weights`
 * `factWeights`' (over the entries), `keys` the link keys `Map<key, { field, value, base,
 * entries: Set<entry> }>`, `entries` `Map<entry, { org, last, threads: Set<thread> }>`, `n` the
 * entries with any fact.
 */
async function loadIndex(env) {
  const sql = `SELECT f.thread, f.field, f.value, COALESCE(t.logical_thread, t.thread) AS entry,
      t.org, t.last_at FROM facts f JOIN threads t ON t.thread = f.thread
    WHERE t.kind = 'channel' AND SUBSTR(t.org, 1, 1) != '_'
      AND f.field NOT IN (SELECT value FROM json_each(?1))`;
  const { results } = await env.DB.prepare(sql).bind(JSON.stringify([...SKIP_FIELDS])).all();
  const list = results || [];
  const { weights } = factWeights(list.map((r) => ({
    thread: r.entry, field: r.field, value: r.value, org: r.org,
  })));
  const keys = new Map();
  const entries = new Map();
  for (const r of list) {
    if (!entries.has(r.entry)) {
      entries.set(r.entry, { org: r.org, last: r.last_at || null, threads: new Set() });
    }
    const e = entries.get(r.entry);
    e.threads.add(r.thread);
    if (r.last_at && (!e.last || r.last_at > e.last)) {
      e.last = r.last_at;
    }
    const k = linkFact(r.field, r.value);
    if (k) {
      if (!keys.has(k.key)) {
        keys.set(k.key, {
          field: k.field, value: String(r.value).trim(), base: k.base, entries: new Set(),
        });
      }
      const x = keys.get(k.key);
      x.base = Math.max(x.base, k.base);
      x.entries.add(r.entry);
    }
  }
  return {
    n: entries.size, weights, keys, entries,
  };
}

const indexKept = isolateCache(INDEX_MS);

/** The index (`loadIndex`), kept for `INDEX_MS`. */
export async function factIndex(env, { fresh = false } = {}) {
  return indexKept.get(env, loadIndex, { fresh });
}

/** Forgets the index kept (for tests). */
export function forgetFactIndex() {
  indexKept.forget();
}

/**
 * The orgs whose threads have `key` in `index`, with `extra` (`[{ entry, org }]`, an entry whose
 * facts were read since) counted too: `{ df, orgs: Set<org>, entries: Set<entry> }`.
 */
export function spreadOf(index, key, extra = []) {
  const entries = new Set((index.keys.get(key) || { entries: [] }).entries);
  const orgs = new Set([...entries].map((e) => (index.entries.get(e) || {}).org).filter(Boolean));
  for (const x of extra) {
    entries.add(x.entry);
    orgs.add(x.org);
  }
  return { df: entries.size, orgs, entries };
}

/**
 * What `key` weighs in a link, 0 to 1: `base` (`linkBase`) times its tf-idf weight in `index`
 * (`factWeights`), none for a value of more than `COMMON_ORGS` orgs (`extra` counted in, as
 * `spreadOf`), or of no other thread.
 */
export function keyWeight(index, key, base, extra = []) {
  const w = index.weights.get(key);
  if (!w || spreadOf(index, key, extra).orgs.size > COMMON_ORGS) {
    return 0;
  }
  return Math.round(base * w.weight * 1000) / 1000;
}
