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
import { agreementWithYou } from '../scripts/rank-judge.mjs';
import { parseAnswer } from '../scripts/rank-llm.mjs';
import { auc, customerTurns, logistic } from '../scripts/rank-behavior.mjs';
import {
  asOf, decide, replyGames, shareOut,
} from '../scripts/rank-combo.mjs';
import { boost, forest, treeScore } from '../scripts/rank-trees.mjs';
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

  it('is trained on features it computes, and nothing else', () => {
    assert.ok(Rank.model, 'ui/rank.js has a model');
    const used = Rank.model.trees ? Rank.model.names : Object.keys(Rank.model.weights);
    assert.ok(used.length > 10);
    for (const n of used) {
      assert.ok(Rank.names.includes(n), n);
    }
  });

  it('keeps the policy: resolved only lowers a thread, waiting on us only raises it', () => {
    const base = {
      last_at: ago(3),
      root_at: ago(30),
      last_staff: 0,
      messages: 6,
      waiting_on: 'customer',
      label: { urgency: 1, resolved_p: 0.2, label_kind: 'question' },
      participants: [{ staff: true }],
    };
    for (const h of [0.5, 5, 50, 500]) {
      for (const urgency of [0, 1, 2, 3]) {
        const t = { ...base, last_at: ago(h), label: { ...base.label, urgency } };
        const at = (p) => Rank.score({ ...t, label: { ...t.label, resolved_p: p } }, NOW);
        assert.ok(at(0.9) <= at(0.5) && at(0.5) <= at(0.1), `resolved, ${h} h, urgency ${urgency}`);
        assert.ok(Rank.score({ ...t, resolution: { verdict: 'resolved' } }, NOW) <= at(1) + 1e-9);
        assert.ok(Rank.score({ ...t, waiting_on: 'us' }, NOW) >= Rank.score(t, NOW) - 1e-9, `us, ${h} h`);
      }
    }
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
      label: { urgency: 1, resolved_p: 0.2, label_kind: 'request' },
    };
    assert.ok(Rank.score(done, NOW) < Rank.score(open, NOW), 'resolving lowers it');
    assert.ok(Rank.score(done, NOW) < Rank.score(week, NOW), 'below an open thread a week old, as urgent');
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

  it('counts how often Clef, the model and the old score pick what you picked', () => {
    const games = [
      {
        a: 'x', b: 'y', p: 0.95, ab: 0.97, ba: 0.07,
      },
      {
        a: 'y', b: 'z', p: 0.6, ab: 0.8, ba: 0.6,
      },
      {
        a: 'x', b: 'z', p: 0.3, ab: 0.3, ba: 0.7,
      },
    ];
    const human = [
      {
        a: 'x', b: 'y', pick: 'left', p: 1,
      },
      {
        a: 'y', b: 'z', pick: 'right', p: 0,
      },
      {
        a: 'x', b: 'z', pick: 'tie', p: 0.5,
      },
    ];
    const order = { x: 3, y: 2, z: 1 };
    const s = agreementWithYou(human, games, { model: (k) => order[k], classic: (k) => -order[k] });
    assert.equal(s.decided, 2);
    assert.equal(s.ties, 1);
    assert.deepEqual(s.clef, { n: 2, agree: 1 });
    assert.deepEqual(s.byConfidence['90%+'], { n: 1, agree: 1 });
    // Asked the other way round, Clef changed its mind on y and z (0.8, then 0.6 for z).
    assert.deepEqual(s.clefFlipped, { n: 1, agree: 0 });
    assert.deepEqual(s.model, { n: 2, agree: 1 });
    assert.deepEqual(s.classic, { n: 2, agree: 1 });
    assert.equal(s.tieClefConfidence, 0.7);
  });

  it('reads a Claude judge\'s answer, also around other text', () => {
    assert.deepEqual(parseAnswer('{"reason": "B waits on us", "first": "B", "confidence": 0.8}'), {
      p: 0.19999999999999996, reason: 'B waits on us',
    });
    assert.equal(parseAnswer('Sure: {"first": "a", "confidence": 3}').p, 1);
    assert.equal(parseAnswer('no json'), null);
    assert.equal(parseAnswer('{"first": "C"}'), null);
  });
});

describe('what the teams do (scripts/rank-behavior.mjs)', () => {
  const at = (h) => new Date(NOW - h * 3600000).toISOString();
  const msg = (h, staff, body = 'x', kind = 'person') => ({ at: at(h), author: { kind, staff }, body });

  it('finds when a customer wrote and whether Adobe answered within a day', () => {
    const turns = customerTurns([
      msg(100, false, 'help?'), msg(99, false, 'please'), msg(98, true),
      msg(50, false), msg(49, false, 'bot', 'bot'), msg(20, true),
      msg(2, false),
    ], NOW);
    assert.deepEqual(turns.map((t) => t.messages), [2, 1, 1]);
    assert.equal(turns[0].first, true);
    assert.equal(turns[0].text, 'help?\nplease');
    assert.equal(turns[0].replyH, 1);
    assert.equal(turns[0].day, 1);
    // Answered after 30 hours (a bot's post is no answer): not within a day.
    assert.equal(turns[1].replyH, 30);
    assert.equal(turns[1].day, 0);
    // No answer yet, and a day has not gone by: not known.
    assert.equal(turns[2].day, null);
  });

  it('measures how well a score ranks, and fits odds', () => {
    assert.equal(auc([3, 2, 1, 0], [1, 1, 0, 0]), 1);
    assert.equal(auc([1, 1], [1, 0]), 0.5);
    const X = [];
    const y = [];
    // With x, three answers in four; without, one in four: odds × 9.
    for (let i = 0; i < 400; i += 1) {
      const x = i < 200 ? 1 : 0;
      X.push([x]);
      y.push((i % 4 < 3) === Boolean(x) ? 1 : 0);
    }
    const w = logistic(X, y, { l2: 0 });
    assert.ok(Math.abs(Math.exp(w[1]) - 9) < 0.5, String(Math.exp(w[1])));
  });
});

describe('the combo model\'s games (scripts/rank-combo.mjs)', () => {
  it('lets you overrule Sonnet, Sonnet Haiku, and Haiku Clef', () => {
    const games = [{ a: 'x', b: 'y', p: 0.9 }, { a: 'y', b: 'z', p: 0.8 }, { a: 'x', b: 'z', p: 0.7 }];
    const llm = [
      {
        judge: 'haiku', a: 'y', b: 'z', p: 0.3,
      },
      {
        judge: 'sonnet', a: 'x', b: 'y', p: 0.2,
      },
      {
        judge: 'haiku', a: 'x', b: 'y', p: 0.6,
      },
    ];
    const human = [{
      a: 'x', b: 'z', p: 0, pick: 'right',
    }, {
      a: 'y', b: 'z', p: 1, pick: 'skip',
    }];
    const by = Object.fromEntries(decide(games, human, llm).map((g) => [`${g.a}${g.b}`, g]));
    assert.deepEqual([by.xy.source, by.xy.p], ['sonnet', 0.2]);
    assert.deepEqual([by.yz.source, by.yz.p], ['haiku', 0.3]);
    assert.deepEqual([by.xz.source, by.xz.p], ['human', 0]);
  });

  it('turns one person\'s answers on a day into games, sooner over later', () => {
    const m = (h, staff, name) => ({
      at: ago(h), author: { kind: 'person', staff, name }, body: staff ? 'answer' : 'asks?',
    });
    const thread = (key, msgs) => ({
      key, entry: { source: 'slack', kind: 'channel', label: { resolved_p: 0.9 } }, messages: msgs,
    });
    // Ada answers t1 after 10 minutes and t2 after 2 hours, the same day; Bo answers t3.
    const day = 30;
    const games = replyGames([
      thread('t1', [m(day + 0.2, false, 'C'), m(day, true, 'Ada')]),
      thread('t2', [m(day + 2, false, 'D'), m(day, true, 'Ada')]),
      thread('t3', [m(day + 1, false, 'E'), m(day, true, 'Bo')]),
    ]);
    assert.equal(games.length, 1);
    assert.deepEqual([games[0].a.thread, games[0].b.thread], ['t1', 't2']);
    // Each thread as it was when its customer wrote: waiting on us, not resolved yet.
    const then = asOf(games[0].b.entry, games[0].b.messages, games[0].b.turn);
    assert.equal(then.waiting_on, 'us');
    assert.equal(then.messages, 1);
    assert.equal(then.staffPosted, false);
    assert.equal(then.label.resolved_p, 0.3);
  });

  it('gives each source its share of the training, whatever its number of games', () => {
    const list = [
      ...Array.from({ length: 90 }, () => ({ source: 'clef', w: 1 })),
      ...Array.from({ length: 10 }, () => ({ source: 'human', w: 1 })),
    ];
    const out = shareOut(list, { human: 0.75, clef: 0.25, click: 0.5 });
    const total = (k) => out.filter((r) => r.source === k).reduce((s, r) => s + r.w, 0);
    // No clicks: their share goes to the others, in proportion.
    assert.ok(Math.abs(total('human') - 75) < 1e-9);
    assert.ok(Math.abs(total('clef') - 25) < 1e-9);
  });
});

describe('tree models of the order (scripts/rank-trees.mjs)', () => {
  // The winner is the one with x above 0.5 and y below it: an interaction no line draws.
  const rnd = random(21);
  const things = Array.from({ length: 120 }, () => ({ x: rnd(), y: rnd(), z: rnd() }));
  const good = (t) => (t.x > 0.5 && t.y < 0.5 ? 1 : 0);
  const games = [];
  for (let i = 0; i < 1500; i += 1) {
    const a = things[Math.floor(rnd() * things.length)];
    const b = things[Math.floor(rnd() * things.length)];
    if (good(a) !== good(b)) {
      games.push({
        a, b, p: good(a), w: 1,
      });
    }
  }
  const right = (m) => games.filter((g) => (treeScore(m, g.a) > treeScore(m, g.b)) === Boolean(g.p))
    .length / games.length;

  it('boosted trees learn an interaction', () => {
    const m = boost(['x', 'y', 'z'], games, { trees: 40, depth: 2, rate: 0.3 });
    assert.ok(right(m) > 0.95, String(right(m)));
    // Plain JSON: a tree is a split [feature, threshold, left, right] or a leaf.
    const t = JSON.parse(JSON.stringify(m.trees[0]));
    assert.ok(Array.isArray(t) ? t.length === 4 : typeof t === 'number');
  });

  it('keeps a monotone feature one way, even against the games', () => {
    // The games say: more x wins. Held to −1, x may only lower a score.
    const m = boost(['x', 'y', 'z'], games, {
      trees: 40, depth: 2, rate: 0.3, signs: { x: -1 },
    });
    for (const t of things) {
      assert.ok(treeScore(m, { ...t, x: 0.9 }) <= treeScore(m, { ...t, x: 0.1 }) + 1e-9);
    }
  });

  it('a random forest does too, scaled to log-odds', () => {
    const m = forest(['x', 'y', 'z'], games, { trees: 40, depth: 3 });
    assert.ok(right(m) > 0.9, String(right(m)));
    const top = things.find((t) => good(t));
    const bottom = things.find((t) => !good(t));
    assert.ok(treeScore(m, top) - treeScore(m, bottom) > 1);
  });
});
