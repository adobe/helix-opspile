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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api } from '../src/api.js';
import {
  effectiveLabel, isAdmin, modelAnswer, reviewQueue, reviewStats, submitReview,
} from '../src/review.js';
import { d1 } from './d1.js';

// Made-up people, threads and labels only.
const PEOPLE = [
  {
    id: 1, email: 'admin@staff.example', name: 'Ad Min', staff: 1, teams: ['admin', 'helix'],
  },
  {
    id: 2, email: 'member@staff.example', name: 'Mem Ber', staff: 1, teams: ['helix'],
  },
];
const LT = '2026-10-21T10:00:00Z';

function db() {
  const D = d1({ teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }], people: PEOPLE });
  for (const [thread, p] of [['t1', 0.9], ['t2', 0.4]]) {
    D.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, last_at, any_at, updated_at) VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix', ?, ?, ?, ?)`)
      .run(thread, thread, `p/${thread}/`, LT, LT, LT);
    D.sqlite.prepare(`INSERT INTO labels (thread, next_actor, next_actor_p, kind, kind_p, urgency,
      resolved_p, labeled_through, model, labeled_at) VALUES (?, 'us', ?, 'incident', 0.9, 2.4, 0.1, ?, 'clef', ?)`)
      .run(thread, p, LT, LT);
  }
  return D;
}
const admin = { id: 1, teams: [{ slug: 'admin' }, { slug: 'helix' }] };
const member = { id: 2, teams: [{ slug: 'helix' }] };

describe('label review', () => {
  it('is for the admin team only', () => {
    assert.equal(isAdmin(admin), true);
    assert.equal(isAdmin(member), false);
  });

  it('reads the model answers as reviewable values', () => {
    const label = {
      next_actor: 'us', next_actor_p: 0.9, kind: 'incident', urgency: 2.4, resolved_p: 0.1,
    };
    assert.deepEqual(modelAnswer(label, 'urgency'), { value: '2', p: null });
    assert.deepEqual(modelAnswer(label, 'resolved'), { value: 'no', p: 0.1 });
  });

  it('records a review, validates it, and overrides the label for that version', async () => {
    const D = db();
    assert.equal(
      (await submitReview(D, admin, { thread: 't1', question: 'kind', value: 'nope' })).error,
      'unknown question or answer',
    );
    assert.deepEqual(
      await submitReview(D, admin, { thread: 't1', question: 'kind', value: 'request' }),
      { ok: true, agrees: false },
    );
    assert.deepEqual(
      await submitReview(D, admin, { thread: 't1', question: 'next_actor', value: 'us' }),
      { ok: true, agrees: true },
    );
    const [label] = D.rows("SELECT * FROM labels WHERE thread = 't1'");
    const reviews = D.rows('SELECT * FROM label_reviews');
    const eff = effectiveLabel(label, reviews);
    assert.deepEqual([eff.kind, eff.next_actor, eff.reviewed], ['request', 'us', ['kind', 'next_actor']]);
    // A relabel after new activity is a new version: the old correction no longer applies.
    assert.equal(effectiveLabel({ ...label, labeled_through: 'later' }, reviews).kind, 'incident');
  });

  it('queues unreviewed labels, least confident first, and reports accuracy', async () => {
    const D = db();
    assert.deepEqual((await reviewQueue(D)).map((q) => q.thread), ['t2', 't1']);
    await submitReview(D, admin, { thread: 't2', question: 'kind', value: 'question' });
    await submitReview(D, admin, { thread: 't1', question: 'kind', value: 'incident' });
    assert.deepEqual((await reviewQueue(D)).map((q) => q.thread), []);
    const [kind] = await reviewStats(D);
    assert.deepEqual({ ...kind }, {
      question: 'kind', reviewed: 2, agreed: 1, accuracy: 0.5, corrections: [{ from: 'incident', to: 'question', n: 1 }],
    });
  });

  it('refuses the review API to members outside the admin team', async () => {
    const D = db();
    const env = { DB: D };
    const call = (who, path, init) => api(new Request(`https://opspile.test${path}`, init), env, new URL(`https://opspile.test${path}`), { viewer: who });
    const denied = await call({ ...member, admin: false }, '/api/review/queue');
    assert.equal(denied.status, 403);
    const allowed = await call({ ...admin, admin: true }, '/api/review/queue');
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).queue.length, 2);
  });
});
