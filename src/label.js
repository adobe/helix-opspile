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
  extract, rulesFor, techFor, techLayerMap, techNames,
} from './extract.js';
import { isStaffDomain } from './lookup.js';
import { LAYERS } from './stack.js';
import { threadAreaStatements, threadTechStatements } from './follows.js';
import { resolveTech, techMoves } from './catalog.js';
import { questionKeys } from './techid.js';
import { areaNames, areasFor } from './areas.js';

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

/** At or above this, a thread shows a technology (thread_tech); a rule's detection is 1. */
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

/**
 * The Clef questions about a channel's tech stack (src/extract.js techFor), each by the hash of
 * its id (src/techid.js `questionKeys`): a catalog path is no key. `techOf` maps them back.
 */
export const techQuestions = (tech) => {
  const keys = questionKeys(tech.map((t) => t.tech));
  return Object.fromEntries(tech.map((t) => [`tech.${keys[t.tech]}`, {
    type: 'noul',
    instructions: `Does this thread show that the customer uses ${t.description}?`,
  }]));
};

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

/** TOPICS as areas (src/areas.js): what Clef asks until a team has written any. */
export const BUILT_IN_AREAS = Object.entries(TOPICS)
  .map(([id, t]) => ({ id, name: t.name, what: t.what }));

/**
 * The areas Clef asks about (src/areas.js `areasFor`): the teams', in the order the built-in ones
 * were measured in, those added after them; the built-in ones until a team has written any.
 */
export const areasToAsk = (env) => areasFor(env, {
  order: Object.keys(TOPICS), fallback: BUILT_IN_AREAS,
});

/** The Clef questions of `areas`, one per area: "Is this thread about <what>?". */
export const areaQuestions = (areas) => Object.fromEntries(areas.map((t) => [`topic.${t.id}`, {
  type: 'noul',
  instructions: `Is this thread about ${t.what}?`,
}]));

/**
 * The areas (topics) Clef is sure enough of, of `areas` (the built-in ones by default), as
 * `{ id: probability }`; null when there are none.
 */
export function topicsOf(answers, areas = BUILT_IN_AREAS) {
  const out = {};
  for (const id of areas.map((a) => a.id)) {
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

/** The names the inbox shows for the built-in areas' ids. */
export const topicNames = () => Object.fromEntries(Object.entries(TOPICS)
  .map(([id, t]) => [id, t.name]));

/** The names the inbox shows for area ids: every team's (src/areas.js), else the built-in ones. */
export const areaNamesOf = (env) => areaNames(env, topicNames());

/**
 * The names the inbox shows for tech stack and topic ids, the layer of the stack each
 * technology is in (`layers`), and the layers, top to bottom (`stack`, src/stack.js).
 */
export const vocab = async (env, team = null) => {
  const [tech, layers, topics] = await Promise.all([
    techNames(env, team), techLayerMap(env, team), areaNamesOf(env),
  ]);
  return {
    tech, topics, layers, stack: LAYERS.map(({ id, name }) => ({ id, name })),
  };
};

export const FIELDS = {
  problem: { type: 'text', instructions: "The customer's problem or request, in their own words" },
  affected_url: { type: 'text', instructions: 'URL of the affected page, site or environment' },
  error: { type: 'text', instructions: 'An error message, status code or failing behaviour quoted in the thread' },
  deadline: { type: 'date', instructions: 'Date by which the customer needs this answered or done' },
  go_live: { type: 'date', instructions: 'Planned go-live or launch date' },
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
 * Clairic answers worth keeping: non-null, above the confidence threshold, one value each (a
 * list, which Clairic is no longer asked for, is not kept).
 */
export function clairicFacts(answers) {
  const facts = [];
  for (const [field, a] of Object.entries(answers || {})) {
    const threshold = FIELD_CONFIDENCE[field] ?? MIN_CONFIDENCE;
    if (a && a.value !== null && a.value !== undefined && a.value !== ''
      && !Array.isArray(a.value) && (a.confidence === undefined || a.confidence >= threshold)) {
      facts.push({ field, value: String(a.value), confidence: a.confidence ?? null });
    }
  }
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
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What the model was told to leave out of a title but still wrote: the customer and the
 * product, as words of their own, in the order the title names them.
 */
export function namedIn(title, thread) {
  const names = [PRODUCT];
  if (thread?.org && !thread.org.startsWith('_')) {
    names.push(thread.org.split(/[-_\s]+/).map(escape).join(String.raw`[-_\s]*`));
  }
  const re = new RegExp(String.raw`(?<![\w.@/-])(?:${names.join('|')})(?:'s)?(?![\w@/-]|\.\w)`, 'gi');
  return [...new Set(String(title || '').match(re) || [])];
}

/**
 * What the model writes when it found nothing to name ("None", "No title available", "Invalid
 * title, please provide …"): no title, so the inbox shows the thread's first words instead.
 */
const NO_TITLE = /^(?:none|null|n\/a|untitled|no title\b.*|no (?:specific )?(?:topic|information|issue|discussion)\b.*|invalid title\b.*|(?:general )?inquiry)$/i;

// What no title, name or sentence has: the replacement character (bytes that were no text),
// half a surrogate pair, private-use and control characters, and the marks of a model's special
// tokens. Full-width forms belong to Chinese, Japanese and Korean text, and to no other.
const MANGLED = /[\uFFFD\u2581\p{Co}\p{Cs}]|(?![\t\n\r])\p{Cc}|<\||\|>/u;
const FULL_WIDTH = /[\uFF01-\uFF5E]/;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Whether `text` has characters that only an inference gone wrong writes. */
export function mangled(text) {
  const s = String(text ?? '');
  return MANGLED.test(s) || (FULL_WIDTH.test(s) && !CJK.test(s));
}

/**
 * Whether a title or a name is what a model writes when its inference went wrong, not its
 * answer: tokens of no language ("Kaufpeater\uFFFDadierstash partic404 Kauf Rear Kauf Kauf\uFF5C",
 * once in production, for a thread the same model titles well every other time). It is mangled,
 * or says one word of four letters or more three times, which no title of eight words does.
 */
export function garbled(text) {
  if (mangled(text)) {
    return true;
  }
  const seen = new Map();
  for (const w of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []) {
    seen.set(w, (seen.get(w) || 0) + 1);
    if (seen.get(w) > 2) {
      return true;
    }
  }
  return false;
}

export const isTitle = (t) => Boolean(t) && !NO_TITLE.test(String(t).trim()) && !garbled(t);

const firstLine = (res) => String((res && (res.response || res.choices?.[0]?.message?.content)) || '')
  .split('\n')[0].replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').trim();

// A title takes about ten tokens. An answer that did not end within these is not one.
const TITLE_TOKENS = 40;
const cutOff = (res) => res?.choices?.[0]?.finish_reason === 'length'
  || Number(res?.usage?.completion_tokens) >= TITLE_TOKENS;

/**
 * The model's answer to `messages`, its first line. One that is garbled or was cut off is the
 * inference's fault, not the thread's (asked again, the model answers as ever), so it is asked
 * for once more; '' when that is no better. The log counts them (`route: 'title'`).
 */
async function titleBy(env, messages, thread) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await env.AI.run(TITLER, { messages, max_tokens: TITLE_TOKENS });
    const title = firstLine(res);
    const dropped = (garbled(title) && 'garbled') || (cutOff(res) && 'cut off');
    if (!dropped) {
      return title;
    }
    console.log(JSON.stringify({
      route: 'title', thread: thread?.thread, dropped, attempt,
    }));
  }
  return '';
}

/**
 * A short title by a language model: the specific failure, or the topic, without what the
 * inbox already shows next to it. A title that still names the customer or the product is
 * asked for once more, with the names it should leave out; it is never cut up, because what
 * is left of a sentence without its subject ("Headless options in without App Builder")
 * reads worse than the name. An answer that is no language is asked for once more, and is no
 * title when that is no better: the thread keeps the title it had, or shows its first words.
 */
export async function writeTitle(env, state, alert, thread) {
  const instructions = [
    alert
      ? 'Name the specific failure in this alert in at most 8 words: the error or failing request, and what fails.'
      : 'Write a title of at most 8 words that says what this support thread is about: the specific feature, error, page, task or question.',
    omit(thread),
    'Reply with the title only, no quotes.',
  ].join(' ');
  const messages = [
    { role: 'system', content: instructions },
    { role: 'user', content: state.slice(0, 6000) },
  ];
  let title = await titleBy(env, messages, thread);
  const named = isTitle(title) ? namedIn(title, thread) : [];
  if (named.length) {
    const again = await titleBy(env, [...messages, { role: 'assistant', content: title }, {
      role: 'user',
      content: `The inbox shows ${named.map((n) => `"${n}"`).join(' and ')} next to the title already.`
        + ' Write the title again without naming it, as a whole phrase that says the same.'
        + ' Reply with the title only, no quotes.',
    }], thread).catch(() => '');
    if (isTitle(again)) {
      title = again;
    }
  }
  return isTitle(title) ? title.slice(0, MAX_TITLE) : null;
}

/**
 * The Clef questions whether the thread is about each of `tech` (those it showed), by the hash
 * of the id, as `techQuestions`; `aboutOf` maps them back.
 */
export const aboutQuestions = (tech) => {
  const keys = questionKeys(tech.map((t) => t.tech));
  return Object.fromEntries(tech.map((t) => [`about.${keys[t.tech]}`, {
    type: 'noul',
    instructions: `Is this thread about ${t.description}: is that what the question, the problem or the work in it concerns, not only something it mentions?`,
  }]));
};

/** What the thread is about, of `tech`, as `{ id: probability }` at or above TECH_MIN. */
export function aboutOf(tech, answers) {
  const out = {};
  const keys = questionKeys(tech.map((t) => t.tech));
  for (const { tech: id } of tech) {
    const p = answers && answers[`about.${keys[id]}`]?.noul;
    if (typeof p === 'number' && p >= TECH_MIN) {
      out[id] = Math.round(p * 1000) / 1000;
    }
  }
  return out;
}

/**
 * The technologies a thread shows, as `{ id: probability }`: Clef's answers about `tech` at or
 * above TECH_MIN, and what the rules `detected` (as sure as can be, 1).
 */
export function techOf(tech, answers, detected = []) {
  const out = {};
  const keys = questionKeys(tech.map((t) => t.tech));
  for (const id of tech.map((t) => t.tech)) {
    const p = detected.includes(id) ? 1 : answers && answers[`tech.${keys[id]}`]?.noul;
    if (typeof p === 'number' && p >= TECH_MIN) {
      out[id] = Math.round(p * 1000) / 1000;
    }
  }
  return out;
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

/**
 * `POST /api/admin/relabel`: the channel threads with a label and at least `minMessages`
 * messages, by key after `after`, `limit` of them, each queued to be labeled again though it
 * did not change (`force`), five seconds apart. `{ queued, next }`: `next` is the `after` of
 * the next batch, or null when there are no more.
 */
export async function queueRelabel(env, {
  after = '', limit = 100, minMessages = 3, threads = null,
} = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  // `threads`: these, of the labeled channel threads (those a relabel left behind, say).
  const only = Array.isArray(threads) ? JSON.stringify(threads.map(String).slice(0, 500)) : null;
  const { results } = await env.DB.prepare(`SELECT t.thread FROM threads t
    JOIN labels l ON l.thread = t.thread
    WHERE t.kind = 'channel' AND t.messages >= ?1 AND t.thread > ?2
      AND (?4 IS NULL OR t.thread IN (SELECT value FROM json_each(?4)))
    ORDER BY t.thread LIMIT ?3`).bind(Math.max(Number(minMessages) || 1, 1), String(after || ''), n, only).all();
  const keys = (results || []).map((r) => r.thread);
  for (const [i, thread] of keys.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.send({ label: thread, force: true }, sweepDelay(i));
  }
  return { queued: keys.length, next: keys.length === n ? keys[keys.length - 1] : null };
}

const LABEL_SWEEP_AFTER_MS = 60 * 60 * 1000;
const LABEL_SWEEP_DAYS = 14;
const LABEL_SWEEP_LIMIT = 50;

/**
 * Labels one thread. Skips threads that have not changed since they were last labeled,
 * and alert threads (their kind is known and nobody is waiting).
 */
export async function labelThread(env, key, now = new Date(), { force = false } = {}) {
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
  // `force`: asked again though nothing changed (`POST /api/admin/relabel`: new questions, a
  // new catalog).
  if (done && done.labeled_through === through && !force) {
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

  const [rules, tech, moves, areas] = await Promise.all([
    rulesFor(env, thread.team), techFor(env, thread.team), techMoves(env), areasToAsk(env),
  ]);
  const found = await extract(env, rules, thread, messages);
  // A script may still detect a technology by an id it had (src/catalog.js).
  found.tech = [...new Set(found.tech.map((id) => resolveTech(id, moves)))];
  await replaceFacts(env.DB, key, 'rule', found.facts);

  const state = stateOf(thread, messages, rx.by);
  const [clef, clairic, title] = await Promise.all([
    // The topics on their own, so the tech stack's entries do not move their answers.
    askClef(env, state, { ...QUESTIONS, ...areaQuestions(areas) }, techQuestions(tech)),
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
  const topics = topicsOf(a, areas);
  const shown = techOf(tech, a, found.tech);
  // Of what it shows, what it is about: a second call, only for those (src/label.js aboutOf).
  const asked = tech.filter((t) => shown[t.tech] !== undefined);
  // A call that failed is no answer: `about` stays NULL ("not asked"), not `{}` ("about none").
  let about = {};
  if (asked.length) {
    try {
      about = aboutOf(asked, (await askClef(env, state, aboutQuestions(asked))).answers);
    } catch (e) {
      about = null;
      console.error(JSON.stringify({
        route: 'label', thread: key, about: 'failed', error: e.message,
      }));
    }
  }
  // What it showed before, for the inboxes that follow what it shows or showed (src/follows.js).
  const [{ results: before }, { results: areasBefore }] = await Promise.all([
    env.DB.prepare('SELECT tech FROM thread_tech WHERE thread = ?').bind(key).all(),
    env.DB.prepare('SELECT area FROM thread_areas WHERE thread = ?').bind(key).all(),
  ]);
  const label = env.DB.prepare(`INSERT INTO labels (thread, next_actor, next_actor_p, kind, kind_p,
      urgency, resolved_p, labeled_through, model, labeled_at, title, topics, tech, about)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET next_actor = excluded.next_actor,
      next_actor_p = excluded.next_actor_p, kind = excluded.kind, kind_p = excluded.kind_p,
      urgency = excluded.urgency, resolved_p = excluded.resolved_p, topics = excluded.topics,
      tech = excluded.tech, about = excluded.about,
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
      JSON.stringify(shown),
      about ? JSON.stringify(about) : null,
    );
  // The label and what the thread shows by index (`thread_tech`) at once.
  await env.DB.batch([label, ...threadTechStatements(env.DB, key, shown, about || {}),
    ...threadAreaStatements(env.DB, key, topics)]);
  const was = (before || []).map((r) => r.tech).sort();
  const is = Object.keys(shown).sort();
  const hadAreas = (areasBefore || []).map((r) => r.area).sort();
  const hasAreas = Object.keys(topics || {}).sort();
  const loose = clairicFacts(clairic.answers);
  await replaceFacts(env.DB, key, 'clairic', loose);
  return {
    result: 'labeled',
    next_actor: nextActor,
    kind,
    topics: topics ? Object.keys(topics) : [],
    facts: loose.length,
    title: Boolean(title),
    // What it shows, when that changed: the inboxes that follow a technology it gained or lost
    // list it again (src/normalizer.js).
    ...(was.join() !== is.join() ? {
      tech: {
        gained: is.filter((t) => !was.includes(t)), lost: was.filter((t) => !is.includes(t)),
      },
    } : {}),
    // And the areas it is in: those who follow one that it joined or left hear of it too.
    ...(hadAreas.join() !== hasAreas.join() ? {
      areas: {
        gained: hasAreas.filter((t) => !hadAreas.includes(t)),
        lost: hadAreas.filter((t) => !hasAreas.includes(t)),
      },
    } : {}),
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
