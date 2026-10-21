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

import { QUESTIONS } from './label.js';

/**
 * Label review, for members of the admin team. A review records what the right answer to
 * one Clef question is for one label version. It is calibration data, and it overrides the
 * model's answer until the thread changes and is labeled again.
 */

export const ADMIN_TEAM = 'admin';

/** The answers a reviewer may give, per question. */
export const ANSWERS = {
  next_actor: Object.keys(QUESTIONS.next_actor.criteria),
  kind: Object.keys(QUESTIONS.kind.criteria),
  urgency: ['0', '1', '2', '3'],
  resolved: ['yes', 'no'],
};

export const isAdmin = (me) => Boolean(me && me.teams.some((t) => t.slug === ADMIN_TEAM));

/** The model's answer to one question, as a reviewable value and its probability. */
export function modelAnswer(label, question) {
  if (!label) {
    return { value: null, p: null };
  }
  switch (question) {
    case 'next_actor': return { value: label.next_actor, p: label.next_actor_p };
    case 'kind': return { value: label.kind ?? label.label_kind, p: label.kind_p };
    case 'urgency': return {
      value: label.urgency === null || label.urgency === undefined
        ? null : String(Math.round(label.urgency)),
      p: null,
    };
    case 'resolved': {
      if (label.resolved_p === null || label.resolved_p === undefined) {
        return { value: null, p: null };
      }
      return { value: label.resolved_p >= 0.5 ? 'yes' : 'no', p: label.resolved_p };
    }
    default: return { value: null, p: null };
  }
}

/**
 * The label as the inbox should show it: the latest review of each question for this
 * label version replaces the model's answer. Returns the label with `reviewed` listing the
 * corrected questions.
 */
export function effectiveLabel(label, reviews) {
  if (!label) {
    return null;
  }
  const latest = new Map();
  for (const r of reviews) {
    if (r.labeled_through === label.labeled_through
      && (!latest.has(r.question) || r.created_at >= latest.get(r.question).created_at)) {
      latest.set(r.question, r);
    }
  }
  const out = { ...label, reviewed: [...latest.keys()].sort() };
  for (const [q, r] of latest) {
    if (q === 'next_actor') {
      out.next_actor = r.value;
    } else if (q === 'kind') {
      out.kind = r.value;
      if ('label_kind' in out) {
        out.label_kind = r.value;
      }
    } else if (q === 'urgency') {
      out.urgency = Number(r.value);
    } else if (q === 'resolved') {
      out.resolved_p = r.value === 'yes' ? 1 : 0;
    }
  }
  return out;
}

export async function reviewsFor(db, threads) {
  if (!threads.length) {
    return [];
  }
  const { results } = await db.prepare(`SELECT thread, question, value, labeled_through, created_at
    FROM label_reviews WHERE thread IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(threads)).all();
  return results || [];
}

/**
 * Records one review. Validates the question and the answer, and ties the review to the
 * label version the reviewer saw.
 */
export async function submitReview(db, me, {
  thread, question, value, note,
}, now = new Date()) {
  if (!ANSWERS[question] || !ANSWERS[question].includes(String(value))) {
    return { error: 'unknown question or answer' };
  }
  const label = await db.prepare('SELECT * FROM labels WHERE thread = ?').bind(thread).first();
  if (!label) {
    return { error: 'thread is not labeled' };
  }
  const model = modelAnswer(label, question);
  await db.prepare(`INSERT INTO label_reviews (thread, question, model_value, model_p, value,
      agrees, labeled_through, reviewer, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      thread,
      question,
      model.value,
      model.p,
      String(value),
      model.value === String(value) ? 1 : 0,
      label.labeled_through,
      me.id,
      note ? String(note).slice(0, 1000) : null,
      now.toISOString(),
    )
    .run();
  return { ok: true, agrees: model.value === String(value) };
}

/**
 * Labeled threads (of any team) whose current label nobody has reviewed yet, least
 * confident first.
 */
export async function reviewQueue(db, limit = 50) {
  const { results } = await db.prepare(`SELECT t.thread, t.team, t.org, t.source, t.channel_name,
      t.title, t.last_at, l.next_actor, l.next_actor_p, l.kind, l.kind_p, l.urgency, l.resolved_p,
      l.labeled_through, MIN(COALESCE(l.next_actor_p, 1), COALESCE(l.kind_p, 1)) AS confidence
    FROM labels l JOIN threads t ON t.thread = l.thread
    WHERE NOT EXISTS (SELECT 1 FROM label_reviews r
      WHERE r.thread = l.thread AND r.labeled_through = l.labeled_through)
    ORDER BY confidence ASC, t.last_at DESC LIMIT ?`).bind(limit).all();
  return results || [];
}

/**
 * How often Clef was right, per question, and the most common corrections. Only the
 * latest review per thread, question and label version counts.
 */
export async function reviewStats(db) {
  const { results } = await db.prepare(`WITH latest AS (
      SELECT r.* FROM label_reviews r
      WHERE r.created_at = (SELECT MAX(created_at) FROM label_reviews x
        WHERE x.thread = r.thread AND x.question = r.question
          AND x.labeled_through = r.labeled_through))
    SELECT question, COUNT(*) AS reviewed, SUM(agrees) AS agreed,
      ROUND(1.0 * SUM(agrees) / COUNT(*), 3) AS accuracy,
      (SELECT json_group_array(json_object('from', model_value, 'to', value, 'n', n)) FROM (
        SELECT model_value, value, COUNT(*) AS n FROM latest y
        WHERE y.question = latest.question AND y.agrees = 0
        GROUP BY model_value, value ORDER BY n DESC LIMIT 5)) AS corrections
    FROM latest GROUP BY question ORDER BY question`).all();
  return (results || []).map((r) => ({ ...r, corrections: JSON.parse(r.corrections || '[]') }));
}
