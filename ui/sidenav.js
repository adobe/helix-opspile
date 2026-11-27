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
 * The sidebar of Teams, Customers and Topics (the global `SideNav`), Spectrum 2's side
 * navigation: a SearchField on top (with an add button where you may add one), the rows under
 * it in sections, and a footer with what filters them on its left and how they are sorted on
 * its right. Every row is one line, as tall as a control: a visual (an icon, a letter, a color),
 * the name, and one quiet number at its end; what else there is to say of it is its title, and
 * its page. What waits for someone is a row with a count (`todo`): in Teams and Customers one,
 * Review, at the top from the first paint (ui/review.js), so nothing comes in above the rows.
 *
 * The rows are ranked by activity unless you ask for their names in order (the sort menu, kept
 * per list in the browser, `sortOf`). The pages draw the rows (`row`, `head`, `group`) and the
 * footer (`foot`); the menus are one popover (`menu`) the footer's buttons open.
 *
 * Its look is ui/spectrum.css's ("the sidebar"), every page's.
 */
globalThis.SideNav = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const KEY = 'opspile.sidenav';
  const store = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  const kept = () => {
    try {
      return JSON.parse(store?.getItem(KEY) || '{}') || {};
    } catch {
      return {};
    }
  };
  const keep = (k, v) => {
    const all = kept();
    all[k] = v;
    try {
      store?.setItem(KEY, JSON.stringify(all));
    } catch {
      // A private window: it holds for the page only.
    }
  };

  // Spectrum 2's workflow icons (S2_Icon_*_20_N), drawn as the pages' other inline icons.
  const ICON = {
    filter: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z"/></svg>',
    activity: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h14M3 10h9M3 15h5"/></svg>',
    name: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15l3-9 3 9M4 12h4M12 6h5l-5 9h5"/></svg>',
    add: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>',
  };

  /** The two orders of a list: busiest first, or by name. */
  const SORTS = [
    { id: 'activity', label: 'Activity' },
    { id: 'name', label: 'Name' },
  ];

  /** How list `key` is sorted: `activity` unless you asked for `name`. */
  const sortOf = (key) => (kept()[`sort:${key}`] === 'name' ? 'name' : 'activity');

  /** Whether the group `key` (likely duplicates, say) is open. */
  const isOpen = (key) => Boolean(kept()[`open:${key}`]);
  const setOpen = (key, open) => keep(`open:${key}`, open);

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  /**
   * `list` in the order of `mode`: by `activity` (a number), then the latest (an ISO time), then
   * the name; or by name. A copy.
   */
  function rank(list, mode, { activity = () => 0, latest = () => '', name }) {
    const byName = (a, b) => collator.compare(name(a), name(b));
    if (mode === 'name') return [...list].sort(byName);
    return [...list].sort((a, b) => (activity(b) || 0) - (activity(a) || 0)
      || String(latest(b) || '').localeCompare(String(latest(a) || '')) || byName(a, b));
  }

  /** A section's header: SideNav's, small and subdued. */
  const head = (text) => `<h2 class="navhead">${esc(text)}</h2>`;

  /** What a row without an icon of its own shows: its first letter on a gray square. */
  const tile = (name) => {
    const ch = [...String(name || '').replace(/[^\p{L}\p{N}]/gu, '')][0] || '·';
    return `<span class="navtile" aria-hidden="true">${esc(ch.toUpperCase())}</span>`;
  };

  /**
   * A row: a button picking `sel`, its `lead` visual (HTML), its `label` (text; `labelHtml` if
   * it is marked up), and its `count` at its end. `on` when it is what is open.
   */
  function row({
    sel, on = false, lead = '', label = '', labelHtml = null, title = '', count = '', countTitle = '', cls = '',
  }) {
    return `<button type="button" class="navrow${on ? ' on' : ''}${cls ? ` ${cls}` : ''}" data-sel="${esc(sel)}"${on ? ' aria-current="page"' : ''}${title ? ` title="${esc(title)}"` : ''}>
      ${lead}<span class="nm">${labelHtml ?? esc(label)}</span>${count !== '' && count !== null && count !== undefined ? `<span class="n"${countTitle ? ` title="${esc(countTitle)}"` : ''}>${esc(count)}</span>` : ''}</button>`;
  }

  /**
   * What waits for someone, at the top of a list: a row with how many (a Badge), which opens to
   * its rows (`body`, HTML). Open when you opened it, or when what is open is in it (`holds`).
   */
  function group({
    key, icon = '', label, count, body, holds = false, title = '',
  }) {
    const open = holds || isOpen(key);
    return `<div class="navgroup">
      <button type="button" class="navrow review" data-nav-group="${esc(key)}" aria-expanded="${open}"${title ? ` title="${esc(title)}"` : ''}>
        <span class="chev" aria-hidden="true"></span>${icon}<span class="nm">${esc(label)}</span>${count ? `<span class="navbadge">${esc(count)}</span>` : ''}</button>
      ${open ? `<div class="navsub">${body}</div>` : ''}</div>`;
  }

  /** A row that is not a pick (Unassigned, say) with a Badge: something to do there. */
  function todo({
    sel, on = false, icon = '', label, count, title = '',
  }) {
    return `<button type="button" class="navrow review${on ? ' on' : ''}" data-sel="${esc(sel)}"${on ? ' aria-current="page"' : ''}${title ? ` title="${esc(title)}"` : ''}>
      <span class="chev none" aria-hidden="true"></span>${icon}<span class="nm">${esc(label)}</span>${count ? `<span class="navbadge">${esc(count)}</span>` : ''}</button>`;
  }

  /**
   * The footer: the filter (`filter`: its label, and whether one is on) on its left, the sort of
   * list `key` on its right.
   */
  function foot(key, { filter = null } = {}) {
    const s = SORTS.find((x) => x.id === sortOf(key));
    return `<div class="navfoot">
      ${filter ? `<button type="button" class="navbtn${filter.on ? ' on' : ''}" data-nav-filter aria-haspopup="menu" title="Show">${ICON.filter}<span>${esc(filter.label)}</span></button>` : ''}
      <span class="fill"></span>
      <button type="button" class="navbtn" data-nav-sort="${esc(key)}" aria-haspopup="menu" title="Sort by">${ICON[s.id]}<span>${esc(s.label)}</span></button></div>`;
  }

  /** The add button beside the search field, named for what it adds. */
  const add = (label, id = 'navAdd') => `<button type="button" class="navadd" id="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}" aria-haspopup="dialog">${ICON.add}</button>`;

  // ---- the menu: one Popover, a Menu of radio and checkbox items --------------------------

  const pop = { el: null, button: null, shut: 0 };
  function menuEl() {
    if (pop.el) return pop.el;
    const el = document.createElement('div');
    el.className = 'navmenu';
    el.popover = 'auto';
    el.setAttribute('role', 'menu');
    let inside = false;
    el.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'closed') return;
      pop.shut = Date.now();
      inside = el.contains(document.activeElement);
    });
    el.addEventListener('toggle', (e) => {
      if (e.newState === 'closed' && inside && pop.button?.isConnected) pop.button.focus();
    });
    el.addEventListener('keydown', (e) => {
      const items = [...el.querySelectorAll('[role^="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
      if (to === undefined || !items.length) return;
      e.preventDefault();
      items[(to + items.length) % items.length].focus();
    });
    document.body.append(el);
    pop.el = el;
    return el;
  }

  /** Shows the popover above `button` (the footer is at the bottom), or under it; in the window. */
  function place(el, button, align) {
    const r = button.getBoundingClientRect();
    el.showPopover();
    const { width, height } = el.getBoundingClientRect();
    const gap = 4;
    const up = r.top - gap - height > 0 || r.bottom + gap + height > innerHeight;
    const left = align === 'end' ? r.right - width : r.left;
    el.style.left = `${Math.max(gap, Math.min(left, innerWidth - width - gap))}px`;
    el.style.top = `${up ? Math.max(gap, r.top - gap - height) : r.bottom + gap}px`;
    el.classList.toggle('up', up);
  }

  /**
   * Opens a Menu at `button`: `groups` of `{ title, items: [{ id, label, detail, checked,
   * check }] }` (a radio item, or a checkbox one with `check`); `onPick(id)` when one is picked.
   * A second click on the button closes it.
   */
  function menu(button, groups, onPick, { align = 'start' } = {}) {
    if (pop.button === button && Date.now() - pop.shut < 300) return;
    const el = menuEl();
    if (el.matches(':popover-open')) el.hidePopover();
    pop.button = button;
    el.innerHTML = groups.map((g) => `<div class="navmgroup" role="group"${g.title ? ` aria-label="${esc(g.title)}"` : ''}>
      ${g.title ? `<div class="navmhead" aria-hidden="true">${esc(g.title)}</div>` : ''}
      ${g.items.map((it) => `<button type="button" class="navmitem" role="${it.check ? 'menuitemcheckbox' : 'menuitemradio'}" aria-checked="${Boolean(it.checked)}" data-id="${esc(it.id)}">
        <span class="ck" aria-hidden="true"></span><span class="lb">${esc(it.label)}</span>${it.detail ? `<span class="dt">${esc(it.detail)}</span>` : ''}</button>`).join('')}</div>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      el.hidePopover();
      onPick(b.dataset.id);
    };
    place(el, button, align);
    (el.querySelector('[aria-checked="true"]') || el.querySelector('[role^="menuitem"]'))?.focus();
  }

  /** The sort menu of list `key`; `then()` once the order changed. */
  function sortMenu(button, key, then) {
    menu(button, [{
      title: 'Sort by',
      items: SORTS.map((s) => ({
        id: s.id,
        label: s.label,
        detail: s.id === 'activity' ? button.dataset.detail || 'threads, 30 days' : 'A–Z',
        checked: sortOf(key) === s.id,
      })),
    }], (id) => {
      keep(`sort:${key}`, id);
      then(id);
    }, { align: 'end' });
  }

  /**
   * Wires a sidebar's own controls in `root` (its groups, its sort button): `redraw()` after a
   * change. The pages wire their rows (`data-sel`) and their filter themselves.
   */
  function wire(root, redraw) {
    for (const b of root.querySelectorAll('[data-nav-group]')) {
      b.onclick = () => {
        setOpen(b.dataset.navGroup, b.getAttribute('aria-expanded') !== 'true');
        redraw();
        root.querySelector(`[data-nav-group="${CSS.escape(b.dataset.navGroup)}"]`)?.focus();
      };
    }
    const s = root.querySelector('[data-nav-sort]');
    if (s) s.onclick = () => sortMenu(s, s.dataset.navSort, redraw);
  }

  /**
   * Redraws the scrolling part of a sidebar (`list`, an element) with `html`, where it was
   * scrolled to.
   */
  function fill(list, html) {
    const top = list.scrollTop;
    // The row (or its fold) the focus was on keeps it, drawn again.
    const had = list.contains(document.activeElement) ? document.activeElement : null;
    const attr = had && ['data-sel', 'data-fold', 'data-nav-group'].find((a) => had.hasAttribute(a));
    const key = attr && `[${attr}="${CSS.escape(had.getAttribute(attr))}"]`;
    list.innerHTML = html;
    list.scrollTop = top;
    if (key) list.querySelector(key)?.focus({ preventScroll: true });
  }

  /** Scrolls the row that is open into view, if it is out of it (a link opened it). */
  function reveal(list) {
    const on = list.querySelector('.navrow.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  return {
    ICON, SORTS, sortOf, rank, head, tile, row, group, todo, foot, add, menu, sortMenu, wire, fill, reveal, isOpen, setOpen,
  };
})();
