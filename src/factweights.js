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
 * Trends count a doc or a URL week by week as they count a word (src/trends.js).
 */

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
