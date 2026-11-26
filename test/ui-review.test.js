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
 * What waits in Teams and Customers (ui/review.js, and "review" in ui/admin.js): one Review row at
 * the top of the sidebar, there from its first paint or not at all, so that what loads after it
 * (the duplicates, the partners, the suggested teams) never moves the rows under it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { SCRIPTS } from './ui.js';

const between = (js, from, to) => {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to}`);
  return js.slice(a, b);
};

/** ui/sidenav.js and ui/review.js in a sandbox. */
function load() {
  const kept = new Map();
  const ctx = {
    window: {
      localStorage: {
        getItem: (k) => kept.get(k) ?? null,
        setItem: (k, v) => kept.set(k, String(v)),
      },
    },
    document: { activeElement: null },
    CSS: { escape: (s) => s },
    Intl,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPTS['sidenav.js'], ctx);
  vm.runInContext(SCRIPTS['review.js'], ctx);
  return ctx;
}

const ADMIN = { admin: true, teams: [{ slug: 'admin' }] };
const MEMBER = { teams: [{ slug: 'edge' }] };
const STAFF = { staff: true, teams: [] };

/**
 * The sidebar of ui/admin.js (`drawList`, with the Review row it draws, `reviewEntry`) over
 * `state`, in a stand-in for the page's elements: what it draws into the list.
 */
function sidebar(state) {
  const ctx = load();
  const el = () => ({
    dataset: {},
    classList: { add() {} },
    innerHTML: '',
    outerHTML: '',
    scrollTop: 0,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  });
  const els = {
    list: el(), navList: el(), navFoot: el(), filter: el(),
  };
  const js = SCRIPTS['admin.js'];
  const code = `${between(js, '/** How many wait in each queue', '/** The review page\'s title')}
    ${between(js, '/** How busy a row is', '/**\n * The admin team\'s form for a new team')}
    return () => { els.list.dataset.tab = state.tab; drawList(); return els.navList.innerHTML; };`;
  const stubs = {
    state,
    els,
    $: (id) => els[id],
    esc: (s) => String(s ?? ''),
    ico: () => '<span class="ico"></span>',
    iconless: () => false,
    ago: () => '',
    channelCount: (n) => `${n} channels`,
    peopleCount: (n) => `${n} people`,
    baseOf: () => null,
    onATeam: () => Boolean(state.me.admin) || (state.me.teams || []).length > 0,
    Follow: { follows: () => false, muted: () => false },
    Agent: { activity: () => '' },
    SideNav: ctx.SideNav,
    Review: ctx.Review,
    isPair: (s) => String(s ?? '').startsWith('pair:'),
    isLink: (s) => String(s ?? '').startsWith('partner:'),
    isGroup: (s) => String(s ?? '').startsWith('group:'),
    likelyPair: (p) => p.p >= 0.5,
    reviewLink: (x) => x.p >= 0.5,
    newForm: () => {},
    pickRow: () => {},
    renderList: () => {},
  };
  // eslint-disable-next-line no-new-func -- the page script, as the browser runs it
  return new Function(...Object.keys(stubs), code)(...Object.values(stubs));
}

/** What a list draws above its first section (Following, Customers, Your teams): its own rows. */
const above = (html) => html.slice(0, html.indexOf('<h2 class="navhead"')).trim();
/** A row as it stands, whatever its count says: its badge and its title left out. */
const shape = (html) => html.replace(/<span class="navbadge">[^<]*<\/span>/g, '').replace(/ title="[^"]*"/g, '');

const orgs = (me, extra = {}) => ({
  tab: 'orgs',
  me,
  sel: null,
  filter: '',
  orgType: '',
  noIcon: false,
  teams: [],
  directory: [],
  bases: [],
  types: ['customer'],
  orgs: [{
    slug: 'acme', name: 'Acme', type: 'customer', recent: 3,
  }, {
    slug: 'globex', name: 'Globex', type: 'customer', recent: 1,
  }],
  orgsUnassigned: me.admin ? { channels: 4 } : null,
  dups: null,
  links: null,
  groups: [],
  groupsRead: false,
  ...extra,
});
const PAIRS = { pairs: [{ a: 'acme', b: 'acme-co', p: 0.9 }, { a: 'globex', b: 'globx', p: 0.2 }], orgs: {}, unchecked: 0 };
const LINKS = { pairs: [{ customer: 'acme', partner: 'agency', p: 0.8 }], orgs: {}, unchecked: 0 };

describe('the Review row of Teams and Customers', () => {
  it('is one row at the top of Customers, as tall before its counts load as after', () => {
    const state = orgs(ADMIN, { reviewHas: { orgs: true, teams: true } });
    const draw = sidebar(state);
    const first = above(draw());
    assert.equal((first.match(/<button/g) || []).length, 1, 'one row');
    assert.match(first, /data-sel="review:"/);
    assert.doesNotMatch(first, /navbadge/, 'no count while the duplicates and partners load');
    state.dups = PAIRS;
    const half = above(draw());
    state.links = LINKS;
    const loaded = above(draw());
    assert.equal(shape(half), shape(first));
    assert.equal(shape(loaded), shape(first), 'the same row above the customers, only its count changed');
    assert.match(loaded, /<span class="navbadge">6<\/span>/, '4 unassigned, 1 likely duplicate, 1 partner to review');
    assert.match(draw(), /Acme/);
  });

  it('is not there for a member with nothing to review at the first paint, nor when the duplicates come', () => {
    const ctx = load();
    const has = ctx.Review.shown('orgs', MEMBER, { duplicates: 0 });
    assert.equal(has, false);
    const state = orgs(MEMBER, { reviewHas: { orgs: has, teams: false } });
    const draw = sidebar(state);
    const first = above(draw());
    state.dups = PAIRS;
    assert.equal(above(draw()), first);
    assert.doesNotMatch(first, /review:/);
  });

  it('is there for a member with duplicates at the first paint, counting them only', () => {
    const ctx = load();
    const has = ctx.Review.shown('orgs', MEMBER, { duplicates: 2 });
    assert.equal(has, true);
    const state = orgs(MEMBER, { reviewHas: { orgs: has, teams: false } });
    const draw = sidebar(state);
    const first = above(draw());
    assert.match(first, /data-sel="review:"/);
    state.dups = PAIRS;
    const loaded = above(draw());
    assert.equal(shape(loaded), shape(first));
    assert.match(loaded, /<span class="navbadge">1<\/span>/);
  });

  it('is the admin team\'s in Teams, with the unassigned channels and the suggested teams', () => {
    const state = {
      ...orgs(ADMIN),
      tab: 'teams',
      teams: [{ slug: 'edge', name: 'Edge ops', recent: 2 }],
      directory: [{ slug: 'edge', name: 'Edge ops' }],
      unassigned: { channels: 2 },
      reviewHas: { orgs: true, teams: true },
    };
    const draw = sidebar(state);
    const first = above(draw());
    assert.doesNotMatch(first, /navbadge/);
    state.groups = [{ prefix: 'xyz-', people: [] }];
    state.groupsRead = true;
    const loaded = above(draw());
    assert.equal(shape(loaded), shape(first));
    assert.match(loaded, /<span class="navbadge">3<\/span>/);
  });
});

describe('the review\'s queues', () => {
  it('are the admin team\'s, but for the duplicates; nobody\'s off a team', () => {
    const { Review } = load();
    assert.deepEqual([...Review.queues('orgs', ADMIN).map((q) => q.id)], ['unassigned', 'duplicates', 'partners', 'domains']);
    assert.deepEqual([...Review.queues('orgs', MEMBER).map((q) => q.id)], ['duplicates']);
    assert.deepEqual([...Review.queues('orgs', STAFF).map((q) => q.id)], []);
    assert.deepEqual([...Review.queues('teams', ADMIN).map((q) => q.id)], ['unassigned', 'suggested']);
    assert.deepEqual([...Review.queues('teams', MEMBER).map((q) => q.id)], []);
    assert.equal(Review.shown('orgs', STAFF, { duplicates: 3 }), false);
    assert.equal(Review.shown('teams', MEMBER), false);
    assert.equal(Review.shown('orgs', ADMIN, {}), true, 'the admin team has it whatever waits');
  });

  it('count once every queue is counted, Partner domains not at all', () => {
    const { Review } = load();
    assert.equal(Review.total('orgs', ADMIN, { unassigned: 1, duplicates: 2, partners: null }), null);
    assert.equal(Review.total('orgs', ADMIN, { unassigned: 1, duplicates: 2, partners: 3 }), 6);
    assert.equal(Review.total('orgs', MEMBER, { duplicates: 2, partners: null }), 2);
  });

  it('open at the first with something in it, else the first not counted yet', () => {
    const { Review } = load();
    assert.equal(Review.landing('orgs', ADMIN, { unassigned: 0, duplicates: 0, partners: 2 }), 'partners');
    assert.equal(Review.landing('teams', ADMIN, { unassigned: 0, suggested: null }), 'suggested');
    assert.equal(Review.landing('orgs', ADMIN, { unassigned: 0, duplicates: 0, partners: 0 }), 'unassigned');
  });

  it('are the tabs of its page, each with its address and count', () => {
    const { Review } = load();
    const html = Review.tabs({
      tab: 'orgs', me: ADMIN, counts: { unassigned: 4, duplicates: 0, partners: null }, open: 'duplicates', href: (id) => `/inbox/admin?tab=orgs&view=${id}`,
    });
    assert.equal((html.match(/<a /g) || []).length, 4);
    assert.match(html, /href="\/inbox\/admin\?tab=orgs&amp;view=duplicates" data-queue="duplicates"[^>]*aria-current="page"/);
    assert.match(html, /Unassigned channels<\/span><span class="tag">4<\/span>/);
    assert.doesNotMatch(html, /Partner domains<\/span><span class="tag">/);
    assert.equal(Review.queueOf('review:partners'), 'partners');
    assert.equal(Review.queueOf('review:'), '');
    assert.equal(Review.queueOf('acme'), null);
  });
});
