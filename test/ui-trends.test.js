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
import { SCRIPTS } from './ui.js';

// ui/trends.js as the page runs it: its global `Trends`.
// eslint-disable-next-line no-new-func
const Trends = new Function('globalThis', `${SCRIPTS['trends.js']}\nreturn globalThis.Trends;`)({});

const WEEKS = 30;
const weeks = Array.from({ length: WEEKS }, (_, i) => new Date(Date.UTC(2026, 4, 4 + 7 * i))
  .toISOString().slice(0, 10));
// Into the week after the last: every week is over.
const NOW = Date.parse(`${weeks.at(-1)}T00:00:00Z`) + 7 * 864e5 - 1000;

/**
 * Made-up data: `channels` channels (one customer each, `orgOf`), each with one thread a week of
 * topic 0 (the background), and the threads `extra(week, channel)` says, with their topics.
 */
function dataOf({ channels = 40, orgOf = (c) => c, extra = () => [] } = {}) {
  const threads = [];
  let id = 0;
  for (let w = 0; w < WEEKS; w += 1) {
    for (let c = 0; c < channels; c += 1) {
      for (const topic of [0, ...extra(w, c)]) {
        id += 1;
        threads.push([id, w, c, orgOf(c), 0, 0, 0, topic, [], [], [w, 2]]);
      }
    }
  }
  return {
    weeks, threads, orgs: [], teams: ['edge'], sources: ['slack'], kinds: ['question'], areas: [], tech: [],
  };
}

const topicKeys = (r) => (r[Trends.I.topic] > 0 ? [r[Trends.I.topic]] : []);
const keys = (list) => list.map((x) => x.key);

describe('trends (ui/trends.js)', () => {
  it('counts a channel once a week, however much it says', () => {
    const d = dataOf({ channels: 3, extra: (w, c) => (c === 0 ? [1, 1, 1] : []) });
    const one = (r) => r[Trends.I.topic] === 1;
    assert.equal(Trends.weekly(d, one, 'channels').counts[5], 1);
    assert.equal(Trends.weekly(d, one, 'messages').counts[5], 6);
    assert.equal(Trends.weekly(d, one, 'threads').counts[5], 3);
    assert.equal(Trends.weekly(d, () => true, 'channels').counts[5], 3);
  });

  it('tells trending, declining and peaked apart, by how often, how much more and how fast', () => {
    const d = dataOf({
      extra: (w, c) => [
        // 1 rises over the last six weeks, in more and more channels.
        ...(w >= WEEKS - 6 && c < 4 + 3 * (w - (WEEKS - 6)) ? [1] : []),
        ...(w < WEEKS - 6 && c < 3 ? [1] : []),
        // 2 was in a third of the channels, and is in few now.
        ...((w < WEEKS - 6 && c % 3 === 0) || (w >= WEEKS - 6 && c === 0) ? [2] : []),
        // 3 had its weeks in the middle, and is back to a trickle.
        ...(w >= 10 && w <= 14 && c < 20 ? [3] : []),
        ...(c === 1 ? [3] : []),
        // 4 is steady.
        ...(c < 8 ? [4] : []),
      ],
    });
    const m = Trends.moving(d, { keysOf: topicKeys, now: NOW });
    assert.equal(m.last, WEEKS - 1);
    assert.deepEqual(keys(m.trending), [1]);
    assert.deepEqual(keys(m.declining), [2]);
    assert.deepEqual(keys(m.peaked), [3]);
    const up = m.trending[0];
    assert.ok(up.stats.lift > 2 && up.stats.z > 2 && up.stats.accel > 0, JSON.stringify(up.stats));
    assert.equal(d.weeks[m.peaked[0].stats.peak.week], weeks[12]);
    assert.equal(up.orgs > 10, true);
    // Its share of the active channels (40 a week, all of them): the last six weeks against before.
    assert.ok(Math.abs(up.stats.share - up.stats.recent / (40 * 6)) < 1e-9);
    assert.ok(Math.abs(up.stats.baseShare - 3 / 40) < 1e-9);
  });

  it('counts what is mostly one customer\'s half', () => {
    const extra = (w, c) => ((w >= WEEKS - 6 && c < 8) || c < 2 ? [1] : []);
    const many = Trends.moving(dataOf({ extra }), { keysOf: topicKeys, now: NOW }).trending[0];
    const mostlyOne = dataOf({ extra, orgOf: (c) => (c < 8 ? 0 : c) });
    const one = Trends.moving(mostlyOne, { keysOf: topicKeys, now: NOW }).trending[0];
    assert.ok(one.top > Trends.MOSTLY_ONE && many.top < Trends.MOSTLY_ONE);
    assert.ok(Math.abs(one.score - many.score / 2) < 1e-9);
  });

  it('does not call new what was never there before', () => {
    const d = dataOf({ extra: (w, c) => (w >= WEEKS - 6 && c < 10 ? [1] : []) });
    assert.deepEqual(keys(Trends.moving(d, { keysOf: topicKeys, now: NOW }).trending), []);
  });

  it('finds a doc or a link in many customers\' threads in one week, never there before', () => {
    const orgs = Array.from({ length: 40 }, (_, c) => ({ slug: `org${c}` }));
    // 5 is in two channels a week; 6 is in none until the week before the last, in eight
    // customers' at once; 7 is in eight channels of one week long ago; 8 in five, but of
    // no customer.
    const d = {
      ...dataOf({
        extra: (w, c) => [
          ...(c < 2 ? [5] : []),
          ...(w === WEEKS - 2 && c >= 10 && c < 18 ? [6] : []),
          ...(w === 5 && c < 8 ? [7] : []),
          ...(w === WEEKS - 1 && c >= 35 ? [8] : []),
        ],
        orgOf: (c) => (c >= 35 ? 40 : c),
      }),
      orgs: [...orgs, { slug: '' }],
    };
    const sp = Trends.spikes(d, { keysOf: topicKeys, now: NOW });
    assert.deepEqual(keys(sp), [6]);
    assert.equal(sp[0].week, WEEKS - 2);
    assert.equal(sp[0].orgs, 8);
    assert.equal(sp[0].usual, 0);
    // Which `moving` does not call trending: it was never there before.
    assert.deepEqual(keys(Trends.moving(d, { keysOf: topicKeys, now: NOW }).trending), []);
  });

  it('starts where the channels began to be read, and leaves out the week under way', () => {
    const d = dataOf({ channels: 10 });
    // A thread from long before: a week that hardly counts.
    d.threads.push([0, 0, 99, 0, 0, 0, 0, 0, [], [], [0, 1]]);
    for (const t of d.threads) {
      if (t[1] < 3 && t[2] !== 99) {
        t[10] = [];
      }
    }
    assert.equal(Trends.firstOf(Trends.weekly(d, () => true).counts), 3);
    const mid = Date.parse(`${weeks.at(-1)}T00:00:00Z`) + 2 * 864e5;
    assert.equal(Trends.lastFull(d, mid).last, WEEKS - 2);
    assert.ok(Math.abs(Trends.lastFull(d, mid).partial - 2 / 7) < 1e-9);
  });
});

describe('the trends chart (ui/trendview.js)', () => {
  // As the page runs it, with its globals: no DOM is needed before it has data.
  const load = (search = '', body = {}) => {
    const globals = {
      Trends,
      TopicGraph: { standsFor: () => null },
      location: { search },
      document: { getElementById: () => null, activeElement: null },
      fetch: async () => ({ ok: true, json: async () => body }),
    };
    // eslint-disable-next-line no-new-func
    return new Function(
      'globalThis',
      'location',
      'document',
      'Trends',
      'TopicGraph',
      'fetch',
      `${SCRIPTS['trendview.js']}\nreturn globalThis.TrendView;`,
    )(
      globals,
      globals.location,
      globals.document,
      Trends,
      globals.TopicGraph,
      globals.fetch,
    );
  };

  it('lists the docs and links rising across customers, and puts one on the chart', async () => {
    // Fact 0 in eight customers' threads in one week; fact 1 in one customer's every week.
    const d = dataOf({ extra: () => [] });
    for (const t of d.threads) {
      const w = t[Trends.I.week];
      const c = t[Trends.I.channel];
      t.push([...(w === WEEKS - 2 && c < 8 ? [0] : []), ...(c === 39 ? [1] : [])]);
    }
    const body = {
      ...d,
      orgs: Array.from({ length: 40 }, (_, c) => ({ slug: `org${c}` })),
      facts: [
        {
          key: 'url:github.com/fake-org/edge/pull/5', field: 'url', label: 'github.com/fake-org/edge/pull/5', href: 'https://github.com/fake-org/edge/pull/5', threads: 8, orgs: 8,
        },
        {
          key: 'url:shop.fake/cart', field: 'url', label: 'shop.fake/cart', href: 'https://shop.fake/cart', threads: 30, orgs: 1,
        },
      ],
      fields: { url: 'URL' },
    };
    // A chart that was cleared: what is added is all there is.
    const view = load('?tq=', body);
    view.fromUrl();
    await view.load();
    const ctx = {
      team: '', graph: { all: new Map() }, toUrl: () => {}, sel: '',
    };
    const up = view.rising(ctx);
    assert.deepEqual(up.map((x) => x.fact.key), ['url:github.com/fake-org/edge/pull/5']);
    assert.equal(up[0].spike.orgs, 8);
    const html = view.risingSection(ctx);
    assert.match(html, /data-term="github.com\/fake-org\/edge\/pull\/5"/);
    assert.match(html, /href="https:\/\/github.com\/fake-org\/edge\/pull\/5"/);
    assert.match(html, /8 customers/);
    assert.match(html, /URL · 8 threads, 8 customers/);
    // Its label, or the URL it is, is that fact on the chart, counted from the data.
    view.compare('https://www.github.com/fake-org/edge/pull/5/', { ...ctx, map: {}, onWeek: () => {} });
    assert.deepEqual(view.params(), [['tq', 'github.com/fake-org/edge/pull/5']]);
  });

  it('takes every line off on Clear, the pick\'s too, and keeps the chart empty', () => {
    const view = load('?tq=topic%3A1%2C+topic%3A2');
    view.fromUrl();
    assert.deepEqual(view.params(), [['tq', 'topic:1, topic:2']]);
    const calls = [];
    view.clear({ sel: 'topic:2', pick: (id) => calls.push(['pick', id]), toUrl: () => calls.push(['toUrl']) });
    // Unpicked, which draws the chart again: empty, not its defaults, also in the address.
    assert.deepEqual(calls, [['pick', '']]);
    assert.deepEqual(view.params(), [['tq', '']]);
    const quiet = load('?tq=topic%3A1');
    quiet.fromUrl();
    const more = [];
    quiet.clear({ sel: '', pick: (id) => more.push(['pick', id]), toUrl: () => more.push(['toUrl']) });
    assert.deepEqual(more, [['toUrl']]);
    assert.deepEqual(quiet.params(), [['tq', '']]);
    // An empty `tq` comes back empty; none, the defaults.
    const empty = load('?tq=');
    empty.fromUrl();
    assert.deepEqual(empty.params(), [['tq', '']]);
    const fresh = load('');
    fresh.fromUrl();
    assert.deepEqual(fresh.params(), []);
  });
});
