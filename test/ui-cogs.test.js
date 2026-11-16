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

/*
 * The COGS chart's series by customer or team (ui/cogs.js, `seriesOf`): which have a colour of
 * their own, which are Shared and which Other. The page's own code, run in Node with what it needs
 * of the rest of the page stubbed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['cogs.js'];

/** The page's script from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const GROUPS = Array.from({ length: 10 }, (_, i) => `#c${i}`);
const esc = (s) => String(s ?? '');

/** `seriesOf` with `q` the page's filters. */
function seriesOf(q = {}) {
  const state = {
    q: {
      service: [], org: [], team: [], ...q,
    },
  };
  return piece('/** What `d` is by', '/**\n * Stacked bars', 'seriesOf', {
    state,
    esc,
    color: () => '#000',
    TM: { services: 'Services', orgs: 'Customers', teams: 'Teams' },
    GROUPS,
    OTHER: '(other)',
    GREY: '#888',
    SHARED_ORG: '(shared)',
    NO_TEAM: '(none)',
    orgName: (k) => `org ${k}`,
    teamName: (k) => `team ${k}`,
  }).seriesOf;
}

/** Customers c0 … c11, the first the biggest, all in the customer list. */
const ORGS = Array.from({ length: 12 }, (_, i) => ({ org: `c${i}`, name: `Customer ${i}`, flow: 12 - i }));

const answer = (by, groups, list = ORGS) => ({
  services: [],
  orgs: by === 'orgs' ? list : [],
  teams: by === 'teams' ? list.map(({ org, ...g }) => ({ ...g, team: org })) : [],
  chart: { by, unit: 'day', columns: [{ at: '2026-11-01', services: {}, groups }] },
});

describe('cogs: the chart by customer or team', () => {
  it('gives the biggest a colour each, the shared rows Shared and the rest Other', () => {
    const groups = { '': 10.5, '(other)': 1 };
    for (const g of ORGS.slice(0, 10)) {
      groups[g.org] = g.flow;
    }
    const { list, of, slots } = seriesOf()(answer('orgs', groups));
    assert.deepEqual(list.map((s) => s.series), ['g0', 'g1', 'shared', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'other']);
    assert.equal(list[0].name, 'Customer 0');
    assert.equal(list.at(-1).pick, '');
    assert.equal(slots.get('c9'), 9);
    assert.deepEqual(of({ groups: { c0: 1, x: 2, '(other)': 3 } }), { c0: 1, '(other)': 5 });
  });

  it('ranks what the chart has: a small customer picked is its own, not Other', () => {
    // Picked, c11 is the chart's one customer, though the list has it last of twelve.
    const { list, of } = seriesOf({ org: ['c11'] })(answer('orgs', { c11: 1 }));
    assert.deepEqual(list.map((s) => [s.id, s.name, s.series, s.on]), [['c11', 'Customer 11', 'g0', true]]);
    assert.deepEqual(of({ groups: { c11: 1 } }), { c11: 1 });
  });

  it('does the same for a team, and names one the list does not have', () => {
    const { list } = seriesOf({ team: ['c10'] })(answer('teams', { c10: 2, gone: 1 }));
    assert.deepEqual(list.map((s) => [s.id, s.name, s.series]), [
      ['c10', 'Customer 10', 'g0'], ['gone', 'team gone', 'g1'],
    ]);
  });
});

describe('cogs: the chart and the treemap move to a new answer', () => {
  const { flip } = piece('/** The keyframes that draw the rect', '/**\n * The old drawing', 'flip');

  it('draws the new rect where the old one was, and lets it go to where it is', () => {
    // A bar twice as tall as it was, its foot where it was: from half its height, at its foot.
    const [from, to] = flip({
      x: 10, y: 60, w: 20, h: 40,
    }, {
      x: 10, y: 20, w: 20, h: 80,
    });
    assert.equal(from.transform, 'translate(0px, 50px) scale(1, 0.5)');
    assert.equal(to.transform, 'none');
    // What is new grows from nothing at its foot.
    assert.equal(flip({
      x: 0, y: 100, w: 20, h: 0,
    }, {
      x: 0, y: 60, w: 20, h: 40,
    })[0].transform, 'translate(0px, 100px) scale(1, 0)');
  });

  it('leaves what has not moved alone, so an unchanged redraw animates nothing', () => {
    const box = {
      x: 1, y: 2, w: 3, h: 4,
    };
    assert.equal(flip(box, { ...box, y: 2.2 }), null);
  });

  it('keys the bars and the tiles by what they show, and moves none for less motion', () => {
    assert.match(js, /<g class="col" data-i="\$\{i\}" data-at="\$\{esc\(at\[i\]\.at\)\}">/);
    assert.match(js, /data-series="\$\{esc\(s\.series\)\}" data-k="\$\{esc\(s\.id\)\}"\/>/);
    assert.match(js, /function shapes\(\) \{\n {2}if \(REDUCED_MOTION\.matches/);
    assert.match(js, /function morph\(from\) \{\n {2}if \(!from \|\| REDUCED_MOTION\.matches/);
  });
});
