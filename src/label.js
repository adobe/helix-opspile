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

/**
 * Thread labels (Clef, a decision model) and facts (rules, plus Clairic, an extraction
 * model, above a confidence threshold). A thread is labeled shortly after it changes;
 * `labeled_through` makes a relabel of an unchanged thread a no-op.
 */

export const CLEF = '@cf/cloudflare/clef';
export const CLAIRIC = '@cf/cloudflare/clairic';
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
      security: 'A vulnerability, CVE, exposure, abuse or access concern',
      question: 'A question about how something works or how to do something',
      request: 'A request for a change, access, configuration, or new work',
      alert: 'An automated alert or monitoring notification',
      other: 'An announcement, coordination, social chatter or anything else',
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
    instructions: 'Has the issue or request in this thread been resolved or closed?',
  },
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

/** The thread as text for the models: a header, then one block per message. */
export function stateOf(thread, messages) {
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
    return `[${m.at}] ${who(m)}:\n${text}`;
  }).join('\n\n');
  return `${header}\n\n${body}`;
}

async function threadMessages(env, thread) {
  const listed = await env.CHANNELS.list({ prefix: thread.path });
  const files = await Promise.all(listed.objects.map(async (o) => {
    const obj = await env.CHANNELS.get(o.key);
    return obj ? parse(await obj.text()) : null;
  }));
  return files.filter(Boolean).map(({ meta, body }) => ({ ...meta, body }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
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

async function replaceFacts(db, thread, source, facts) {
  await db.prepare('DELETE FROM facts WHERE thread = ? AND source = ?').bind(thread, source).run();
  for (const f of facts) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare(`INSERT OR IGNORE INTO facts (thread, source, field, value, confidence)
      VALUES (?, ?, ?, ?, ?)`).bind(thread, source, f.field, f.value, f.confidence ?? null).run();
  }
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
  if (thread.kind !== 'channel') {
    return { result: 'skip', reason: thread.kind };
  }
  const done = await env.DB.prepare('SELECT labeled_through FROM labels WHERE thread = ?')
    .bind(key).first();
  if (done && done.labeled_through === thread.any_at) {
    return { result: 'unchanged' };
  }
  const messages = await threadMessages(env, thread);
  if (!messages.length) {
    return { result: 'skip', reason: 'no messages' };
  }

  await replaceFacts(env.DB, key, 'rule', ruleFacts(messages.map((m) => m.body || '')));

  const state = stateOf(thread, messages);
  const [clef, clairic] = await Promise.all([
    env.AI.run(CLEF, { model: 'clef', state, questions: QUESTIONS }),
    env.AI.run(CLAIRIC, {
      model: 'clairic', state, fields: FIELDS, reference_date: now.toISOString().slice(0, 10),
    }),
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
      urgency, resolved_p, labeled_through, model, labeled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET next_actor = excluded.next_actor,
      next_actor_p = excluded.next_actor_p, kind = excluded.kind, kind_p = excluded.kind_p,
      urgency = excluded.urgency, resolved_p = excluded.resolved_p,
      labeled_through = excluded.labeled_through, model = excluded.model,
      labeled_at = excluded.labeled_at`)
    .bind(
      key,
      nextActor,
      nextActorP,
      kind,
      kindP,
      a.urgency ? a.urgency.score : null,
      a.resolved ? a.resolved.noul : null,
      thread.any_at,
      `${clef.model || 'clef'}+${clairic.model || 'clairic'}`,
      now.toISOString(),
    )
    .run();
  const loose = clairicFacts(clairic.answers);
  await replaceFacts(env.DB, key, 'clairic', loose);
  return {
    result: 'labeled', next_actor: nextActor, kind, facts: loose.length,
  };
}
