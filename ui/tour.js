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
 * The inbox's tour, as the global `Tour`: a few coach marks, one after the other, that show
 * someone new around. ui/inbox.js offers it once (the `toured` setting, src/settings.js), and
 * your menu's Show me around and /inbox?tour start it again.
 *
 * `steps` says what each stop says, for the inbox as it is on screen (your teams, the view, the
 * pages you have); `run` shows them as Spectrum 2's tour does: a coach mark beside what it is
 * about, a coach indicator around that (its shape, 2px away), "2 of 9", Previous and Next
 * (Finish on the last), and Skip tour and Restart tour in its more actions menu. A stop whose
 * part of the page is not on screen (a phone's filters in their drawer, the bell while viewing
 * as someone) is left out. The tour does not hold the page: what you click works, and the coach
 * mark follows what it points at as the page moves.
 */
globalThis.Tour = (() => {
  /** Between the coach indicator and what it rings, and its width (`.coach-ring`). */
  const RING_GAP = 2;
  const RING = 2;
  /** Between the coach mark and the indicator, and the screen's edge. */
  const GAP = 8;
  const EDGE = 8;
  const MORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';

  /** The pages beyond the inbox a stop names, as ui/header.js lists them. */
  const PAGES = {
    agents: '<b>Agents</b>: what your teams\' thread agents are told and know',
    topics: '<b>Topics</b>: what the threads are about, and who knows each',
    teams: '<b>Teams</b>: members, channels and followed technologies',
    stats: '<b>Stats</b>: the numbers of every thread',
  };

  /**
   * The stops, for the inbox on screen: `teams` (how many you are in), `simple` (the personal
   * view as the simple one), `bell` (not while viewing as someone), `follow` (whether you may
   * follow: not while viewing as someone), `empty` (the personal view has no thread yet, and
   * shows what to follow instead), `pages` (the ids of ui/header.js's pages you have)
   * and `key` (a shortcut as this keyboard names it). Each is
   * `{ id, title, html, at }`: `at` lists where on the page it points, the first one on screen
   * wins, and none is a stop in the middle of the screen.
   */
  function steps({
    teams = 0, simple = false, bell = true, follow = true, empty = false, pages = [],
    key = (k) => k,
  } = {}) {
    const kbd = (k) => `<kbd>${key(k)}</kbd>`;
    const more = pages.map((p) => PAGES[p]).filter(Boolean);
    const out = [
      {
        id: 'welcome',
        title: 'Welcome to Enterprise Support',
        html: teams
          ? '<p>Threads from Slack, Teams, Discord and the customer portal, in one place for you and your teams to answer.</p>'
          : '<p>Threads from Slack, Teams, Discord and the customer portal: the ones you take part in, and the ones about what you follow.</p>',
        at: null,
      },
      {
        id: 'views',
        title: 'Your views',
        html: teams
          ? '<p><b>Personal</b> has the threads you posted in or were mentioned in. Next to it, each of your teams has an inbox, with what needs you most first.</p>'
          : '<p><b>Personal</b> has the threads you posted in or were mentioned in, and the ones about what you follow. Once you are in a team, the team\'s inbox shows up next to Personal.</p>',
        at: ['#threads .order'],
      },
      {
        id: 'filters',
        title: 'Filters',
        html: simple
          ? `<p>Pick a customer to see only their threads. ${teams ? 'Your teams\' inboxes and the expert view (in your menu) have' : 'The expert view (in your menu) has'} more filters.</p>`
          : `<p>Click a value to filter; ${kbd('⇧')} click or ≠ to exclude. <b>Waiting on</b> shows whose move it is.</p>`,
        at: ['#filters', '#threads [data-filters]'],
      },
      {
        id: 'search',
        title: 'Search',
        html: teams ? `<p>${kbd('/')} searches your teams' threads.</p>`
          : `<p>${kbd('/')} searches the threads of your personal view.</p>`,
        at: ['#threads .find'],
      },
    ];
    // An empty view has no thread to go through yet: the stop about what to follow says why.
    if (!empty) {
      out.splice(
        3,
        0,
        {
          id: 'threads',
          title: 'What needs you',
          html: simple
            ? `<p>Your threads, the latest first. ${kbd('j')} and ${kbd('k')} move between them.</p>`
            : `<p>The icon shows the kind of thread, the color its status. ${kbd('j')} and ${kbd('k')} move between threads.</p>`,
          at: ['#threads .rows'],
        },
      );
    }
    if (bell) {
      out.push({
        id: 'bell',
        title: 'A bell for this view',
        html: '<p>Get notified of new messages in this view, with the current filters. Mentions and replies in your threads always notify you.</p>',
        at: ['#threads [data-bell]'],
      });
    }
    out.push(
      {
        id: 'thread',
        title: 'The thread',
        html: teams
          ? `<p>Reply at the bottom. React with 👀 to take a thread on, or 🛟 to ask your team for help. ${kbd('e')} resolves the thread.</p>`
          : `<p>Reply at the bottom, as yourself. React with 👀 to take a thread on. ${kbd('e')} resolves the thread.</p>`,
        at: ['#pane'],
      },
      {
        id: 'agent',
        title: 'The Thread Agent',
        html: `<p>The agent drafts replies above the reply box, for you to send, edit or discard. Ask the agent anything in the sidebar (${kbd('a')}); nothing there is posted.</p>`,
        at: ['#pane .sidebtn', '#draftbar', '#pane'],
      },
    );
    if (follow) {
      out.push({
        id: 'follow',
        title: 'Follow what you work on',
        html: `<p>Follow a product, topic, customer or person to see their threads in <b>Personal</b>.${teams ? '' : ' On no team, this is how threads come here.'} ${empty ? 'These are suggested for you; <b>Find something to follow</b> in your menu has more.' : '<b>Find something to follow</b> in your menu has suggestions.'}</p>`,
        at: ['#threads .getstarted', '#user'],
      });
    }
    if (more.length) {
      out.push({
        id: 'pages',
        title: 'Beyond the inbox',
        html: `<ul>${more.map((p) => `<li>${p}</li>`).join('')}</ul>`,
        at: ['#pages'],
      });
    }
    out.push({
      id: 'menu',
      title: 'Your menu',
      html: `<p>Notifications, what you follow, the expert view and keyboard shortcuts (${kbd('⌘/')}). <b>Show me around</b> restarts this tour.</p>`,
      at: ['#user'],
    });
    return out;
  }

  /**
   * Where a coach mark of size `card` goes beside `box` (what it points at, a DOMRect-like
   * box, or null for the middle of the screen) on a screen `view` wide and high: `{ left, top,
   * side }`. Beside something tall, below or above something wide, on whichever side has room;
   * inside it, at its top right, when none has (the thread, on a small screen). Never off the
   * screen.
   */
  function place(card, box, view, gap = GAP + RING_GAP + RING, edge = EDGE) {
    const clampX = (x) => Math.max(edge, Math.min(x, view.w - card.w - edge));
    const clampY = (y) => Math.max(edge, Math.min(y, view.h - card.h - edge));
    if (!box) return { side: 'center', left: clampX((view.w - card.w) / 2), top: clampY((view.h - card.h) / 2) };
    const room = {
      right: view.w - box.right - gap - edge >= card.w,
      left: box.left - gap - edge >= card.w,
      below: view.h - box.bottom - gap - edge >= card.h,
      above: box.top - gap - edge >= card.h,
    };
    const tall = box.bottom - box.top > box.right - box.left;
    const order = tall ? ['right', 'left', 'below', 'above'] : ['below', 'above', 'right', 'left'];
    const side = order.find((s) => room[s]);
    if (side === 'right') return { side, left: box.right + gap, top: clampY(box.top) };
    if (side === 'left') return { side, left: box.left - gap - card.w, top: clampY(box.top) };
    if (side === 'below') return { side, left: clampX(box.left), top: box.bottom + gap };
    if (side === 'above') return { side, left: clampX(box.left), top: box.top - gap - card.h };
    return { side: 'inside', left: clampX(box.right - card.w - gap), top: clampY(box.top + gap) };
  }

  /** Whether `el` is on screen, at least in part. */
  function shown(el, win) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
      && r.left < win.innerWidth && r.top < win.innerHeight;
  }

  /**
   * Shows the stops one after the other, from the first; `onEnd(how)` once it is over: `done`
   * (Finish), `skip` (Skip tour, or Escape). Answers `{ stop }`, which ends it as skipped.
   */
  function run(list, { onEnd = () => {}, doc = document, win = window } = {}) {
    const target = (s) => (s.at || []).map((q) => doc.querySelector(q)).find((el) => shown(el, win)) || null;
    const stops = list.filter((s) => !s.at || target(s));
    const back = doc.activeElement;
    const card = doc.createElement('div');
    card.className = 'coach';
    card.popover = 'manual';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'coach-title');
    card.setAttribute('aria-describedby', 'coach-text');
    card.innerHTML = `<div class="cm-head"><h2 id="coach-title"></h2>
      <button class="cm-more" type="button" popovertarget="coach-menu" aria-haspopup="menu" aria-label="More actions" title="More actions">${MORE}</button>
      <div class="coach-menu" id="coach-menu" popover role="menu"><button type="button" role="menuitem" data-tour="restart">Restart tour</button><button type="button" role="menuitem" data-tour="skip">Skip tour</button></div></div>
      <div class="cm-text" id="coach-text" aria-live="polite"></div>
      <div class="cm-foot"><span class="cm-step"></span><span class="cm-acts"><button type="button" class="cm-prev" data-tour="prev">Previous</button><button type="button" class="primary" data-tour="next"></button></span></div>`;
    const ring = doc.createElement('div');
    ring.className = 'coach-ring';
    ring.popover = 'manual';
    ring.setAttribute('aria-hidden', 'true');
    doc.body.append(ring, card);
    const $ = (sel) => card.querySelector(sel);
    const menu = $('.coach-menu');
    let at = 0;
    let frame = 0;
    let last = '';
    let over = false;

    // Where the coach mark and its indicator are, every frame while it is open: what it points
    // at may move (a drawer, a thread opening), or be drawn anew (the list's heading).
    function follow() {
      const el = stops[at].at ? target(stops[at]) : null;
      const r = el?.getBoundingClientRect();
      const pad = RING_GAP + RING;
      const box = r && {
        left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad,
      };
      const size = { w: card.offsetWidth, h: card.offsetHeight };
      const p = place(size, box, { w: win.innerWidth, h: win.innerHeight });
      const key = JSON.stringify([box, p, size]);
      if (key !== last) {
        last = key;
        card.style.left = `${Math.round(p.left)}px`;
        card.style.top = `${Math.round(p.top)}px`;
        card.dataset.side = p.side;
        ring.classList.toggle('off', !box);
        if (box) {
          ring.style.left = `${Math.round(box.left)}px`;
          ring.style.top = `${Math.round(box.top)}px`;
          ring.style.width = `${Math.round(box.right - box.left)}px`;
          ring.style.height = `${Math.round(box.bottom - box.top)}px`;
          const round = parseFloat(win.getComputedStyle(el).borderTopLeftRadius) || 0;
          ring.style.borderRadius = `${Math.round(round + pad)}px`;
        }
      }
      frame = win.requestAnimationFrame(follow);
    }

    function show(i) {
      at = Math.max(0, Math.min(i, stops.length - 1));
      const s = stops[at];
      $('#coach-title').textContent = s.title;
      $('#coach-text').innerHTML = s.html;
      $('.cm-step').textContent = `${at + 1} of ${stops.length}`;
      $('.cm-prev').hidden = at === 0;
      $('[data-tour="next"]').textContent = at === stops.length - 1 ? 'Finish' : 'Next';
      card.dataset.stop = s.id;
      last = '';
      $('[data-tour="next"]').focus();
    }

    function stop(how) {
      if (over) return;
      over = true;
      win.cancelAnimationFrame(frame);
      for (const el of [menu, card, ring]) {
        try { el.hidePopover(); } catch { /* not open */ }
      }
      card.remove();
      ring.remove();
      if (back?.isConnected) back.focus?.();
      onEnd(how);
    }

    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-tour]')?.dataset.tour;
      if (!act) return;
      if (act !== 'next' && act !== 'prev') menu.hidePopover();
      if (act === 'next') {
        if (at === stops.length - 1) stop('done'); else show(at + 1);
      } else if (act === 'prev') show(at - 1);
      else if (act === 'restart') show(0);
      else if (act === 'skip') stop('skip');
    });
    // Its keys are its own: the inbox's (j, k, e…) do not act on the page behind it.
    card.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !menu.matches(':popover-open')) { e.preventDefault(); stop('skip'); }
      if (e.target.closest('.coach-menu')) return;
      if (e.key === 'ArrowRight' && at < stops.length - 1) { e.preventDefault(); show(at + 1); }
      if (e.key === 'ArrowLeft' && at > 0) { e.preventDefault(); show(at - 1); }
    });
    // The more actions menu, under its button, its end with the button's, before it shows.
    menu.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'open') return;
      const b = $('.cm-more').getBoundingClientRect();
      menu.style.right = `${Math.round(Math.max(EDGE, win.innerWidth - b.right))}px`;
      menu.style.top = `${Math.round(b.bottom + RING_GAP * 2)}px`;
    });
    menu.addEventListener('toggle', (e) => { if (e.newState === 'open') menu.querySelector('button').focus(); });

    ring.showPopover();
    card.showPopover();
    show(0);
    follow();
    return { stop: () => stop('skip') };
  }

  return { steps, place, run };
})();
