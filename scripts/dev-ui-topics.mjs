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

import { TITLER, topicNames } from '../src/label.js';
import { EMBEDDING_MODEL } from '../src/rethread.js';
import {
  centered, MIN_MESSAGES, productsOf, topicFacts,
} from '../src/topicmap.js';
import { topicPlaces } from '../src/topicspace.js';
import { factOf, factWeights, MIN_WEIGHT } from '../src/factweights.js';

/**
 * The Topics page's made-up map for `npm run ui:dev` (`/inbox/topics`): what src/topicmap.js
 * would have written into `topic_maps` for a few hundred threads of the fake inbox's teams, with
 * what production shows: people who work on two or three topics each, customers with a topic of
 * their own, Clef's topics (the tags) on fewer than half the threads and on none of some topics
 * (the gaps the page is for), products of the tech stack and some it does not name, and one
 * topic that is mostly one customer. Seeded, so every start
 * shows the same map. Made-up names and titles only.
 */

/** A seeded random number generator (Park and Miller's), for the same preview every time. */
function random(seed) {
  let a = seed;
  return () => {
    a = (a * 16807) % 2147483647;
    return (a - 1) / 2147483646;
  };
}

// label, theme, the tags Clef gives its threads (and how often), titles, weight.
const TOPICS = [
  ['CDN purge and stale cache', 'Customers see old pages after publishing and need the cache cleared or its rules fixed.', { cdn: 0.5, publishing: 0.2 },
    ['Purge by surrogate key leaves stale pages', 'Cache rule changes have no effect', 'Old CSS served after deploy', 'Stale product images on the live site', 'Purge API returns 403'], 9],
  ['Bring-your-own CDN setup', 'Customers putting their own CDN in front of the site need its origin, headers and keys right.', { cdn: 0.6, project: 0.2 },
    ['Origin headers for our own CDN', 'Push invalidation for a customer CDN', 'Akamai property in front of the site', 'Fastly service setup review'], 8],
  ['Certificates and domains', 'Customers need certificates issued and domains pointed before a launch.', { domains: 0.7 },
    ['Expired certificate served on www', 'Delegating a subdomain', 'Wildcard certificate for regional sites', 'Apex domain redirect'], 6],
  ['Code sync and deploys', 'Code pushed to the repository does not reach the site, or reaches it late.', { code: 0.6, publishing: 0.1 },
    ['Code sync stuck after repository rename', 'Deploy did not pick up the new branch', 'Build passes but the site shows old code', 'Webhook stopped firing'], 9],
  ['Sidekick sign-in', 'Authors cannot sign in to the Sidekick or lose their permissions after a change.', { auth: 0.55 },
    ['Sidekick login fails after SSO change', 'Sidekick shows no publish button', 'Login loop in the Sidekick', 'Authors lost edit rights'], 8],
  ['Admin access and permissions', 'Admins are locked out of the configuration or cannot grant access.', { auth: 0.6 },
    ['Config admin access lost', 'Org admin cannot manage permissions', 'Granting a partner read access', 'Role mapping for a new group'], 7],
  ['Block layout and styling', 'Developers build or fix blocks that look wrong on some screens.', { frontend: 0.5 },
    ['Cards block breaks on mobile', 'Carousel arrows overlap the text', 'Columns block order on small screens', 'Font size in the footer'], 9],
  ['Server-side rendering and navigation', 'Developers want the header, footer or a block rendered on the server.', { frontend: 0.5, performance: 0.1 },
    ['Rendering the header on the server', 'Shared navigation across sites', 'Fragments in the footer', 'Server-side rendering of a product block'], 7],
  ['Images and page speed', 'Pages load slowly because of large images and late hero loading.', { performance: 0.6 },
    ['LCP image preload on product pages', 'Hero image served too large', 'Lighthouse score dropped after release', 'Transparent PNG gets a white background'], 8],
  ['Product feeds', 'Commerce teams need product feeds for marketplaces and reviews mapped right.', {},
    ['Review feed product ids do not match', 'Marketplace feed rejects variants', 'Feed SFTP upload settings', 'Missing prices in the shopping feed'], 7],
  ['Checkout and orders', 'Orders fail or land wrong between the storefront and the commerce backend.', { errors: 0.2 },
    ['Checkout rejects a custom shipping address', 'Orders reassigned between accounts', 'Coupon for a corporate account fails', 'Cart empties after sign-in'], 6],
  ['Storefront build', 'One customer builds a new storefront and works through its open items.', { project: 0.4, frontend: 0.2 },
    ['Storefront product detail page', 'Category page filters', 'Storefront search results', 'Account pages on the storefront'], 8],
  ['Fragments and multi-site rollout', 'Teams roll content out to many sites and languages and need fragments and inheritance to work.', { authoring: 0.5 },
    ['Rolling out fragments to every locale', 'Inheritance breaks for one market', 'Editing fragments in the editor', 'Language copies out of sync'], 6],
  ['Overwrites and publish scope', 'Publishing one thing overwrites or misses another.', { publishing: 0.3 },
    ['Bulk publish overwrites authored content', 'Snapshot publish misses pages', 'Unpublish leaves the page live', 'Preview and live differ'], 6],
  ['Redirects and URLs', 'Customers move pages and need redirects, aliases and links to keep working.', { urls: 0.7 },
    ['Redirects for legacy category URLs', 'Aliases for campaign pages', 'Absolute links between sites', 'Trailing slash redirects'], 7],
  ['Indexing and sitemaps', 'Search engines see too much or too little of the site.', { seo: 0.7 },
    ['Sitemap misses the new section', 'Non-indexable pages show in search', 'Query index empty for one folder', 'Robots rules for the staging site'], 6],
  ['Assets and uploads', 'Authors cannot upload, pick or sync assets from the asset library.', {},
    ['Asset picker shows a network error', 'Upload fails for large videos', 'Renditions missing after sync', 'Assets folder permissions'], 8],
  ['Limits and field validation', 'Customers hit a size, count or length limit and ask for it to be raised.', { limits: 0.6 },
    ['Character limit in text fields', 'Index size limit reached', 'Too many filterable attributes', 'Sheet row limit'], 5],
  ['Errors, load and traffic', 'The site answers with errors under load or bots drive traffic up.', { errors: 0.6 },
    ['503s during a campaign launch', 'Bot traffic spikes on search', 'Rate limits for the API', '500s from one region'], 6],
  ['Forms and integrations', 'Forms and third-party tags need to send their data to the right systems.', { authoring: 0.3 },
    ['Form submissions not reaching the CRM', 'Tag manager loads twice', 'Consent banner blocks analytics', 'Chat widget on every page'], 6],
  ['Optimizer reports', 'Customers question what the optimizer and its reports show.', {},
    ['Optimizer crawl misses pages', 'Report numbers differ from analytics', 'Opportunity list is empty', 'Optimizer access for a new team'], 5],
  ['Go-live dates and rollout', 'Projects agree dates, open items and who does what before launch.', { project: 0.7 },
    ['Go-live checklist for the first site', 'Launch date moved', 'Open items before cutover', 'Pilot status update'], 6],
];

const PEOPLE = [
  ['Dana Ops', [0, 1, 18]], ['Priya Nair', [4, 5, 16]], ['Lena Berg', [6, 7, 13]], ['Tom Okafor', [3, 13, 14]],
  ['Kira Selby', [9, 10, 11]], ['Noor Haddad', [8, 7]], ['Marta Lind', [0, 2]], ['Owen Price', [3, 5]],
  ['Ravi Menon', [14, 15]], ['Sofia Reyes', [16, 17]], ['Jonas Keller', [2, 1, 18]], ['Aiko Tanaka', [12, 13]],
  ['Ben Carter', [20, 15]], ['Elif Demir', [19, 9]], ['Hugo Martin', [21, 11]], ['Isla Grant', [6, 12]],
  ['Mateo Silva', [10, 11]], ['Nina Kowalski', [4, 3]], ['Pavel Novak', [17, 8]], ['Leah Cohen', [21, 19]],
  ['Arjun Rao', [0, 18]], ['Clara Weiss', [12, 16]], ['Felix Braun', [7, 6]], ['Grace Liu', [9, 19]],
];

const ORGS = [
  ['acme', 'ACME Corporation', 'customer'], ['globex', 'Globex', 'customer'], ['initech', 'Initech', 'vendor'],
  ['umbrella', 'Umbrella Corporation', 'customer'], ['hooli', 'Hooli Inc.', 'customer'], ['wonka', 'Wonka Industries', 'customer'],
  ['soylent', 'Soylent Corporation', 'customer'], ['stark', 'Stark Industries', 'customer'], ['wayne', 'Wayne Enterprises', 'customer'],
  ['tyrell', 'Tyrell Corporation', 'customer'], ['cyberdyne', 'Cyberdyne Systems', 'customer'], ['oscorp', 'Oscorp', 'customer'],
  ['aperture', 'Aperture Science', 'customer'], ['vandelay', 'Vandelay Industries', 'partner'], ['gringotts', 'Gringotts', 'customer'],
  ['bluesun', 'Blue Sun', 'customer'], ['opspile', 'opspile', 'internal'],
];
// The products the threads of a topic name (Clairic's `product` facts), and how often: most of
// them the tech stack's (migrations 0043, 0056 and 0061), some not (the Config Service,
// Jira, a crawler), so the preview shows gaps beside the products.
const PRODUCTS = {
  0: { Akamai: 0.3, Fastly: 0.3, 'Edge Functions': 0.15 },
  1: { Akamai: 0.4, Cloudflare: 0.4, CloudFront: 0.2 },
  2: { Cloudflare: 0.3, "Let's Encrypt": 0.2 },
  3: { GitHub: 0.6, 'Code Sync': 0.3, Jira: 0.2 },
  4: { Sidekick: 0.8, Okta: 0.3, 'Admin Console': 0.3 },
  5: { 'Admin Console': 0.4, 'Config Service': 0.3 },
  6: { 'Universal Editor': 0.3 },
  7: { 'Edge Functions': 0.3, 'Document Authoring': 0.2 },
  8: { Lighthouse: 0.3, RUM: 0.3, 'Dynamic Media': 0.3 },
  9: { 'Google Merchant Center': 0.5, Bazaarvoice: 0.4 },
  10: { 'Adobe Commerce': 0.7 },
  11: { 'Adobe Commerce': 0.5, 'Product Bus': 0.4, 'Commerce Optimizer': 0.3 },
  12: { 'Content Fragments': 0.6, 'Universal Editor': 0.3 },
  13: { 'Document Authoring': 0.4, SharePoint: 0.3 },
  15: { 'Google Search Console': 0.3, 'Screaming Frog': 0.3 },
  16: { 'AEM Assets': 0.6, 'Asset Picker': 0.4, 'Dynamic Media': 0.3 },
  19: {
    'Google Tag Manager': 0.4, OneTrust: 0.3, 'Adobe Analytics': 0.3, 'CX Coworker': 0.2,
  },
  20: { 'Sites Optimizer': 0.8, 'Brand Visibility': 0.3 },
};

// The facts the threads of a topic have (src/factweights.js keys, `field:value`), and how often:
// the aem.live docs and the links a topic's threads share, which name it (src/topicmap.js
// topicFacts). Made-up repositories and hosts only.
const FACTS = {
  0: { 'doc:docs/setup-byo-cdn-push-invalidation': 0.4, 'config_file:cdn.yaml': 0.3, 'header:x-cache: miss': 0.3 },
  1: { 'doc:docs/byo-cdn-akamai-setup': 0.35, 'doc:docs/byo-cdn-setup': 0.3, 'config_file:cdn.yaml': 0.3 },
  2: { 'doc:docs/go-live-checklist': 0.3, 'doc:docs/custom-domain': 0.3 },
  3: { 'doc:developer/byo-git': 0.45, 'url:github.com/fake-org/code-sync/issues/42': 0.25, 'repo:fake-org/storefront-boilerplate': 0.2 },
  4: { 'doc:docs/authentication-setup-authoring': 0.4, 'tool:user-admin': 0.3 },
  5: { 'doc:docs/authentication-setup-site': 0.35, 'doc:docs/admin-apikeys': 0.25, 'tool:user-admin': 0.2 },
  6: { 'doc:developer/block-collection': 0.3 },
  7: { 'doc:developer/json2html': 0.35 },
  8: { 'doc:developer/keeping-it-100': 0.4, 'tool:optel': 0.2 },
  12: { 'doc:developer/content-fragment-overlay': 0.35 },
  13: { 'doc:docs/bulk-metadata': 0.2, 'admin_api:preview': 0.3 },
  14: { 'config_file:redirects.json': 0.45, 'doc:docs/redirects': 0.3 },
  15: { 'doc:developer/sitemap': 0.4, 'config_file:query-index.json': 0.3, 'doc:docs/seo-geo': 0.2 },
  17: { 'doc:docs/limits': 0.55 },
  18: { 'url:status.fake-cdn.net/incidents/7781': 0.25, 'http_status:503': 0.4 },
};
// What many threads of any topic have, which names none: a status code, the docs' front page.
const COMMON_FACTS = { 'http_status:404': 0.12, 'http_status:403': 0.06, 'admin_api:config': 0.1 };

/** A key of FACTS as the row of `facts` a rule would have written. */
const factRow = (thread, key) => {
  const i = key.indexOf(':');
  return { thread, field: key.slice(0, i), value: key.slice(i + 1) };
};

// The customers' own people who post, a few per customer (ids from 300).
const CUSTOMER_PEOPLE = {
  acme: ['Ana Ruiz', 'Bram Visser', 'Chen Wei'],
  globex: ['Dara Quinn', 'Eli Moss'],
  umbrella: ['Farah Aziz', 'Gus Holm'],
  wonka: ['Hana Ito', 'Ivo Petrov', 'Jill Hart'],
  hooli: ['Kai Lund'],
  stark: ['Lia Costa', 'Milo Dunn'],
  initech: ['Nils Berg'],
  vandelay: ['Oda Fry'],
};

// The storefront is one customer's.
const OWN_TOPIC = { 11: 'wonka' };
const TEAMS = ['edge', 'platform'];
const SUFFIXES = ['', ' again', ' on the staging site', ' for the new brand', ' after the update', ' in one region'];

/** The map, as src/topicmap.js builds it (`buildTopicMap`'s `map`). */
export function topicMapFixture(now = Date.now(), tech = []) {
  const rnd = random(4242);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const people = Object.fromEntries(PEOPLE.map(([name], i) => [100 + i, name]));
  const theirs = {};
  Object.entries(CUSTOMER_PEOPLE).flatMap(([org, names]) => names.map((name) => [org, name]))
    .forEach(([org, name], i) => {
      people[300 + i] = name;
      theirs[org] = [...(theirs[org] || []), 300 + i];
    });
  const byTopic = TOPICS.map((_, t) => PEOPLE.map((p, i) => [p, i])
    .filter(([p]) => p[1].includes(t))
    .map(([p, i]) => ({ id: 100 + i, lead: p[1][0] === t })));
  // Each customer has two or three topics it asks about most.
  const anyTopic = () => Math.floor(rnd() * TOPICS.length);
  const favorites = Object.fromEntries(ORGS.map(([slug]) => [slug,
    [anyTopic(), anyTopic(), anyTopic()]]));
  const threads = [];
  const facts = [];
  const factRows = [];
  const topics = TOPICS.map(([label, theme, tags, titles, weight], id) => {
    const size = weight * 2 + Math.floor(rnd() * 5);
    for (let n = 0; n < size; n += 1) {
      const sim = Math.round((0.75 - n / size / 2 + rnd() * 0.1) * 1000) / 1000;
      let org = OWN_TOPIC[id] && rnd() < 0.8 ? OWN_TOPIC[id] : pick(ORGS)[0];
      if (!OWN_TOPIC[id] && rnd() < 0.8) {
        org = pick(ORGS.filter(([slug]) => favorites[slug].includes(id))
          .map(([slug]) => slug).concat(org));
      }
      const staff = {};
      const crew = byTopic[id];
      const count = 1 + Math.floor(rnd() * 3);
      for (let c = 0; c < count && crew.length; c += 1) {
        const p = crew.find((x) => x.lead && rnd() < 0.7) || pick(crew);
        staff[p.id] = (staff[p.id] || 0) + 1 + Math.floor(rnd() * 5);
      }
      if (rnd() < 0.05) {
        const other = 100 + Math.floor(rnd() * PEOPLE.length);
        staff[other] = (staff[other] || 0) + 1;
      }
      const at = now - Math.floor(rnd() * 60 * 86400000);
      const key = `slack:T-FAKE:C0TOPIC${String(id).padStart(2, '0')}:${1790000000 + threads.length}.000100`;
      // The storefront customer's own payment system: a gap only one customer names.
      if (OWN_TOPIC[id] && org === OWN_TOPIC[id] && rnd() < 0.4) {
        facts.push({ thread: key, value: 'Choco Pay' });
      }
      for (const [name, p] of Object.entries(PRODUCTS[id] || {})) {
        if (rnd() < p) {
          facts.push({ thread: key, value: name });
        }
      }
      for (const [f, p] of Object.entries({ ...COMMON_FACTS, ...FACTS[id] })) {
        if (rnd() < p) {
          factRows.push({ ...factRow(key, f), org });
        }
      }
      const customers = {};
      for (const c of theirs[org] || []) {
        if (rnd() < 0.5) {
          customers[c] = 1 + Math.floor(rnd() * 4);
        }
      }
      threads.push({
        key,
        title: `${pick(titles)}${rnd() < 0.3 ? pick(SUFFIXES) : ''}`,
        team: org === 'opspile' ? 'platform' : pick(TEAMS),
        org,
        at: new Date(at).toISOString(),
        last: new Date(at + Math.floor(rnd() * 9 * 86400000)).toISOString(),
        messages: MIN_MESSAGES + Math.floor(rnd() * 30),
        kind: pick(['question', 'incident', 'request', 'question']),
        tags: Object.entries(tags).filter(([, p]) => rnd() < p).map(([tag]) => tag),
        topic: id,
        sim,
        staff,
        customers,
      });
    }
    // Found in the area most of its threads are in (none for those Clef tags nothing).
    const area = Object.entries(tags).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return {
      id, label, theme, area, size, cohesion: Math.round((0.42 + rnd() * 0.18) * 1000) / 1000,
    };
  });
  // The topics' places, as src/topicmap.js finds them, from made-up vectors: a thread's is its
  // topic's (near its area's), and some of each person's who posted and of its customer's.
  const DIMS = 32;
  const vec = () => Array.from({ length: DIMS }, () => rnd() - 0.5);
  const near = (base, k) => base.map((x) => x + (rnd() - 0.5) * k);
  const areaVec = new Map();
  const topicVec = topics.map((t) => {
    if (!areaVec.has(t.area)) {
      areaVec.set(t.area, vec());
    }
    return near(areaVec.get(t.area), 0.6);
  });
  const own = new Map();
  const ownOf = (k) => own.get(k) || own.set(k, vec()).get(k);
  const X = centered(threads.map((t) => {
    const parts = [...Object.keys(t.staff), ...Object.keys(t.customers), `org:${t.org}`].map(ownOf);
    return topicVec[t.topic].map((x, d) => x + parts.reduce((sum, p) => sum + p[d] * 0.4, 0)
      + (rnd() - 0.5) * 0.3);
  }));
  const at = topicPlaces(X, threads.map((t) => t.topic), {
    people: threads.map((t) => Object.keys({ ...t.staff, ...t.customers })),
    orgs: threads.map((t) => [t.org]),
  });
  topics.forEach((t, i) => Object.assign(t, { at: at[i] }));
  // Their docs and links, as src/topicmap.js finds them.
  const weighed = factWeights(factRows, { threads: threads.length });
  topics.forEach((t) => Object.assign(t, {
    facts: topicFacts(threads.filter((x) => x.topic === t.id)
      .map((x) => ({ thread: x.key, org: x.org })), weighed, threads.length),
  }));
  const order = topics.map((t) => t.id).sort((a, b) => topics[b].size - topics[a].size);
  const renumber = new Map(order.map((old, i) => [old, i]));
  const products = productsOf(facts, tech);
  // Adobe's people in a team each, the customers' in their customer (src/topicmap.js peopleOf).
  const peopleOf = Object.fromEntries(PEOPLE.map((_, i) => [100 + i,
    { staff: true, team: i % 3 ? 'platform' : 'edge' }]));
  for (const [org, ids] of Object.entries(theirs)) {
    for (const id of ids) {
      peopleOf[id] = { staff: false, org };
    }
  }
  return {
    version: 2,
    peopleOf,
    built_at: new Date(now - 2 * 86400000).toISOString(),
    built_by: 'cron',
    model: EMBEDDING_MODEL,
    namer: TITLER,
    min_messages: MIN_MESSAGES,
    topics: order.map((old, i) => ({ ...topics[old], id: i })),
    threads: threads.map((t) => ({
      ...t, topic: renumber.get(t.topic), products: products.of.get(t.key) || [],
    }))
      .sort((a, b) => a.topic - b.topic || b.sim - a.sim),
    people,
    orgs: Object.fromEntries(ORGS.map(([slug, name, type]) => [slug, { name, type }])),
    tags: topicNames(),
    products: products.products,
  };
}

/** The made-up map in `topic_maps`, as the cron would have kept it, of the tech stack in `DB`. */
export function seedTopicMap(DB, now = Date.now()) {
  const tech = DB.sqlite.prepare(`SELECT tech, name, description, product FROM tech_stack
    WHERE enabled = 1 ORDER BY team = 'admin' DESC`).all();
  const map = topicMapFixture(now, tech);
  DB.sqlite.prepare(`INSERT INTO topic_maps (built_at, built_by, threads, k, map)
    VALUES (?, ?, ?, ?, ?)`).run(map.built_at, map.built_by, map.threads.length, map.topics.length, JSON.stringify(map));
}

// ---- Trends (ui/trendview.js) -----------------------------------------------------------

// How often each topic comes up over the weeks of the preview, against the rest (1): some rise
// (trending), some fall (declining), some had their weeks and are back to a trickle (peaked).
const RISE = (w, n) => (w < n - 9 ? 1 : 1 + (w - (n - 9)) * 0.45);
const FALL = (w, n) => (w < n - 8 ? 2.6 : 0.6);
const BUMP = (at) => (w, n) => 1 + 6 * Math.exp(-((w - (n - at)) ** 2) / 5);
const PROFILES = {
  1: RISE, 9: RISE, 20: RISE, 4: FALL, 16: FALL, 2: BUMP(20), 21: BUMP(14), 11: BUMP(11),
};
const TREND_WEEKS = 30;

/**
 * The trends' data for `npm run ui:dev`, in GET /api/topics/trends's shape (src/trends.js
 * `trendsData`), of the made-up topic map `map` (its topics and products): half a year of threads
 * in sixty channels, with topics that are trending, declining and peaked, one of them mostly one
 * customer's (the storefront). Seeded. With it what the match and threads endpoints answer.
 */
export function trendsFixture(now = Date.now(), weeks = [], { id: mapId = 1, map = null } = {}) {
  const rnd = random(777);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const n = weeks.length;
  const start = n - TREND_WEEKS;
  const orgs = ORGS.filter(([, , type]) => type !== 'internal');
  const channels = Array.from({ length: 60 }, (_, c) => ({
    org: c < 6 ? 'wonka' : orgs[c % orgs.length][0],
    team: TEAMS[c % 2],
    source: c % 4 === 3 ? 'teams' : 'slack',
  }));
  const lists = {
    org: orgs.map(([slug]) => slug), team: TEAMS, source: ['slack', 'teams'], kind: ['question', 'incident', 'request', 'access'],
  };
  const areaIds = [...new Set(TOPICS.flatMap(([, , tags]) => Object.keys(tags)))];
  const areaNames = topicNames();
  // The map's topic of each of TOPICS, and the products its threads have there, and how often.
  const topics = map?.topics || [];
  const topicId = TOPICS.map(([label]) => Math.max(0, topics.findIndex((t) => t.label === label)));
  const techIds = Object.keys(map?.products || {}).filter((pid) => pid.startsWith('tech:'));
  const productsOfTopic = TOPICS.map((_, t) => {
    const mine = (map?.threads || []).filter((x) => x.topic === topicId[t]);
    const counts = new Map();
    for (const x of mine) {
      for (const pid of x.products || []) {
        counts.set(pid, (counts.get(pid) || 0) + 1);
      }
    }
    return [...counts].filter(([pid]) => techIds.includes(pid))
      .map(([pid, c]) => [pid, c / (mine.length || 1)]);
  });
  const threads = [];
  const titles = new Map();
  const factRows = [];
  let id = 1000;
  const profile = (t, into) => (PROFILES[t] ? PROFILES[t](into, TREND_WEEKS) : 1);
  const kinds = lists.kind.length;
  for (let w = start; w < n; w += 1) {
    const weights = TOPICS.map(([, , , , weight], t) => weight * profile(t, w - start));
    const total = weights.reduce((x, y) => x + y, 0);
    // The week under way has less of everything, as it is not over.
    const busy = w === n - 1 ? 0.3 : 0.65;
    for (let c = 0; c < channels.length; c += 1) {
      const ch = channels[c];
      const count = rnd() > busy ? 0 : 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < count; k += 1) {
        let r = rnd() * total;
        let topic = 0;
        while (r > weights[topic]) {
          r -= weights[topic];
          topic += 1;
        }
        // The storefront is the storefront customer's.
        if (OWN_TOPIC[topic] && ch.org !== OWN_TOPIC[topic] && rnd() < 0.85) {
          topic = 0;
        }
        const [, , tags, ttl] = TOPICS[topic];
        id += 1;
        const msgs = [w, 1 + Math.floor(rnd() * 5)];
        if (w + 1 < n && rnd() < 0.3) {
          msgs.push(w + 1, 1 + Math.floor(rnd() * 3));
        }
        const areas = Object.entries(tags).filter(([, p]) => rnd() < p + 0.2);
        const tech = productsOfTopic[topic].filter(([, p]) => rnd() < p);
        const into = w - start;
        // Fewer than in the map's threads: these are all threads, not only the long ones.
        const has = Object.entries({ ...COMMON_FACTS, ...FACTS[topic] })
          .filter(([, p]) => rnd() < p / 2).map(([f]) => f);
        // The limits doc comes up more and more of late (trending), and one pull request is in
        // many customers' threads in the last full week (a spike), as a fix everyone waits for.
        if (into > TREND_WEEKS - 9 && rnd() < 0.02 * (into - (TREND_WEEKS - 9))) {
          has.push('doc:docs/limits');
        }
        if (w === n - 2 && c % 3 === 0 && rnd() < 0.7) {
          has.push('url:github.com/fake-org/edge-worker/pull/57');
        }
        const theirs = [...new Set(has)];
        for (const f of theirs) {
          factRows.push({ ...factRow(id, f), org: ch.org });
        }
        threads.push([
          id, w, c, lists.org.indexOf(ch.org), lists.team.indexOf(ch.team),
          lists.source.indexOf(ch.source), Math.floor(rnd() * kinds), topicId[topic],
          areas.map(([x]) => areaIds.indexOf(x)), tech.map(([x]) => techIds.indexOf(x)), msgs,
          theirs,
        ]);
        titles.set(id, {
          id,
          key: `slack:T-FAKE:C0TREND${String(c).padStart(2, '0')}:${1790000000 + id}.000100`,
          team: ch.team,
          org: ch.org,
          source: ch.source,
          at: `${weeks[w]}T10:00:00.000Z`,
          messages: msgs[1] + (msgs[3] || 0),
          title: `${pick(ttl)}${rnd() < 0.3 ? pick(SUFFIXES) : ''}`,
          topic,
        });
      }
    }
  }
  // The facts src/trends.js counts: of two customers or more, and weighing enough.
  const { weights } = factWeights(factRows, { threads: threads.length });
  const factKeys = [...weights.values()].filter((x) => x.threads >= 2 && x.orgs >= 2
    && x.weight >= MIN_WEIGHT).map((x) => x.key).sort();
  for (const t of threads) {
    t[11] = t[11].filter((f) => factKeys.includes(f)).map((f) => factKeys.indexOf(f));
  }
  const data = {
    weeks,
    map: {
      id: mapId, built_at: map?.built_at || new Date(now).toISOString(), assigned: threads.length,
    },
    available: true,
    channels: channels.length,
    orgs: lists.org.map((slug) => {
      const [, name, type] = ORGS.find(([s]) => s === slug);
      return { slug, name, type };
    }),
    teams: lists.team,
    sources: lists.source,
    kinds: lists.kind,
    areas: areaIds.map((a) => ({ id: a, name: areaNames[a] || a })),
    tech: techIds.map((pid) => ({
      id: pid.slice(5), name: map.products[pid].name, product: map.products[pid].product || null,
    })),
    fields: {
      doc: 'Documentation',
      url: 'URL',
      repo: 'Repository',
      config_file: 'Configuration file',
      tool: 'Tool',
      http_status: 'HTTP status',
      admin_api: 'Admin API',
      header: 'Header',
    },
    facts: factKeys.map((key) => {
      const f = factOf(key);
      const w = weights.get(key);
      return {
        key,
        field: f.field,
        label: f.label,
        href: f.href,
        weight: w.weight,
        threads: w.threads,
        orgs: w.orgs,
      };
    }),
    threads,
  };
  const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 3);
  return {
    data,
    /** As GET /api/topics/trends/match: words in a title; a phrase, topics with a word of it. */
    match(term) {
      const t = String(term || '').trim();
      const all = [...titles.values()];
      if (t.startsWith('~')) {
        const want = new Set(words(t.slice(1)));
        const about = new Set(TOPICS.map(([label, theme], tid) => (words(`${label} ${theme}`)
          .some((x) => want.has(x)) ? tid : -1)));
        const ids = all.filter((x) => about.has(x.topic)).map((x) => x.id);
        return { ids, semantic: true, capped: false };
      }
      const word = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^a-z0-9])${word}($|[^a-z0-9])`);
      const ids = all.filter((x) => re.test(x.title.toLowerCase())).map((x) => x.id);
      return { ids, semantic: false, capped: false };
    },
    /** As GET /api/topics/trends/threads. */
    threads: (ids) => ids.map(Number).map((i) => titles.get(i)).filter(Boolean)
      .map((x) => ({ ...x, topic: undefined })),
  };
}
