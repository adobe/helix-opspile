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
 * The inbox's tour (ui/tour.js, `Tour`): what its stops say for the inbox on screen, where a
 * coach mark goes beside what it points at, and how the inbox (ui/inbox.js) offers it: once,
 * kept in the `toured` setting, never while viewing as someone, and again from your menu.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAGES, SCRIPTS } from './ui.js';

// eslint-disable-next-line no-new-func
const Tour = new Function('globalThis', `${SCRIPTS['tour.js']}\nreturn globalThis.Tour;`)({});
const ids = (steps) => steps.map((s) => s.id);
const text = (steps, id) => steps.find((s) => s.id === id).html;

describe('the tour', () => {
  it('stops at the views, filters, threads, search, bell, thread, agent, follows, pages and your menu', () => {
    const steps = Tour.steps({ teams: 2, pages: ['inbox', 'agents', 'topics'] });
    assert.deepEqual(ids(steps), ['welcome', 'views', 'filters', 'threads', 'search', 'bell', 'thread', 'agent', 'follow', 'pages', 'menu']);
    // At most about ten stops, each with its own title, as S2's tours have.
    assert.equal(new Set(steps.map((s) => s.title)).size, steps.length);
    assert.equal(steps[0].at, null);
    assert.ok(steps.slice(1).every((s) => s.at.length));
    // Your menu is the last stop, and says where the tour is again.
    assert.match(text(steps, 'menu'), /<b>Show me around<\/b>/);
  });

  it('says what is on screen: the simple personal view, no team yet, no bell, your pages', () => {
    const simple = Tour.steps({
      teams: 0, simple: true, bell: false, pages: ['inbox'],
    });
    assert.deepEqual(ids(simple), ['welcome', 'views', 'filters', 'threads', 'search', 'thread', 'agent', 'follow', 'menu']);
    assert.match(text(simple, 'views'), /Once you are in a team/);
    // On no team, nothing speaks of your team: following is how threads come.
    for (const s of simple) {
      assert.doesNotMatch(s.html, /your team/i, s.id);
    }
    assert.match(text(simple, 'follow'), /On no team, this is how threads come here/);
    assert.match(text(simple, 'search'), /your personal view/);
    // An empty personal view: no thread to go through, and the suggestions are on screen.
    const empty = Tour.steps({ teams: 0, empty: true });
    assert.ok(!ids(empty).includes('threads'));
    assert.match(text(empty, 'follow'), /These are suggested/);
    // Viewing as someone, there is nothing to follow.
    assert.ok(!ids(Tour.steps({ follow: false })).includes('follow'));
    assert.match(text(simple, 'filters'), /Pick a customer/);
    assert.match(text(simple, 'threads'), /the latest first/);
    const team = Tour.steps({ teams: 1, pages: ['inbox', 'agents', 'teams', 'orgs', 'stats'] });
    assert.match(text(team, 'views'), /each of your teams has an inbox/);
    assert.match(text(team, 'filters'), /<b>Waiting on<\/b>/);
    // The pages a person has, beyond the inbox; the admin team's own are not explained.
    assert.equal((text(team, 'pages').match(/<li>/g) || []).length, 3);
    assert.doesNotMatch(text(team, 'pages'), /Orgs/);
  });

  it('names the keys as this keyboard does', () => {
    const key = (k) => k.replace('⌘', 'Ctrl+').replace('⇧', 'Shift');
    const steps = Tour.steps({ teams: 1, key });
    assert.match(text(steps, 'menu'), /<kbd>Ctrl\+\/<\/kbd>/);
    assert.match(text(steps, 'filters'), /<kbd>Shift<\/kbd> click/);
  });

  it('puts a coach mark beside what it points at, where there is room, never off the screen', () => {
    const view = { w: 1400, h: 900 };
    const card = { w: 300, h: 200 };
    // The middle of the screen, for the welcome.
    assert.deepEqual(Tour.place(card, null, view, 12), { side: 'center', left: 550, top: 350 });
    // Something tall (the filters): to its right.
    assert.deepEqual(Tour.place(card, {
      left: 0, top: 50, right: 280, bottom: 900,
    }, view, 12), { side: 'right', left: 292, top: 50 });
    // Something wide (the view switch): below it, and kept on screen at the right edge (your menu).
    assert.deepEqual(Tour.place(card, {
      left: 1250, top: 4, right: 1396, bottom: 52,
    }, view, 12), { side: 'below', left: 1092, top: 64 });
    // Tall at the right edge (the thread): to its left.
    assert.equal(Tour.place(card, {
      left: 700, top: 50, right: 1400, bottom: 900,
    }, view, 12).side, 'left');
    // No room around it (the thread on a phone): inside it, at its top right.
    assert.deepEqual(Tour.place(card, {
      left: 0, top: 50, right: 390, bottom: 800,
    }, { w: 390, h: 800 }, 12), { side: 'inside', left: 78, top: 62 });
  });

  it('is offered once, in a toast, and from your menu again; not while viewing as someone', () => {
    const html = PAGES['inbox.html'];
    assert.ok(html.indexOf('<script src="tour.js">') < html.indexOf('<script type="module" src="inbox.js">'));
    assert.match(html, /<button class="item" id="tourAgain"[^>]*>.*Show me around<\/button>/);
    const js = SCRIPTS['inbox.js'];
    assert.match(js, /const tourDue = \(\) => !state\.as && state\.settings\?\.toured === false;/);
    assert.match(js, /stay: true, dismiss: \{ label: 'No thanks', run: \(\) => saveSettings\(\{ toured: true \}\) \}/);
    assert.match(js, /if \(tourDue\(\)\) saveSettings\(\{ toured: true \}\);\n {2}touring = Tour\.run\(/);
    // The notification question waits for the tour, as two toasts would replace each other.
    assert.match(js, /if \(!tourDue\(\)\) askNotifyOnce\(\);/);
    // Its keys are its own: j, k and e do not act on the inbox behind it.
    assert.match(SCRIPTS['tour.js'], /card\.addEventListener\('keydown', \(e\) => \{\n {6}e\.stopPropagation\(\);/);
  });
});
