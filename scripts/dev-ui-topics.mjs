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
import { MIN_MESSAGES, productsOf } from '../src/topicmap.js';

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

// The storefront is one customer's.
const OWN_TOPIC = { 11: 'wonka' };
const TEAMS = ['edge', 'platform'];
const SUFFIXES = ['', ' again', ' on the staging site', ' for the new brand', ' after the update', ' in one region'];

/** The map, as src/topicmap.js builds it (`buildTopicMap`'s `map`). */
export function topicMapFixture(now = Date.now(), tech = []) {
  const rnd = random(4242);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const people = Object.fromEntries(PEOPLE.map(([name], i) => [100 + i, name]));
  const byTopic = TOPICS.map((_, t) => PEOPLE.map((p, i) => [p, i])
    .filter(([p]) => p[1].includes(t))
    .map(([p, i]) => ({ id: 100 + i, lead: p[1][0] === t })));
  // Each customer has two or three topics it asks about most.
  const anyTopic = () => Math.floor(rnd() * TOPICS.length);
  const favorites = Object.fromEntries(ORGS.map(([slug]) => [slug,
    [anyTopic(), anyTopic(), anyTopic()]]));
  const threads = [];
  const facts = [];
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
      });
    }
    return {
      id, label, theme, size, cohesion: Math.round((0.42 + rnd() * 0.18) * 1000) / 1000,
    };
  });
  const order = topics.map((t) => t.id).sort((a, b) => topics[b].size - topics[a].size);
  const renumber = new Map(order.map((old, i) => [old, i]));
  const products = productsOf(facts, tech);
  return {
    version: 1,
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
