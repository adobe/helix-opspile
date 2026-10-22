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

import { parse } from './channels.js';
import { ruleFacts } from './facts.js';
import { isStaffDomain } from './lookup.js';

/**
 * Thread labels (Clef, a decision model) and facts (rules, plus Clairic, an extraction
 * model, above a confidence threshold). A thread is labeled shortly after it changes;
 * `labeled_through` makes a relabel of an unchanged thread a no-op.
 */

export const CLEF = '@cf/cloudflare/clef';
export const CLAIRIC = '@cf/cloudflare/clairic';
export const TITLER = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_TITLE = 90;

/**
 * Technologies worth knowing at a glance for a customer. Each is one Clef yes/no
 * question; the channel keeps the highest probability any thread showed.
 */
export const TECH = {
  eds: 'Adobe Edge Delivery Services (aem.live, aem.page, helix, Franklin)',
  da: 'Document Authoring (da.live)',
  ue: 'Universal Editor',
  sharepoint: 'SharePoint or OneDrive as the content source',
  gdrive: 'Google Drive or Google Docs as the content source',
  aemcs: 'AEM as a Cloud Service (author or publish tier, Cloud Manager)',
  assets: 'AEM Assets or Dynamic Media',
  forms: 'AEM Forms',
  commerce: 'Adobe Commerce (Magento) or Commerce drop-ins',
  cloudflare: 'Cloudflare as CDN',
  akamai: 'Akamai as CDN',
  fastly: 'Fastly as CDN',
  cloudfront: 'Amazon CloudFront as CDN',
  github: 'GitHub for code',
  bitbucket: 'Bitbucket, GitLab or Cloud Manager git for code',
  target: 'Adobe Target or personalization',
  analytics: 'Adobe Analytics, Web SDK or Experience Platform data collection',
};
export const TECH_MIN = 0.8;
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
      access: 'Onboarding or access: adding or removing people, invitations, channel or team setup, welcome messages, or permissions to a tool or repository',
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

const TECH_QUESTIONS = Object.fromEntries(Object.entries(TECH).map(([id, what]) => [`tech.${id}`, {
  type: 'noul',
  instructions: `Does this thread show that the customer uses ${what}?`,
}]));

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
    `Channel: ${thread.channel_name || thread.channel_id} on ${thread.source === 'slack' ? 'Slack' : 'Microsoft Teams'}`,
    `Customer: ${thread.org}`,
    thread.root_at ? null : 'The first message of this thread is missing.',
  ].filter(Boolean).join('\n');
  const body = shown.map((m) => {
    const text = String(m.body || '').slice(0, MAX_BODY);
    return `[${m.at}] ${who(m)}:\n${text}${reactionLine(reactions.get(String(m.id)))}`;
  }).join('\n\n');
  return `${header}\n\n${body}`;
}

export async function threadMessages(env, thread) {
  const listed = await env.CHANNELS.list({ prefix: thread.path });
  const files = await Promise.all(listed.objects.map(async (o) => {
    const obj = await env.CHANNELS.get(o.key);
    return obj ? parse(await obj.text()) : null;
  }));
  return files.filter(Boolean).map(({ meta, body }) => ({ ...meta, body }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** The reactions in a thread, by message id, and the time of the latest one. */
async function threadReactions(env, key) {
  const { results } = await env.DB.prepare(`SELECT r.message, r.emoji, r.at,
      COALESCE(p.name, i.name) AS name, COALESCE(p.staff, 0) AS staff, i.email
    FROM reactions r
    LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = r.user_key
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

/** Clairic answers worth keeping: non-null, above the confidence threshold. */
export function clairicFacts(answers) {
  const facts = [];
  for (const [field, a] of Object.entries(answers || {})) {
    const threshold = FIELD_CONFIDENCE[field] ?? MIN_CONFIDENCE;
    if (a && a.value !== null && a.value !== undefined && a.value !== ''
      && (a.confidence === undefined || a.confidence >= threshold)) {
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
  return title ? title.slice(0, MAX_TITLE) : null;
}

async function recordTech(env, thread, answers) {
  for (const id of Object.keys(TECH)) {
    const p = answers[`tech.${id}`]?.noul;
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
  await replaceFacts(env.DB, anchorKey, 'rule', ruleFacts(messages.map((m) => m.body || '')));
  const title = await writeTitle(env, stateOf(anchor, messages), true, anchor);
  await env.DB.prepare(`INSERT INTO labels (thread, kind, kind_p, labeled_through, model, labeled_at, title)
    VALUES (?, 'alert', 1, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET title = excluded.title, labeled_at = excluded.labeled_at`)
    .bind(anchorKey, anchor.any_at || now.toISOString(), TITLER, now.toISOString(), title).run();
  return { result: 'titled', title: Boolean(title) };
}

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
    return { result: 'skip', reason: 'no messages' };
  }

  await replaceFacts(env.DB, key, 'rule', ruleFacts(messages.map((m) => m.body || '')));

  const state = stateOf(thread, messages, rx.by);
  const [clef, clairic, title] = await Promise.all([
    env.AI.run(CLEF, { model: 'clef', state, questions: { ...QUESTIONS, ...TECH_QUESTIONS } }),
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
  await env.DB.prepare(`INSERT INTO labels (thread, next_actor, next_actor_p, kind, kind_p,
      urgency, resolved_p, labeled_through, model, labeled_at, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET next_actor = excluded.next_actor,
      next_actor_p = excluded.next_actor_p, kind = excluded.kind, kind_p = excluded.kind_p,
      urgency = excluded.urgency, resolved_p = excluded.resolved_p,
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
    )
    .run();
  await recordTech(env, thread, a);
  const loose = clairicFacts(clairic.answers);
  await replaceFacts(env.DB, key, 'clairic', loose);
  return {
    result: 'labeled', next_actor: nextActor, kind, facts: loose.length, title: Boolean(title),
  };
}
