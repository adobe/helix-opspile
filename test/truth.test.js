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
  NO_LAYER, allocate, drawSample, hubShare, labelSets, longTail, markSets, movesMap, pct,
  sameProduct, scoreRelation, stratumLayer,
} from '../scripts/truth-lib.mjs';
import { reviewPage } from '../scripts/truth-review.mjs';

// Made-up threads and technologies: nothing here is production's.
const marks = {
  t1: { tech: { alpha: 'about', beta: 'uses' }, missing: [{ name: 'Acme Widgets' }] },
  t2: { tech: { beta: 'about' }, missing: [] },
  t3: { tech: {}, missing: ['Zeta Cloud'] },
};
const sets = (rel) => new Map(Object.entries(marks).map(([t, m]) => [t, markSets(m)[rel]]));

describe('the ground truth (scripts/truth-lib.mjs)', () => {
  it('reads "about" as also "uses"', () => {
    const { uses, about } = markSets(marks.t1);
    assert.deepEqual([...uses].sort(), ['alpha', 'beta']);
    assert.deepEqual([...about], ['alpha']);
  });

  it('scores precision and recall per entry and overall', () => {
    const guess = new Map([
      ['t1', new Set(['alpha', 'gamma'])],
      ['t2', new Set(['beta'])],
      ['t3', new Set(['outside'])],
    ]);
    const s = scoreRelation(sets('uses'), guess, ['alpha', 'beta', 'gamma']);
    // tp: alpha@t1, beta@t2; fp: gamma@t1; fn: beta@t1
    assert.deepEqual([s.overall.tp, s.overall.fp, s.overall.fn], [2, 1, 1]);
    assert.equal(s.overall.precision, 2 / 3);
    assert.equal(s.overall.recall, 2 / 3);
    assert.equal(s.per.beta.recall, 1 / 2);
    assert.equal(s.per.beta.precision, 1);
    assert.equal(s.per.gamma.precision, 0);
    assert.equal(s.per.gamma.recall, null, 'no thread is marked with it');
    assert.equal(s.outside, 1, 'an id outside the vocabulary is counted apart');
    assert.equal(s.overall.macroRecall, (1 + 1 / 2) / 2, 'the entries marked somewhere');
    assert.equal(s.overall.macroPrecision, (1 / 1 + 1 + 0) / 3, 'the entries named somewhere');
  });

  it('scores "about" against the about marks only', () => {
    const guess = new Map([['t1', new Set(['alpha', 'beta'])], ['t2', new Set(['beta'])]]);
    const s = scoreRelation(sets('about'), guess, ['alpha', 'beta']);
    assert.deepEqual([s.overall.tp, s.overall.fp, s.overall.fn], [2, 1, 0]);
  });

  it('gives the hub share of each entry, largest first', () => {
    const hubs = hubShare(sets('uses'), 3);
    assert.deepEqual(hubs.map((h) => [h.id, h.n]), [['beta', 2], ['alpha', 1]]);
    assert.equal(hubs[0].share, 2 / 3);
  });

  it('counts the long tail a pipeline covers', () => {
    const tail = longTail(marks, (thread, name) => thread === 't1' && sameProduct(name, 'acme widgets'));
    assert.deepEqual([tail.names, tail.hit, tail.recall], [2, 1, 1 / 2]);
    assert.ok(sameProduct('Adobe Zeta Cloud', 'Zeta Cloud'));
    assert.ok(sameProduct('Zeta', 'Zeta Cloud'), 'the first word of the name');
    assert.ok(!sameProduct('Cloud', 'Zeta Cloud'), 'a word of it alone is no name');
  });

  it('maps ids through tech_moves, the admin team first, along a chain', () => {
    const moves = movesMap([
      { team: 'other', old: 'alpha', tech: 'acme/other' },
      { team: 'admin', old: 'alpha', tech: 'acme/alpha' },
      { team: 'admin', old: 'acme/alpha', tech: 'acme/alpha-2' },
      { team: 'admin', old: 'loop', tech: 'loop' },
    ]);
    assert.equal(moves.resolve('alpha'), 'acme/alpha-2');
    assert.equal(moves.resolve('beta'), 'beta');
    assert.equal(moves.resolve('loop'), 'loop');
    assert.deepEqual([...markSets(marks.t1, moves).about], ['acme/alpha-2']);
    const label = labelSets('{"alpha":0.9,"beta":0.5}', [{ tech: 'beta', p: 1 }], { moves });
    assert.deepEqual([...label.uses].sort(), ['acme/alpha-2', 'beta']);
    assert.equal(label.about, null, 'a label that does not tell "about" apart');
  });

  it('reads "about" from a label that has it', () => {
    const label = labelSets({ alpha: { p: 0.95, about: 0.9 }, beta: { p: 0.9, about: 0.1 } });
    assert.deepEqual([...label.uses].sort(), ['alpha', 'beta']);
    assert.deepEqual([...label.about], ['alpha']);
  });

  it('splits a sample by size, at least one each, never more than there are', () => {
    const plan = allocate({ big: 100, mid: 16, one: 1 }, 20);
    assert.equal(Object.values(plan).reduce((a, b) => a + b, 0), 20);
    assert.equal(plan.one, 1);
    assert.ok(plan.big > plan.mid);
    assert.deepEqual(allocate({ a: 2, b: 1 }, 10), { a: 2, b: 1 });
  });

  it('samples by team and layer, seeded, with a cap per customer', () => {
    const population = Array.from({ length: 300 }, (_, i) => ({
      thread: `t${String(i).padStart(3, '0')}`,
      team: ['red', 'red', 'red', 'blue', 'green'][i % 5],
      org: i % 3 === 0 ? 'one' : `org${i % 40}`,
      layers: [[], ['site'], ['edge', 'site'], ['content']][i % 4],
    }));
    const a = drawSample(population, { n: 40, seed: 's', cap: 4 });
    const b = drawSample(population, { n: 40, seed: 's', cap: 4 });
    assert.equal(a.picked.length, 40);
    assert.deepEqual(a.picked.map((t) => t.thread), b.picked.map((t) => t.thread));
    assert.notDeepEqual(
      drawSample(population, { n: 40, seed: 'other', cap: 4 }).picked.map((t) => t.thread),
      a.picked.map((t) => t.thread),
    );
    assert.ok(a.picked.filter((t) => t.org === 'one').length <= 4);
    assert.deepEqual(new Set(a.picked.map((t) => t.team)), new Set(['red', 'blue', 'green']));
    assert.ok(a.picked.some((t) => t.stratum === NO_LAYER));
    assert.equal(stratumLayer(['edge', 'site'], { edge: 3, site: 9 }), 'edge');
  });

  it('writes a review page that keeps its data inside its script', () => {
    const html = reviewPage({
      origin: 'https://inbox.example',
      seed: 's',
      vocabulary: [{
        tech: 'alpha', name: 'Alpha', layer: 'site', description: 'the Alpha',
      }],
      threads: [{
        thread: 'x:1',
        team: 'red',
        org: 'acme',
        title: '</script><b>t</b>',
        layer: 'site',
        mark: marks.t1,
        said: null,
      }],
    });
    assert.ok(html.includes('--spectrum-background-base-color:'));
    assert.ok(html.includes('prefers-color-scheme: dark'));
    assert.equal(html.split('</script>').length - 1, 2, 'only the two script elements end');
    assert.equal(pct(0.666), '67%');
    assert.equal(pct(null), '–');
  });
});
