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

import { platformName } from './platforms.js';
import { recordDead, sweepDelay, sweepsNow } from './deadjobs.js';
import { fileCache, folderFiles } from './filecache.js';
import {
  extract, rulesFor, techFor, techNames,
} from './extract.js';
import { isStaffDomain } from './lookup.js';
import {
  coveredBy, GENERIC, nameKey, productKey, productLike, techIndex,
} from './products.js';

/**
 * Thread labels (Clef, a decision model) and facts (the teams' extraction rules, plus Clairic,
 * an extraction model, above a confidence threshold). A thread is labeled shortly after it
 * changes; `labeled_through` makes a relabel of an unchanged thread a no-op. The technologies
 * Clef asks about, and the rules, are the teams' configuration (src/extract.js).
 */

export const CLEF = '@cf/cloudflare/clef';
export const CLAIRIC = '@cf/cloudflare/clairic';
export const TITLER = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_TITLE = 90;

/** At or above this, a technology is the channel's (channel_tech); a rule's detection is 1. */
export const TECH_MIN = 0.8;
/** Questions per Clef call: more are asked in calls of their own, at the same time. */
export const MAX_QUESTIONS = 24;

/**
 * What a thread is about, across kinds: an incident and a question can both be about the CDN.
 * Each is one Clef yes/no question in the labeling call; a thread keeps those at or above
 * TOPIC_MIN (labels.topics). `name` is what the inbox shows. No product names: the tech stack
 * says which products a thread is about. Found with the topic map (src/topicmap.js).
 */
export const TOPICS = {
  authoring: {
    name: 'Authoring and content',
    what: 'authoring and content: how authors create and edit pages in the editors and authoring'
      + ' tools (visual editors, documents, spreadsheets, forms), content models, fields and'
      + ' components, reusable content such as fragments and live copies, or rolling content out'
      + ' to locales and translating it, not access to them',
  },
  auth: {
    name: 'Sign-in and permissions',
    what: 'signing in or permissions: login, single sign-on, tokens, API keys or credentials,'
      + ' roles, or an access-denied or unauthorized error',
  },
  project: {
    name: 'Project plan and go-live',
    what: 'a migration or launch project as a whole: moving a site, pages or domains to a new'
      + ' platform, a go-live, launch or cutover and its date, a proof of concept, onboarding, or'
      + ' the project\'s plan, status and next steps, not a single technical question within it',
  },
  cdn: {
    name: 'Caching and delivery',
    what: 'caching and delivery: purging, cache rules and lifetimes, stale content in a cache,'
      + ' push invalidation, origin routing, or how the CDN in front of the site is set up',
  },
  domains: {
    name: 'Domains and certificates',
    what: 'domains, DNS, delegation or TLS certificates',
  },
  performance: {
    name: 'Performance',
    what: 'page performance: Core Web Vitals, LCP, CLS, INP, loading speed, performance reports or'
      + ' scores, or preloading and optimizing what loads first',
  },
  publishing: {
    name: 'Preview and publishing',
    what: 'previewing, publishing or unpublishing content, content (not code) that does not update'
      + ' after publishing, or content overwritten or published by mistake',
  },
  seo: {
    name: 'SEO',
    what: 'SEO: sitemaps, robots.txt, indexing, canonical URLs, structured data, or how search'
      + ' engines or AI assistants show or classify pages',
  },
  urls: {
    name: 'URLs and redirects',
    what: 'URLs: redirects, aliases, vanity or legacy URLs, links between pages, or pages that'
      + ' return 404',
  },
  code: {
    name: 'Code and deployment',
    what: 'code and deployments: the Git repository, code sync, branches, builds, or code changes'
      + ' that do not show on the site',
  },
  frontend: {
    name: 'Blocks and front-end code',
    what: 'the site\'s front-end code: how blocks are built, styled, laid out or rendered, the'
      + ' header, footer or navigation, server-side rendering, or the JavaScript, CSS, fonts and'
      + ' icons in the repository',
  },
  errors: {
    name: 'Errors and traffic',
    what: 'errors and load: 5xx responses, timeouts, outages, error messages from the platform, or'
      + ' unusual or excessive traffic or load, not a sign-in or permission error',
  },
  limits: {
    name: 'Limits and quotas',
    what: 'a product limit: a size, length, count or rate limit or quota, or a request to raise'
      + ' one',
  },
  security: {
    name: 'Security and compliance',
    what: 'security and compliance: protecting a site or origin, secrets and keys, allowlisting'
      + ' IPs or redirect URIs, content security policy, vulnerabilities, privacy, or compliance'
      + ' documents',
  },
  roadmap: {
    name: 'Roadmap and feedback',
    what: 'a product\'s roadmap or feedback on it: a feature that is not generally available yet'
      + ' (beta, early access, an experiment or a pilot), when a feature ships or is enabled, a'
      + ' feature request or suggestion, or feedback on how a product or tool works',
  },
};
/**
 * A thread keeps the topics Clef gives at least this, one cut for every topic: the best on 225
 * threads labeled by hand (macro F1 0.81, the same in 5-fold cross-validation; at 0.8 it was
 * 0.56, with a topic on 41% of the threads that have one). Clef's answers move a little with the
 * other questions of a call: the topics were measured asked with QUESTIONS only, in this order,
 * as labelThread asks them. Measure again when QUESTIONS or the topics change; the tech stack is
 * asked in calls of its own and can change freely.
 */
export const TOPIC_MIN = 0.55;
/**
 * Topics no longer asked, for the labels from before: the topic that took one over, or null for
 * one that is a product, which the tech stack says now.
 */
const RETIRED_TOPICS = { golive: 'project', commerce: null, integrations: null };
export const LABEL_DELAY_SECONDS = 120;
export const MIN_CONFIDENCE = 0.8;
// Free-text spans are scored lower than typed values; this is the measured working point.
const FIELD_CONFIDENCE = { problem: 0.6 };
const MAX_MESSAGES = 40;
const MAX_BODY = 2000;

export const QUESTIONS = {
  next_actor: {
    type: 'choice',
    instructions: 'Who has to act next in this support thread between Adobe staff and a customer?',
    criteria: {
      us: 'Adobe staff: answer a question, fix, investigate, approve, or follow up',
      customer: 'The customer: reply, test, confirm, provide information, or decide',
      vendor: 'A third party (partner, agency or vendor) that is neither Adobe nor the customer',
      nobody: 'Nothing is pending: resolved, acknowledged, FYI or social',
    },
  },
  kind: {
    type: 'choice',
    instructions: 'What kind of thread is this?',
    criteria: {
      incident: 'Something is broken, down or degraded, usually in production',
      security: 'A vulnerability, CVE, exposure, abuse or excessive traffic, or an access concern',
      question: 'A question about how something works or how to do something',
      request: 'A request for a change, configuration or new work (not access)',
      access: 'Access: someone cannot sign in or lacks a permission, or asks to be given or removed from access to a tool, site, repository or channel',
      people: 'People on the project: a welcome or introduction, someone joining or leaving, time off, a handover or a farewell',
      meeting: 'A meeting, call or training session: scheduling, moving or cancelling it, or sharing its agenda, notes or recording',
      other: 'FYI, shared material, an announcement or social; nothing is asked',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this thread for Adobe?',
    criteria: [
      'Low: no time pressure',
      'Normal: should be handled within days',
      'High: should be handled today',
      'Critical: customer production impact right now',
    ],
  },
  resolved: {
    type: 'noul',
    instructions: 'Has the issue or request in this thread been resolved or closed? A ✅ or ✔️'
      + ' reaction by the customer (or a 👍 by the customer on the answer) confirms it is.',
  },
};

/** The Clef questions about a channel's tech stack (src/extract.js techFor). */
const techQuestions = (tech) => Object.fromEntries(tech.map((t) => [`tech.${t.tech}`, {
  type: 'noul',
  instructions: `Does this thread show that the customer uses ${t.description}?`,
}]));

/**
 * Clef on `state`: each group of questions asked in calls of its own, of at most MAX_QUESTIONS,
 * all at the same time; the answers of them all, as one answer. A group keeps the questions it is
 * asked with whatever the other groups have (Clef's answers move a little with the other
 * questions of a call).
 */
export async function askClef(env, state, ...groups) {
  const calls = [];
  for (const questions of groups) {
    const entries = Object.entries(questions);
    for (let i = 0; i < entries.length; i += MAX_QUESTIONS) {
      calls.push(env.AI.run(CLEF, {
        model: 'clef', state, questions: Object.fromEntries(entries.slice(i, i + MAX_QUESTIONS)),
      }));
    }
  }
  const all = await Promise.all(calls);
  return {
    model: (all[0] && all[0].model) || 'clef',
    answers: Object.assign({}, ...all.map((r) => (r && r.answers) || {})),
  };
}

const TOPIC_QUESTIONS = Object.fromEntries(Object.entries(TOPICS).map(([id, t]) => [`topic.${id}`, {
  type: 'noul',
  instructions: `Is this thread about ${t.what}?`,
}]));

/** The topics Clef is sure enough of, as `{ id: probability }`; null when there are none. */
export function topicsOf(answers) {
  const out = {};
  for (const id of Object.keys(TOPICS)) {
    const p = answers && answers[`topic.${id}`] ? answers[`topic.${id}`].noul : null;
    if (typeof p === 'number' && p >= TOPIC_MIN) {
      out[id] = Math.round(p * 1000) / 1000;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** `labels.topics` (JSON) as a list of topic ids, likeliest first. */
export function topicList(stored) {
  let parsed = null;
  try {
    parsed = stored ? JSON.parse(stored) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const ids = Object.entries(parsed).sort((x, y) => y[1] - x[1])
    .map(([id]) => (id in RETIRED_TOPICS ? RETIRED_TOPICS[id] : id)).filter(Boolean);
  return [...new Set(ids)];
}

/** The names the inbox shows for topic ids. */
export const topicNames = () => Object.fromEntries(Object.entries(TOPICS)
  .map(([id, t]) => [id, t.name]));

/** The names the inbox shows for tech stack and topic ids. */
export const vocab = async (env, team = null) => ({
  tech: await techNames(env, team), topics: topicNames(),
});

/**
 * Clairic's `products` field: the wording of the product census (docs/ARCHITECTURE.md, "Labels
 * and facts"), the fewest stray words of five at nearly the best recall. Clairic lists nearly
 * every name in the state, the header's and the authors' too, so productFacts reads its spans.
 */
export const PRODUCTS_INSTRUCTIONS = 'Names of software products, cloud services, platforms and'
  + ' developer tools that the customer uses or asks about, for example AEM Sites, Document'
  + ' Authoring, Cloudflare, Algolia or GitHub. Not the names of people, customers or the channel,'
  + ' and not generic words such as API, CDN, website or page.';
/**
 * At most this many products per thread, each at most MAX_PRODUCT characters, of them at most
 * MAX_GAPS the tech stack does not cover.
 */
export const MAX_PRODUCTS = 16;
export const MAX_GAPS = 6;
const MAX_PRODUCT = 60;

export const FIELDS = {
  problem: { type: 'text', instructions: "The customer's problem or request, in their own words" },
  affected_url: { type: 'text', instructions: 'URL of the affected page, site or environment' },
  error: { type: 'text', instructions: 'An error message, status code or failing behaviour quoted in the thread' },
  deadline: { type: 'date', instructions: 'Date by which the customer needs this answered or done' },
  go_live: { type: 'date', instructions: 'Planned go-live or launch date' },
  // What the thread is about, by name: the tech stack's vocabulary is a list someone wrote, and
  // the Topics page (src/topicmap.js) shows the names it does not have yet. One `product` fact
  // per name.
  products: {
    type: 'list',
    items: 'text',
    instructions: PRODUCTS_INSTRUCTIONS,
  },
};

function who(m) {
  const a = m.author || {};
  if (a.kind !== 'person') {
    return `${a.name || a.kind || 'bot'} (${a.kind || 'bot'})`;
  }
  return `${a.name || 'someone'} (${a.staff ? 'Adobe staff' : `customer${a.org ? `, ${a.org}` : ''}`})`;
}

// Reaction names as the models should see them (Slack names; Teams sends characters).
const REACTION_CHAR = {
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  eyes: '👀',
  pray: '🙏',
  ring_buoy: '🛟',
  rocket: '🚀',
  grinning: '😀',
  tada: '🎉',
  heart: '❤️',
  joy: '😂',
  like: '👍',
  laugh: '😂',
  sad: '😢',
  surprised: '😮',
  angry: '😠',
  x: '❌',
};
const reactionChar = (e) => {
  const name = String(e || '').replace(/::skin-tone-\d/, '');
  return REACTION_CHAR[name] || (/^\p{Extended_Pictographic}/u.test(name) ? name : `:${name}:`);
};

/** One line per message with reactions: who reacted with what (customer or Adobe). */
function reactionLine(list) {
  if (!list || !list.length) {
    return '';
  }
  return `\nReactions: ${list.map((r) => `${reactionChar(r.emoji)} by ${r.name || 'someone'}`
    + ` (${r.staff ? 'Adobe staff' : 'customer'})`).join(', ')}`;
}

/**
 * The thread as text for the models: a header, then one block per message, with the
 * reactions it got (`reactions`: message id → `{ emoji, name, staff }[]`).
 */
export function stateOf(thread, messages, reactions = new Map()) {
  const live = messages.filter((m) => !m.deletedAt);
  const shown = live.length > MAX_MESSAGES
    ? [live[0], ...live.slice(-(MAX_MESSAGES - 1))]
    : live;
  const header = [
    `Channel: ${thread.channel_name || thread.channel_id} on ${platformName(thread.source)}`,
    `Customer: ${thread.org}`,
    thread.root_at ? null : 'The first message of this thread is missing.',
  ].filter(Boolean).join('\n');
  const body = shown.map((m) => {
    const text = String(m.body || '').slice(0, MAX_BODY);
    return `[${m.at}] ${who(m)}:\n${text}${reactionLine(reactions.get(String(m.id)))}`;
  }).join('\n\n');
  return `${header}\n\n${body}`;
}

// The queue and the thread agents read threads through the folder snapshots too, but keep no
// files in memory: an agent's Durable Object has better uses for it than the inbox's cache.
const UNCACHED = fileCache(0);

export async function threadMessages(env, thread) {
  const files = await folderFiles(env.CHANNELS, thread.path, { cache: UNCACHED });
  return files.filter(Boolean).map(({ meta, body }) => ({ ...meta, body }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** The reactions in a thread, by message id, and the time of the latest one. */
async function threadReactions(env, key) {
  const { results } = await env.DB.prepare(`SELECT r.message, r.emoji, r.at,
      COALESCE(p.name, i.name) AS name, MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff, i.email
    FROM reactions r
    LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +r.user_key
    LEFT JOIN people p ON p.id = i.person
    WHERE r.thread = ? ORDER BY r.at`).bind(key).all();
  const by = new Map();
  let latest = null;
  for (const r of results || []) {
    const id = r.message.slice(r.message.lastIndexOf(':') + 1);
    by.set(id, [...(by.get(id) || []), {
      emoji: r.emoji, name: r.name, staff: Boolean(r.staff || isStaffDomain(env, r.email)),
    }]);
    latest = r.at && (!latest || r.at > latest) ? r.at : latest;
  }
  return { by, latest };
}

/**
 * Clairic answers worth keeping: non-null, above the confidence threshold. Not the products,
 * whose list has one confidence that says nothing (it shrinks as the list grows): productFacts.
 */
export function clairicFacts(answers) {
  const facts = [];
  for (const [field, a] of Object.entries(answers || {})) {
    const threshold = FIELD_CONFIDENCE[field] ?? MIN_CONFIDENCE;
    if (field !== 'products' && a && a.value !== null && a.value !== undefined && a.value !== ''
      && !Array.isArray(a.value) && (a.confidence === undefined || a.confidence >= threshold)) {
      facts.push({ field, value: String(a.value), confidence: a.confidence ?? null });
    }
  }
  return facts;
}

const PRODUCT_TRIM = /^[\s()[\]{}*?!,.:;"'`<>|/\\\-–—_=+~#$%&^•]+|[\s()[\]{}*?!,.:;"'`<>|/\\\-–—_=+~#$%&^•]+$/g;
/** An author line of the state: `[time] Name (Adobe staff):`, as stateOf writes it. */
const AUTHOR_LINE = /^\[[^\]\n]+\] ([^\n]*?) \((?:Adobe staff|customer[^)]*|[a-z]+)\):$/gm;

/**
 * The products Clairic named in a thread (its `products` list), as `product` facts: the names
 * its spans point at in the messages, not in the header (the channel, the platform, the
 * customer) or an author line (people and bots), trimmed, without the names of the thread's
 * people and its customer; of those, the names the tech stack (`tech`, as techFor has it) covers,
 * and those that look like the name of a product (src/products.js productLike), each once, at most
 * MAX_PRODUCTS. Clairic lists nearly every name in the state; this keeps two in five of them, and
 * nine in ten of the products a hand-made table of aliases finds (docs/ARCHITECTURE.md).
 */
export function productFacts(answer, state, thread = {}, tech = []) {
  const index = techIndex(tech);
  const text = String(state || '');
  // Clairic's spans count code points, as Python does; a string here counts UTF-16 units, one
  // more for every emoji. So the state is read as code points, and so are the places in it.
  const chars = Array.from(text);
  const at16 = (i) => Array.from(text.slice(0, i)).length;
  const header = Math.max(0, at16(text.indexOf('\n\n')));
  const authors = [...text.matchAll(AUTHOR_LINE)]
    .map((m) => [at16(m.index), at16(m.index) + Array.from(m[0]).length]);
  const inAuthor = (at) => authors.some(([from, to]) => at >= from && at < to);
  const names = new Set([...text.matchAll(AUTHOR_LINE)].flatMap((m) => [m[1], ...m[1].split(/\s+/)])
    .map((n) => n.toLowerCase()).filter((n) => n.length > 2));
  const org = String(thread.org || '').toLowerCase();
  [org, ...org.split(/[-_.]/)].filter((w) => w.length > 3).forEach((w) => names.add(w));
  // The customer as written in a message: "Acme Corp" for acme-corp.
  const squash = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const own = squash(org);
  const isOrg = (v) => own.length > 3 && (squash(v) === own || squash(v).startsWith(own));
  const spans = Array.isArray(answer?.spans) && answer.spans.length ? answer.spans : null;
  let items = Array.isArray(answer?.value) ? answer.value : [];
  if (spans) {
    // Not a mention of someone (`@Name`), nor a piece of a word: Clairic's spans now and then
    // start or end inside one ("zure Storage").
    const inWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
    items = spans.filter(([at, end]) => at >= header && !inAuthor(at) && chars[at - 1] !== '@'
      && !inWord(chars[at - 1]) && !inWord(chars[end]))
      .map(([at, end]) => chars.slice(at, end).join(''));
  }
  // A word written in lower case elsewhere in the thread ("Release" at the start of a sentence,
  // "release" in the next) is a word, not a name.
  const words = new Set(text.match(/\b\p{Ll}[\p{Ll}-]+\b/gu) || []);
  const aWord = (v) => /^\p{Lu}\p{Ll}+$/u.test(v) && words.has(v.toLowerCase());
  // A name the tech stack covers, once per entry (its first name); one it does not, by how often
  // the thread names it, then the first, at most MAX_GAPS of them.
  const covered = new Map();
  const others = new Map();
  items.forEach((item, i) => {
    const value = String(item ?? '').replace(/\s+/g, ' ').replace(PRODUCT_TRIM, '')
      .slice(0, MAX_PRODUCT);
    const key = value.toLowerCase();
    if (value.length < 2 || !/[a-z]/i.test(value) || value.includes('@') || names.has(key)
      || isOrg(value) || GENERIC.has(nameKey(value)) || GENERIC.has(key)) {
      return;
    }
    const entry = coveredBy(value, index);
    if (entry) {
      if (!covered.has(entry)) {
        covered.set(entry, value);
      }
    } else if (productLike(value) && !aWord(value)) {
      const k = productKey(value);
      const o = others.get(k) || { value, n: 0, i };
      o.n += 1;
      others.set(k, o);
    }
  });
  const gaps = [...others.values()].sort((x, y) => y.n - x.n || x.i - y.i).slice(0, MAX_GAPS);
  const facts = [...covered.values(), ...gaps.map((g) => g.value)].slice(0, MAX_PRODUCTS)
    .map((value) => ({ field: 'product', value, confidence: null }));
  return facts;
}

/**
 * What the inbox already shows next to a title, so the title should not repeat it: the
 * customer, the channel and the platform, the kind of thread (as an emoji), and the product
 * that every thread is about.
 */
function omit(thread) {
  const customer = thread?.org && !thread.org.startsWith('_') ? ` (${thread.org})` : '';
  return 'The title is shown next to the customer, the channel, the platform and the kind of'
    + ' thread, so do not repeat them: do not name the customer'
    + `${customer} or its brands, the channel, Slack, Microsoft Teams or Adobe, and do not name`
    + ' Edge Delivery Services (EDS, AEM, aem.live, helix, Franklin), which every thread is'
    + ' about. Name another product only when it is the topic (for example Akamai or Universal'
    + ' Editor). Leave out filler words such as support, help, issue, inquiry, question,'
    + ' request, discussion or thread. For example, not "Acme EDS Sidekick Login Support"'
    + ' but "Sidekick login fails after SSO change".';
}

// The product every thread is about, as a word in a title (not inside a host name).
const PRODUCT = String.raw`Adobe\s+Edge\s+Delivery(?:\s+Services)?|Edge\s+Delivery(?:\s+Services)?|EDS`;
const LOOSE = /^(?:in|on|for|with|and|of|at|-|–|—|:)$/i;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes what the model was told to leave out but still wrote: the customer and the
 * product as words of their own, and the connecting words they leave dangling at either
 * end. Returns null when nothing is left.
 */
export function tidyTitle(title, thread) {
  const names = [PRODUCT];
  if (thread?.org && !thread.org.startsWith('_')) {
    names.push(thread.org.split(/[-_\s]+/).map(escape).join(String.raw`[-_\s]*`));
  }
  const words = String(title || '')
    .replace(new RegExp(String.raw`(?<![\w.@/-])(?:${names.join('|')})(?:'s)?(?![\w@/-]|\.\w)`, 'gi'), ' ')
    .split(/\s+/).filter(Boolean);
  while (words.length && LOOSE.test(words[0])) {
    words.shift();
  }
  while (words.length && LOOSE.test(words[words.length - 1])) {
    words.pop();
  }
  const out = words.join(' ');
  return out ? out[0].toUpperCase() + out.slice(1) : null;
}

/**
 * A short title by a language model: the specific failure, or the topic, without what the
 * inbox already shows next to it.
 */
/**
 * What the model writes when it found nothing to name ("None", "No title available", "Invalid
 * title, please provide …"): no title, so the inbox shows the thread's first words instead.
 */
const NO_TITLE = /^(?:none|null|n\/a|untitled|no title\b.*|no (?:specific )?(?:topic|information|issue|discussion)\b.*|invalid title\b.*|(?:general )?inquiry)$/i;
export const isTitle = (t) => Boolean(t) && !NO_TITLE.test(String(t).trim());

export async function writeTitle(env, state, alert, thread) {
  const instructions = [
    alert
      ? 'Name the specific failure in this alert in at most 8 words: the error or failing request, and what fails.'
      : 'Write a title of at most 8 words that says what this support thread is about: the specific feature, error, page, task or question.',
    omit(thread),
    'Reply with the title only, no quotes.',
  ].join(' ');
  const res = await env.AI.run(TITLER, {
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: state.slice(0, 6000) }],
    max_tokens: 40,
  });
  const text = String((res && (res.response || res.choices?.[0]?.message?.content)) || '')
    .split('\n')[0].replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').trim();
  const title = tidyTitle(text, thread) || text;
  return isTitle(title) ? title.slice(0, MAX_TITLE) : null;
}

/**
 * The channel's technologies, from Clef's answers about `tech` and what the rules `detected`
 * (as sure as can be): each keeps the highest probability any thread showed.
 */
async function recordTech(env, thread, tech, answers, detected = []) {
  for (const id of tech.map((t) => t.tech)) {
    const p = detected.includes(id) ? 1 : answers[`tech.${id}`]?.noul;
    if (typeof p === 'number' && p >= TECH_MIN) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`INSERT INTO channel_tech (source, tenant, channel_id, tech, p, thread, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, tenant, channel_id, tech) DO UPDATE SET
          p = MAX(channel_tech.p, excluded.p),
          thread = CASE WHEN excluded.p > channel_tech.p THEN excluded.thread ELSE channel_tech.thread END,
          updated_at = excluded.updated_at`)
        .bind(
          thread.source,
          thread.tenant,
          thread.channel_id,
          id,
          p,
          thread.thread,
          new Date().toISOString(),
        )
        .run();
    }
  }
}

async function replaceFacts(db, thread, source, facts) {
  await db.prepare('DELETE FROM facts WHERE thread = ? AND source = ?').bind(thread, source).run();
  for (const f of facts) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare(`INSERT OR IGNORE INTO facts (thread, source, field, value, confidence)
      VALUES (?, ?, ?, ?, ?)`).bind(thread, source, f.field, f.value, f.confidence ?? null).run();
  }
}

/**
 * An alert is a bot post: nobody is waiting, so there is nothing for Clef to decide. The
 * group's first thread gets a title that names the specific failure, once.
 */
async function labelAlert(env, thread, now) {
  const anchorKey = thread.logical_thread || thread.thread;
  const anchor = anchorKey === thread.thread ? thread
    : await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(anchorKey).first();
  const done = await env.DB.prepare('SELECT title FROM labels WHERE thread = ?').bind(anchorKey).first();
  if (!anchor || (done && done.title)) {
    return { result: 'unchanged' };
  }
  const messages = await threadMessages(env, anchor);
  if (!messages.length) {
    return { result: 'skip', reason: 'no messages' };
  }
  const found = await extract(env, await rulesFor(env, anchor.team), anchor, messages);
  await replaceFacts(env.DB, anchorKey, 'rule', found.facts);
  const title = await writeTitle(env, stateOf(anchor, messages), true, anchor);
  await env.DB.prepare(`INSERT INTO labels (thread, kind, kind_p, labeled_through, model, labeled_at, title)
    VALUES (?, 'alert', 1, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET title = excluded.title, labeled_at = excluded.labeled_at`)
    .bind(anchorKey, anchor.any_at || now.toISOString(), TITLER, now.toISOString(), title).run();
  return { result: 'titled', title: Boolean(title) };
}

const LABEL_SWEEP_AFTER_MS = 60 * 60 * 1000;
const LABEL_SWEEP_DAYS = 14;
const LABEL_SWEEP_LIMIT = 50;

/**
 * Labels one thread. Skips threads that have not changed since they were last labeled,
 * and alert threads (their kind is known and nobody is waiting).
 */
export async function labelThread(env, key, now = new Date()) {
  const thread = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(key).first();
  if (!thread) {
    return { result: 'missing' };
  }
  if (thread.kind === 'alert') {
    return labelAlert(env, thread, now);
  }
  if (thread.kind !== 'channel') {
    return { result: 'skip', reason: thread.kind };
  }
  if (!thread.last_at) {
    // Only system events or bots (a member joined, an app was added): nothing to label.
    return { result: 'skip', reason: 'no person posted' };
  }
  // Labeled through the latest message or reaction: a reaction is news for the models too.
  const rx = await threadReactions(env, key);
  const through = rx.latest && rx.latest > thread.any_at ? rx.latest : thread.any_at;
  const done = await env.DB.prepare('SELECT labeled_through FROM labels WHERE thread = ?')
    .bind(key).first();
  if (done && done.labeled_through === through) {
    return { result: 'unchanged' };
  }
  const messages = await threadMessages(env, thread);
  if (!messages.length) {
    // Even a deleted message leaves a file, so these are missing. Not a label: `labeled_through`
    // says that Clef has read the thread (src/resolve.js, src/review.js). As a dead job it shows in
    // `/diag/dead`, and the sweep leaves the thread alone for a day.
    await recordDead(env, `label:${key}`, { label: key }, 'no messages');
    return { result: 'skip', reason: 'no messages' };
  }

  const [rules, tech] = await Promise.all([rulesFor(env, thread.team), techFor(env, thread.team)]);
  const found = await extract(env, rules, thread, messages);
  await replaceFacts(env.DB, key, 'rule', found.facts);

  const state = stateOf(thread, messages, rx.by);
  const [clef, clairic, title] = await Promise.all([
    // The topics on their own, so the tech stack's entries do not move their answers.
    askClef(env, state, { ...QUESTIONS, ...TOPIC_QUESTIONS }, techQuestions(tech)),
    env.AI.run(CLAIRIC, {
      model: 'clairic', state, fields: FIELDS, reference_date: now.toISOString().slice(0, 10),
    }),
    writeTitle(env, state, false, thread).catch(() => null),
  ]);
  const a = clef.answers || {};
  const choice = (q) => {
    if (!a[q]) {
      return [null, null];
    }
    return [a[q].choice, a[q].probabilities?.[a[q].choice] ?? a[q].confidence];
  };
  const [nextActor, nextActorP] = choice('next_actor');
  const [kind, kindP] = choice('kind');
  const topics = topicsOf(a);
  await env.DB.prepare(`INSERT INTO labels (thread, next_actor, next_actor_p, kind, kind_p,
      urgency, resolved_p, labeled_through, model, labeled_at, title, topics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET next_actor = excluded.next_actor,
      next_actor_p = excluded.next_actor_p, kind = excluded.kind, kind_p = excluded.kind_p,
      urgency = excluded.urgency, resolved_p = excluded.resolved_p, topics = excluded.topics,
      labeled_through = excluded.labeled_through, model = excluded.model,
      labeled_at = excluded.labeled_at, title = COALESCE(excluded.title, labels.title)`)
    .bind(
      key,
      nextActor,
      nextActorP,
      kind,
      kindP,
      a.urgency ? a.urgency.score : null,
      a.resolved ? a.resolved.noul : null,
      through,
      `${clef.model || 'clef'}+${clairic.model || 'clairic'}`,
      now.toISOString(),
      title,
      topics ? JSON.stringify(topics) : null,
    )
    .run();
  await recordTech(env, thread, tech, a, found.tech);
  const loose = [...clairicFacts(clairic.answers),
    ...productFacts(clairic.answers?.products, state, thread, tech)];
  await replaceFacts(env.DB, key, 'clairic', loose);
  return {
    result: 'labeled',
    next_actor: nextActor,
    kind,
    topics: topics ? Object.keys(topics) : [],
    facts: loose.length,
    title: Boolean(title),
  };
}

/**
 * Cron: the threads a person posted in since their label, and quiet for longer than a label job
 * and its retries take: the job died. Recent ones only: nobody looks at the older ones' labels.
 * A thread whose job died within the day waits, so that one that always fails goes out once a day.
 */
export async function sweepLabels(env, now = new Date()) {
  if (!env.AI || !env.NORMALIZE) {
    return { skipped: 'no AI binding' };
  }
  if (!sweepsNow(now)) {
    return { skipped: 'not this run' };
  }
  const { results } = await env.DB.prepare(`SELECT t.thread FROM threads t
    LEFT JOIN labels l ON l.thread = t.thread
    WHERE t.kind = 'channel' AND t.last_at >= ? AND t.last_at < ?
      AND (l.thread IS NULL OR l.labeled_through < t.last_at)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.thread = t.thread AND m.deleted = 0)
      AND NOT EXISTS (SELECT 1 FROM dead_jobs d WHERE d.job = 'label:' || t.thread AND d.at > ?)
    ORDER BY t.last_at DESC LIMIT ?`)
    .bind(
      new Date(now.getTime() - LABEL_SWEEP_DAYS * 86400 * 1000).toISOString(),
      new Date(now.getTime() - LABEL_SWEEP_AFTER_MS).toISOString(),
      new Date(now.getTime() - 86400 * 1000).toISOString(),
      LABEL_SWEEP_LIMIT,
    ).all();
  for (const [i, { thread }] of (results || []).entries()) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.send({ label: thread }, sweepDelay(i));
  }
  return { queued: (results || []).length };
}
