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
 * The simple personal view (ui/inbox.js, `simple` and GROUPS): the customer column, the list
 * by customer, picking a customer and going back to all of them, the red badge as threads are
 * read, Mentions (the @ switch), and the switch to the expert view. The page's own code, in
 * two pieces, run in Node with what they need of the rest of the page stubbed.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const html = SCRIPTS['inbox.js'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${html.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const NAMES = { acme: 'ACME', globex: 'Globex', initech: 'Initech' };
const ICONS = { acme: 'acme.example', globex: 'globex.example' };
const FACETS = [
  { id: 'customer', value: (t) => t.org },
  { id: 'platform', value: (t) => t.source },
];

/** The viewer's person id. */
const ME = 7;
/**
 * The inbox: three customers, the latest activity first; two unread threads mention the viewer,
 * a read one did, and one mentions someone else.
 */
const inbox = () => [
  ['a1', 'acme', '2026-11-05T10:00Z', { unread: true, unreadMentions: 2, mentionedMe: true }],
  ['g1', 'globex', '2026-11-05T09:30Z', { unread: true }],
  ['a2', 'acme', '2026-11-05T09:00Z', { unread: true }],
  ['g2', 'globex', '2026-11-05T08:00Z', { unread: true, unreadMentions: 1, mentionedMe: true }],
  ['a3', 'acme', '2026-11-04T12:00Z', { mentioned: [{ person: ME, staff: true }] }],
  ['i1', 'initech', '2026-11-03T12:00Z', { source: 'teams', mentioned: [{ person: 8, staff: true }] }],
  ['a4', 'acme', '2026-11-02T12:00Z', {}],
  ['x1', 'acme', '2026-11-05T11:00Z', { kind: 'alert', unread: true }],
].map(([thread, org, at, more]) => ({
  thread,
  org,
  org_name: NAMES[org],
  customerDomain: ICONS[org] || null,
  title: `Thread ${thread}`,
  last_at: at,
  any_at: at,
  messages: 1,
  root_known: true,
  unread: false,
  unreadMentions: 0,
  mentionedMe: false,
  source: 'slack',
  ...more,
}));

let state;
let views;
let page;

/** The two pieces, sharing `state`: which view is on screen, then the column and the list. */
function load() {
  views = piece('const PERSONAL_FACETS', "/**\n * A facet row's bar", 'personal, expertOn, simple, viewFacets, passes, toggleFilter, mentionsOn', {
    FACETS, state, pass: null, keptUnread: (t) => t.unread, viewerId: () => ME,
  });
  const activityOf = (t) => String(t.last_at || t.any_at || '');
  page = piece('const GROUPS = {', '/** Markdown as one line', 'GROUPS, simpleCustomers, row, grouped, groupPlan, groupHtml, youCount', {
    state,
    esc,
    listed: () => state.data.threads,
    passes: views.passes,
    simple: views.simple,
    searching: () => Boolean(state.search.q),
    activityOf,
    customerName: (v) => NAMES[v] || v,
    orgName: (t) => t.org_name || t.org,
    orgIcon: (t) => t.customerDomain,
    favicon: (d) => `https://icons.test/${d}`,
    tile: (name) => `<span class="ico av">${esc(name[0])}</span>`,
    preview: () => null,
    ago: () => '1h',
    draftBy: () => 'you',
    hitLine: () => '',
    marked: (s) => esc(s),
    EMOJI_CODE: /:([a-z0-9_+-]+):/g,
    emojiHtml: () => '',
    Markdown: { emojiAlone: () => false },
    statusOf: () => 'quiet',
    checked: () => false,
    resolvedOf: () => 'open',
    STATUS_HINT: { quiet: 'Quiet' },
    urgencyOf: () => 'low',
    kindOf: () => 'question',
    KIND_EMOJI: { question: '❓' },
    avatar: (name) => `<span class="av">${esc(name)}</span>`,
    profileKey: () => '',
    AT: '<svg/>',
  });
}

/** The list as the page lays it out: what passes, latest activity first, by customer. */
function list() {
  const shown = state.data.threads.filter((t) => views.passes(t))
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
  return page.grouped() ? page.groupPlan(shown) : shown.map((t) => ({ t }));
}
/** The list, in words: `# acme` a heading, `a1` a row, `+2 acme` its "N more". */
const outline = () => list().map((x) => {
  if (x.head) {
    return `# ${x.head}`;
  }
  if (x.more) {
    return `+${x.n} ${x.more}`;
  }
  if (x.quiet) {
    return `quiet ${x.quiet.join(' ')}`;
  }
  return x.t.thread;
});
/** The red badge in a piece of HTML, or null. */
const badge = (s) => (/<b class="men"[^>]*>([^<]*)<\/b>/.exec(s) || [])[1] || null;
/** The customer column's row of `v` (`''`: All customers). */
function columnRow(v) {
  const col = page.simpleCustomers();
  const re = v ? new RegExp(`<div class="fr[^"]*" data-f="customer" data-v="${v}"[\\s\\S]*?</div>`)
    : /<div class="fr all[^"]*"[\s\S]*?<\/div>/;
  return (re.exec(col) || [])[0] || '';
}
const rowOf = (key) => page.row(state.data.threads.find((t) => t.thread === key));
/** Reading a thread, as `markRead` leaves it. */
function read(key) {
  Object.assign(state.data.threads.find((t) => t.thread === key), {
    unread: false, unseen: false, mentionedMe: false, unreadMentions: 0,
  });
}
/** A click on a customer's heading (or its row in the column): it picks it, or lets it go. */
const pick = (v) => views.toggleFilter('customer', v, false);

beforeEach(() => {
  state = {
    sort: 'personal',
    settings: { expert: false },
    unread: false,
    mentions: false,
    sel: {},
    not: {},
    open: null,
    prevKeys: null,
    search: { q: '', words: [] },
    list: { grouped: null },
    data: { threads: inbox() },
  };
  load();
});

describe('the simple personal view', () => {
  describe('the expert view', () => {
    it('is the personal view unless the expert setting is on; team views are as they were', () => {
      assert.equal(views.simple(), true);
      assert.deepEqual(views.viewFacets().map((f) => f.id), ['customer']);
      state.settings.expert = true;
      assert.equal(views.simple(), false);
      assert.deepEqual(views.viewFacets().map((f) => f.id), ['customer', 'platform']);
      state.settings.expert = false;
      state.sort = 'team';
      assert.equal(views.simple(), false);
      assert.deepEqual(views.viewFacets(), FACETS);
      // Without settings yet (they come with /api/me), it is the simple one.
      state.sort = 'personal';
      state.settings = null;
      assert.equal(views.simple(), true);
    });

    it('draws simple rows, and the expert view\'s rows with status and people once switched', () => {
      const t = state.data.threads.find((x) => x.thread === 'a1');
      t.participants = [{ name: 'Sam Reyes' }];
      let r = page.row(t);
      assert.match(r, /^<div class="t unread[^"]* mention simple"/);
      assert.doesNotMatch(r, /class="faces"|class="dot|class="cust"|mentions<\/b>/);
      assert.equal(badge(r), '2');
      state.settings.expert = true;
      r = page.row(t);
      assert.doesNotMatch(r, / simple"/);
      assert.match(r, /class="dot/);
      assert.match(r, /<span class="faces"><span class="av">Sam Reyes<\/span><\/span>/);
      assert.match(r, /<span class="cust">[\s\S]*ACME<\/span>/);
      assert.match(r, /<b class="men" title="Unread mentions of you">2 mentions<\/b>/);
      // The list by customer is the simple view's only.
      assert.equal(page.grouped(), false);
    });

    it('filters by customer only: a platform picked in the expert view is kept, not applied', () => {
      state.sel.platform = new Set(['teams']);
      assert.deepEqual(outline().filter((x) => !x.startsWith('#')), ['a1', 'a2', 'a3', 'a4', 'g1', 'g2', 'i1']);
      state.settings.expert = true;
      assert.deepEqual(outline(), ['i1']);
      assert.deepEqual([...state.sel.platform], ['teams']);
    });
  });

  describe('the list by customer', () => {
    it('puts every thread under its customer, the customers in the order of their latest activity', () => {
      assert.equal(page.GROUPS.fold, 'all');
      assert.deepEqual(outline(), ['# acme', 'a1', 'a2', 'a3', 'a4', '# globex', 'g1', 'g2', '# initech', 'i1']);
    });

    it('leaves alerts out, and the customer out of the rows: the heading names it', () => {
      assert.ok(!outline().includes('x1'));
      assert.doesNotMatch(rowOf('a2'), /class="cust"/);
      const head = page.groupHtml(list()[0]);
      assert.match(head, /^<button type="button" class="grp new sticky" data-group="acme" title="Only ACME">/);
      assert.match(head, /<span class="logo"><span class="ico av">A<\/span><img src="https:\/\/icons.test\/acme.example" alt="" loading="lazy"><\/span>/);
      assert.match(head, /<span class="nm">ACME<\/span>/);
      // A customer without an icon has its initial.
      assert.match(page.groupHtml(list().find((x) => x.head === 'initech')), /<span class="logo"><span class="ico av">I<\/span><\/span>/);
    });

    it('sets apart the customers with unread threads, and carries no badge on the heading', () => {
      const heads = list().filter((x) => x.head).map(page.groupHtml);
      assert.deepEqual(heads.map((h) => /class="grp( new)?/.exec(h)[1] || ''), [' new', ' new', '']);
      assert.ok(heads.every((h) => !badge(h)));
    });

    it('is a search\'s results as they come, not by customer', () => {
      state.search.q = 'preview';
      assert.equal(page.grouped(), false);
      assert.deepEqual(outline(), ['a1', 'g1', 'a2', 'g2', 'a3', 'i1', 'a4']);
      // A result names its customer: there is no heading over it.
      const hit = { matched: ['title'] };
      assert.match(page.row(state.data.threads.find((t) => t.thread === 'a2'), hit), /<span class="cust">ACME<\/span>/);
    });

    it('folds, in the other designs: three per customer, or only what is new', () => {
      page.GROUPS.fold = 'three';
      assert.deepEqual(outline(), ['# acme', 'a1', 'a2', 'a3', '+1 acme', '# globex', 'g1', 'g2', '# initech', 'i1']);
      // A thread shown once stays while the list lasts, read or not.
      state.list.grouped = null;
      page.GROUPS.fold = 'new';
      assert.deepEqual(outline(), ['# acme', 'a1', 'a2', '+2 acme', '# globex', 'g1', 'g2', 'quiet initech']);
      read('a2');
      assert.deepEqual(outline().slice(0, 4), ['# acme', 'a1', 'a2', '+2 acme']);
      page.GROUPS.fold = 'all';
    });
  });

  describe('picking a customer', () => {
    it('shows only its threads, all of them, under its heading that leads back', () => {
      pick('globex');
      assert.deepEqual([...state.sel.customer], ['globex']);
      assert.deepEqual(outline(), ['# globex', 'g1', 'g2']);
      const head = page.groupHtml(list()[0]);
      assert.match(head, /title="Back to all customers"/);
      assert.match(head, /<span class="back">All customers<\/span><\/button>$/);
      assert.match(columnRow('globex'), /^<div class="fr on"/);
      assert.match(columnRow(''), /^<div class="fr all"/);
    });

    it('picks one customer at a time', () => {
      pick('globex');
      pick('acme');
      assert.deepEqual([...state.sel.customer], ['acme']);
      assert.deepEqual(outline(), ['# acme', 'a1', 'a2', 'a3', 'a4']);
    });

    it('goes back to all customers from its heading, or from All customers in the column', () => {
      pick('globex');
      pick('globex');
      assert.equal(state.sel.customer, undefined);
      assert.deepEqual(outline()[0], '# acme');
      assert.match(columnRow(''), /^<div class="fr all on" data-clear="1">/);
      // All customers is the card's clear (data-clear), which drops the pick.
      pick('acme');
      delete state.sel.customer;
      assert.equal(outline().filter((x) => x.startsWith('#')).length, 3);
    });

    it('keeps every customer in the column, a picked one too', () => {
      pick('initech');
      const col = page.simpleCustomers();
      assert.deepEqual([...col.matchAll(/data-v="([^"]+)"/g)].map((m) => m[1]), ['acme', 'globex', 'initech']);
    });
  });

  describe('the customer column', () => {
    const column = () => [...page.simpleCustomers().matchAll(/data-v="([^"]+)"/g)].map((m) => m[1]);

    it('puts the customers with unread mentions first, then the unread ones, then the rest', () => {
      assert.deepEqual(column(), ['acme', 'globex', 'initech']);
      // ACME has unread threads still, Globex a mention.
      read('a1');
      assert.deepEqual(column(), ['globex', 'acme', 'initech']);
      // Both unread, no mentions: by name.
      read('g2');
      assert.deepEqual(column(), ['acme', 'globex', 'initech']);
      read('a2');
      assert.deepEqual(column(), ['globex', 'acme', 'initech']);
      read('g1');
      assert.deepEqual(column(), ['acme', 'globex', 'initech']);
    });

    it('puts the most mentions first, and goes by name, not by latest activity, within a pile', () => {
      const i1 = state.data.threads.find((t) => t.thread === 'i1');
      Object.assign(i1, { unread: true, unreadMentions: 5, mentionedMe: true });
      assert.deepEqual(column(), ['initech', 'acme', 'globex']);
      i1.unreadMentions = 2;
      // ACME and Initech have two each: by name.
      assert.deepEqual(column(), ['acme', 'initech', 'globex']);
      state.data.threads.find((t) => t.thread === 'g1').last_at = '2026-11-06T10:00Z';
      assert.deepEqual(column(), ['acme', 'initech', 'globex']);
    });
  });

  describe('the red badge', () => {
    it('counts the unread messages that mention you: beside each customer, in all, and on the rows', () => {
      assert.equal(badge(columnRow('acme')), '2');
      assert.equal(badge(columnRow('globex')), '1');
      assert.equal(badge(columnRow('initech')), null);
      assert.equal(badge(columnRow('')), '3');
      assert.equal(badge(rowOf('a1')), '2');
      assert.equal(badge(rowOf('g2')), '1');
      assert.equal(badge(rowOf('a2')), null);
      assert.match(columnRow('acme'), /title="2 unread messages mention you"/);
      assert.match(rowOf('g2'), /title="1 unread message mentions you"/);
    });

    it('goes from the row and its customer once the thread is read, and the row stays', () => {
      read('a1');
      assert.equal(badge(rowOf('a1')), null);
      assert.doesNotMatch(rowOf('a1'), /class="t unread| mention/);
      assert.equal(badge(columnRow('acme')), null);
      assert.equal(badge(columnRow('')), '1');
      assert.deepEqual(outline().slice(0, 2), ['# acme', 'a1']);
      read('g2');
      assert.equal(badge(columnRow('')), null);
      assert.equal(badge(columnRow('globex')), null);
    });

    it('is never on a thread you have read, whatever else the thread still says', () => {
      Object.assign(state.data.threads.find((t) => t.thread === 'a1'), { unread: false });
      assert.equal(badge(rowOf('a1')), null);
      assert.equal(badge(columnRow('acme')), null);
      assert.equal(badge(columnRow('')), '1');
    });

    it('counts a mention the inbox has no count for as one, and caps at 99+', () => {
      Object.assign(state.data.threads.find((t) => t.thread === 'g1'), { mentionedMe: true });
      assert.equal(badge(rowOf('g1')), '1');
      assert.equal(badge(columnRow('globex')), '2');
      state.data.threads.find((t) => t.thread === 'a1').unreadMentions = 120;
      assert.equal(badge(columnRow('acme')), '99+');
    });

    it('sets the names of customers with unread threads in bold, until they are read', () => {
      assert.match(columnRow('globex'), /<span class="lab new">Globex<\/span>/);
      assert.match(columnRow('initech'), /<span class="lab">Initech<\/span>/);
      read('g1');
      read('g2');
      assert.match(columnRow('globex'), /<span class="lab">Globex<\/span>/);
      assert.match(page.groupHtml(list().find((x) => x.head === 'globex')), /class="grp sticky"/);
    });
  });

  describe('mentions', () => {
    const rows = () => outline().filter((x) => !x.startsWith('#'));

    it('is off unless asked for: every thread, every customer', () => {
      assert.equal(views.mentionsOn(), false);
      assert.deepEqual(rows(), ['a1', 'a2', 'a3', 'a4', 'g1', 'g2', 'i1']);
    });

    it('keeps the threads that mention you, read or not, under their customers', () => {
      state.mentions = true;
      assert.equal(views.mentionsOn(), true);
      assert.deepEqual(outline(), ['# acme', 'a1', 'a3', '# globex', 'g2']);
      // The column keeps only the customers that mention you, with their badges.
      const col = page.simpleCustomers();
      assert.deepEqual([...col.matchAll(/data-v="([^"]+)"/g)].map((m) => m[1]), ['acme', 'globex']);
      assert.equal(badge(columnRow('')), '3');
    });

    it('keeps a thread once you read it: its mention stays in the thread', () => {
      state.mentions = true;
      Object.assign(state.data.threads.find((t) => t.thread === 'g2'), {
        unread: false,
        mentionedMe: false,
        unreadMentions: 0,
        mentioned: [{ person: ME, staff: true }],
      });
      assert.deepEqual(rows(), ['a1', 'a3', 'g2']);
    });

    it('with unread only, is what the red badge counts', () => {
      state.mentions = true;
      state.unread = true;
      assert.deepEqual(rows(), ['a1', 'g2']);
    });

    it('goes with a customer picked', () => {
      state.mentions = true;
      pick('globex');
      assert.deepEqual(outline(), ['# globex', 'g2']);
    });

    it('is the @ at the top right of the customers, filled while it filters', () => {
      assert.match(page.simpleCustomers(), /<h3>Customers<button class="atme" type="button" data-atme aria-pressed="false" title="Show only threads that mention you"/);
      state.mentions = true;
      assert.match(page.simpleCustomers(), /<h3>Customers<button class="atme" type="button" data-atme aria-pressed="true" title="Showing only threads that mention you"/);
    });

    it('filters nothing in a team\'s view', () => {
      state.mentions = true;
      state.sort = 'team';
      assert.equal(views.mentionsOn(), false);
      assert.ok(state.data.threads.filter((t) => t.kind !== 'alert').every((t) => views.passes(t)));
    });
  });
});
