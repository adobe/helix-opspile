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
 * The work that waits in Teams and in Customers (the global `Review`): its queues, one entry at
 * the top of the sidebar for all of them, and the tabs of its page (ui/admin.js draws the queues).
 *
 * The entry is one row of the sidebar's (ui/sidenav.js), as tall as any, drawn from the first
 * paint whether or not its count is known yet: what loads after (the duplicates, the partners, the
 * suggested teams, which Clef is asked about) changes its count, never what is under it. Whether it
 * is there at all is decided at the first paint too (`shown`), from what is known then: the admin
 * team always has it; anyone else only where something waits for them (`hint`, the duplicates
 * GET /api/admin/orgs counts from what it keeps), and it does not come or go until the page loads
 * again.
 *
 * Its count is the sum of its queues' (`total`), shown once all of them are counted: the
 * unassigned channels (counted with the lists), the likely duplicates, the partners to review and
 * the suggested teams. Partner domains is a tool, not a queue: it counts nothing.
 */
globalThis.Review = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  /** What is picked when the page or a queue of it is open: `review:`, `review:<queue>`. */
  const PREFIX = 'review:';

  /**
   * The queues of each list, in the order of their tabs: `admin`'s are the admin team's, the
   * others every ops team member's; `counted: false` adds nothing to the count.
   */
  const QUEUES = {
    orgs: [
      {
        id: 'unassigned', label: 'Unassigned channels', admin: true, title: 'Channels not filed under an org',
      },
      { id: 'duplicates', label: 'Duplicates', title: 'Orgs that may be one' },
      {
        id: 'partners', label: 'Likely partners', admin: true, title: 'Partners that may work for a customer',
      },
      {
        id: 'domains', label: 'Partner domains', admin: true, counted: false, title: 'Mail domains of partners\' people',
      },
    ],
    teams: [
      {
        id: 'unassigned', label: 'Unassigned channels', admin: true, title: 'Channels not filed under a team',
      },
      {
        id: 'suggested', label: 'Suggested teams', admin: true, title: 'Groups of the admin team\'s channels that look like a team of their own',
      },
    ],
  };

  const sel = (queue = '') => `${PREFIX}${queue}`;
  const is = (s) => String(s ?? '').startsWith(PREFIX);
  /** The queue `s` picks (`''` for the page), or null when it is no review's. */
  const queueOf = (s) => (is(s) ? String(s).slice(PREFIX.length) : null);

  /** The queues `me` has in list `tab` (`teams`, `orgs`). */
  function queues(tab, me) {
    const onTeam = Boolean(me?.admin) || (me?.teams || []).length > 0;
    return (QUEUES[tab] || []).filter((q) => (q.admin ? Boolean(me?.admin) : onTeam));
  }
  const queue = (tab, me, id) => queues(tab, me).find((q) => q.id === id) || null;

  /**
   * Whether list `tab` has the entry, from what is known at its first paint: the admin team's
   * always, anyone else's where `hint` (counts by queue) says something waits.
   */
  function shown(tab, me, hint = {}) {
    const list = queues(tab, me);
    if (!list.length) return false;
    if (me.admin) return true;
    return list.some((q) => q.counted !== false && (hint[q.id] || 0) > 0);
  }

  /** The sum of the counted queues' `counts`, or null while one of them is not known yet. */
  function total(tab, me, counts = {}) {
    let n = 0;
    for (const q of queues(tab, me)) {
      if (q.counted !== false) {
        const c = counts[q.id];
        if (c === null || c === undefined) return null;
        n += c;
      }
    }
    return n;
  }

  /**
   * The queue the page opens at: the first with something in it, else the first not counted yet
   * (Clef may still find something there), else the first.
   */
  function landing(tab, me, counts = {}) {
    const list = queues(tab, me).filter((q) => q.counted !== false);
    const unknown = (q) => counts[q.id] === null || counts[q.id] === undefined;
    const q = list.find((x) => counts[x.id] > 0) || list.find(unknown) || queues(tab, me)[0];
    return q ? q.id : null;
  }

  /** The entry's title: what each queue holds, or that it is still counted. */
  function says(tab, me, counts) {
    return queues(tab, me).filter((q) => q.counted !== false).map((q) => {
      const c = counts[q.id];
      return `${q.label}: ${c === null || c === undefined ? 'counting…' : c}`;
    }).join(', ');
  }

  /**
   * The entry, a row of the sidebar (ui/sidenav.js `todo`), or '' where the list has none
   * (`has`, decided at its first paint). `on` while the page or a page of its queues is open.
   */
  function entry({
    tab, me, has, counts = {}, on = false,
  }) {
    if (!has) return '';
    const n = total(tab, me, counts);
    return SideNav.todo({
      sel: sel(), on, label: 'Review', count: n || '', title: says(tab, me, counts),
    });
  }

  /**
   * The tabs of the page, one a queue (`href(id)` its address), the open one current, each with
   * its count once it is known.
   */
  function tabs({
    tab, me, counts = {}, open, href,
  }) {
    return queues(tab, me).map((q) => {
      const c = counts[q.id];
      const tag = q.counted !== false && c ? `<span class="tag">${esc(c)}</span>` : '';
      return `<a href="${esc(href(q.id))}" data-queue="${esc(q.id)}" title="${esc(q.title)}"${q.id === open ? ' aria-current="page"' : ''}><span>${esc(q.label)}</span>${tag}</a>`;
    }).join('');
  }

  return {
    PREFIX, QUEUES, sel, is, queueOf, queues, queue, shown, total, landing, entry, tabs,
  };
})();
