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
import {
  agreement, bradleyTerry, elo, firstP, fit, loadClassic, loadRank, pairKey, pairState, random,
  spearman, swiss, withModel,
} from '../scripts/rank-lib.mjs';
import { SCRIPTS } from './ui.js';

const NOW = Date.parse('2026-03-02T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();

describe('the team order model (ui/rank.js)', () => {
  const Rank = loadRank();

  it('has finite features for any entry, also an empty one', () => {
    for (const t of [{}, { kind: 'alert', any_at: ago(3) }, {
      last_at: ago(1),
      root_at: ago(30),
      label: { urgency: 2, resolved_p: 0.2, label_kind: 'incident' },
      waiting_on: 'us',
      participants: [{ staff: true }, { staff: false }],
      messages: 7,
    }]) {
      const f = Rank.features(t, NOW);
      assert.deepEqual(Object.keys(f), Rank.names);
      for (const [k, v] of Object.entries(f)) {
        assert.ok(Number.isFinite(v), `${k}: ${v}`);
      }
    }
  });

  it('is trained on every feature it computes, and nothing else', () => {
    assert.ok(Rank.model, 'ui/rank.js has a model');
    assert.deepEqual(Object.keys(Rank.model.weights).sort(), [...Rank.names].sort());
  });

  it('puts a thread you just answered and resolved below the open ones', () => {
    const open = {
      last_at: ago(1),
      root_at: ago(5),
      last_staff: 0,
      waiting_on: 'us',
      messages: 4,
      label: { urgency: 1, resolved_p: 0.1, label_kind: 'question' },
    };
    const done = {
      ...open,
      last_at: ago(0),
      last_staff: 1,
      waiting_on: 'nobody',
      messages: 5,
      label: { ...open.label, resolved_p: 0.9 },
      resolution: { verdict: 'resolved' },
    };
    const week = {
      last_at: ago(7 * 24),
      root_at: ago(8 * 24),
      last_staff: 1,
      waiting_on: 'customer',
      messages: 3,
      label: { urgency: 0.5, resolved_p: 0.2, label_kind: 'request' },
    };
    assert.ok(Rank.score(done, NOW) < Rank.score(open, NOW), 'resolving lowers it');
    assert.ok(Rank.score(done, NOW) < Rank.score(week, NOW), 'below an open thread a week old');
    // What makes up a score, largest first.
    const parts = Rank.explain(done, NOW);
    assert.ok(parts.some(([k]) => k === 'resolved'));
    assert.ok(Math.abs(parts[0][1]) >= Math.abs(parts[parts.length - 1][1]));
  });

  it('ranks a thread that waits on us, urgent, above one that waits on the customer', () => {
    const base = {
      last_at: ago(3), root_at: ago(20), messages: 6, label: { resolved_p: 0.1 },
    };
    const us = { ...base, waiting_on: 'us', label: { ...base.label, urgency: 2.5 } };
    const them = {
      ...base, waiting_on: 'customer', last_staff: 1, label: { ...base.label, urgency: 1 },
    };
    assert.ok(Rank.score(us, NOW) > Rank.score(them, NOW));
  });

  it('scores nothing without a model, so the inbox falls back to classicScore', () => {
    assert.equal(Rank.score({}, NOW, null), null);
    assert.equal(Rank.explain({}, NOW, null).length, 0);
  });

  it('is written into the page source as the linter wants it', () => {
    const src = SCRIPTS['rank.js'];
    const next = withModel(src, { trained: '2026-01-01', weights: { recent2d: 1.5, kind_x: -0.25 } });
    assert.match(next, /const MODEL = \{\n {4}trained: '2026-01-01',\n {4}weights: \{\n {6}recent2d: 1\.5,/);
    assert.equal(loadRank(next).score({ last_at: ago(0) }, NOW), 1.5);
    assert.equal(withModel(next, null).includes('const MODEL = null;'), true);
    assert.throws(() => withModel('nothing', {}), /no MODEL block/);
  });
});

describe('learning the order from Clef (scripts/rank-lib.mjs)', () => {
  it('reads the probability that A comes first from Clef\'s answer', () => {
    assert.equal(firstP({ answers: { first: { choice: 'a', probabilities: { a: 0.8, b: 0.2 } } } }), 0.8);
    assert.equal(firstP({ answers: { first: { choice: 'b', confidence: 0.7 } } }), 0.30000000000000004);
    assert.equal(firstP({}), null);
  });

  it('shows Clef both threads with what the inbox knows of them', () => {
    const rec = (title, body, extra = {}) => ({
      entry: {
        title, channel_name: 'c', org: 'o', last_at: ago(2), messages: 1, waiting_on: 'us', ...extra,
      },
      messages: [{
        at: ago(2), author: { kind: 'person', name: 'N', staff: false }, body, reactions: [],
      }],
    });
    const s = pairState(rec('One', 'site down'), rec('Two', 'thanks', { resolution: { verdict: 'resolved' } }), NOW);
    assert.ok(s.indexOf('=== Thread A ===') < s.indexOf('One'));
    assert.ok(s.indexOf('One') < s.indexOf('=== Thread B ==='));
    assert.match(s, /waits on: us/);
    assert.match(s, /resolved \(✅ by Adobe staff\)/);
    assert.match(s, /last message 2 h ago by the customer/);
  });

  it('plays Elo with soft outcomes, and pairs a Swiss round without repeats', () => {
    const [a, b] = elo(1500, 1500, 1);
    assert.equal(a + b, 3000);
    assert.ok(a > 1500);
    assert.deepEqual(elo(1500, 1500, 0.5), [1500, 1500]);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const met = new Set([pairKey('a', 'b')]);
    const pairs = swiss(ids, new Map([['a', 1600], ['b', 1590]]), met, random(3));
    assert.equal(pairs.length, 2);
    assert.ok(pairs.every(([x, y]) => !met.has(pairKey(x, y))));
    assert.equal(new Set(pairs.flat()).size, 4);
  });

  it('recovers a hidden order and its features from games', () => {
    const rnd = random(11);
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const f = new Map(ids.map((id) => [id, [rnd(), rnd(), rnd()]]));
    const truth = (id) => 3 * f.get(id)[0] - 2 * f.get(id)[1];
    const games = [];
    for (let i = 0; i < 600; i += 1) {
      const a = ids[Math.floor(rnd() * ids.length)];
      const b = ids[Math.floor(rnd() * ids.length)];
      if (a !== b) {
        games.push({ a, b, p: 1 / (1 + Math.exp(truth(b) - truth(a))) });
      }
    }
    const w = fit(['x', 'y', 'z'], (id) => f.get(id), games, { l2: 0.01 });
    const near = (x, y) => Math.abs(x - y) < 0.1;
    assert.ok(near(w.x, 3) && near(w.y, -2) && near(w.z, 0), JSON.stringify(w));
    const bt = bradleyTerry(ids, games);
    assert.ok(spearman(ids.map((id) => bt.get(id)), ids.map(truth)) > 0.95);
    const score = (id) => truth(id);
    assert.equal(agreement(score, games).accuracy, 1);
  });

  it('measures the inbox\'s hand-made score for nobody in particular', () => {
    const classic = loadClassic(NOW);
    const open = { last_at: ago(1), waiting_on: 'us', label: { urgency: 2 } };
    assert.ok(classic(open) > classic({ ...open, resolution: { verdict: 'resolved' } }));
  });
});
