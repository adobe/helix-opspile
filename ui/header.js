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
 * The header of every page (ui/header.css), as the global `Header`. It runs right after the
 * page's <header>, before the page's own script.
 *
 * The switch between the pages: Inbox and Agents for every member of a team (Agents read-only),
 * Teams too for team managers, and Orgs and Requests too for the admin team (with the number
 * of open requests on Requests). Each page
 * opens as it was left in this browser tab: the address of every page is kept (sessionStorage)
 * whenever it changes, so the inbox comes back with its team, filters, open thread and "view
 * as", the editor with its knowledge base and file, and each admin section with what was
 * picked in it. A page may send another elsewhere: the inbox sends Agents and Orgs to the
 * customer on screen, and Teams to the team picked. The page you are on does nothing when clicked; on a phone it opens the menu of
 * the others.
 */
window.Header = (() => {
  const PAGES = [
    { id: 'inbox', label: 'Inbox', href: '/inbox', title: 'Threads with customers, partners and vendors', member: true },
    { id: 'agents', label: 'Agents', href: '/inbox/kb', title: 'Thread agents: their knowledge bases, channels, MCP servers and instructions', member: true },
    { id: 'teams', label: 'Teams', href: '/inbox/admin?tab=teams', title: 'Ops teams: their members, channels and rules' },
    { id: 'orgs', label: 'Orgs', href: '/inbox/admin?tab=orgs', title: 'Customers, partners and vendors', admin: true },
    { id: 'requests', label: 'Requests', href: '/inbox/admin?tab=requests', title: 'Channels team managers asked for: confirm or decline', admin: true },
  ];
  const KEY = 'opspile.page.';
  const CHEV = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f', '#a16207', '#0e7490'];
  const $ = (id) => document.getElementById(id);
  const phone = matchMedia('(max-width: 699px)');
  const opts = { prefer: {}, fallback: {}, go: null };
  let shut = 0;

  /** Which page an address on this origin is, or null. */
  function pageOf(url) {
    let u;
    try { u = new URL(url, location.origin); } catch { return null; }
    if (u.origin !== location.origin) return null;
    if (u.pathname === '/inbox') return 'inbox';
    if (u.pathname === '/inbox/kb') return 'agents';
    if (u.pathname !== '/inbox/admin') return null;
    const tab = u.searchParams.get('tab');
    return ['orgs', 'requests'].includes(tab) ? tab : 'teams';
  }
  /** Keeps an address (the page's own, by default) as where its page was left. */
  function remember(url = location.href) {
    const id = pageOf(url);
    if (!id) return;
    const u = new URL(url, location.origin);
    try { sessionStorage.setItem(KEY + id, `${u.pathname}${u.search}`); } catch { /* private mode */ }
  }
  const kept = (id) => { try { return sessionStorage.getItem(KEY + id); } catch { return null; } };
  /**
   * Where a page opens: where the page on screen sends it (`prefer`: the inbox sends Agents and
   * Orgs to the customer on screen, Teams to its team), else as it was left, else where the
   * page on screen suggests (`fallback`), else its start.
   */
  function href(id) {
    if (pageOf(location.href) === id) return `${location.pathname}${location.search}`;
    return opts.prefer[id]?.() || kept(id) || opts.fallback[id]?.() || PAGES.find((p) => p.id === id).href;
  }

  const links = () => document.querySelectorAll('header a[data-page], .pagemenu a[data-page]');
  /** The page on screen marked, and every link pointing where its page was left. */
  function sync() {
    const here = pageOf(location.href);
    for (const a of links()) {
      a.href = href(a.dataset.page);
      if (a.dataset.page === here && !a.closest('h1')) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    // On a phone the page you are on stands for the switch: the chevron of its menu, and the
    // open requests, wherever they are. Changed only when they change: this runs under the pointer.
    const nav = $('pages');
    const cur = nav.querySelector('[aria-current]');
    const n = Number(nav.dataset.count) || 0;
    for (const a of nav.querySelectorAll('a')) {
      if (a !== cur) { a.querySelector('.chev')?.remove(); a.querySelector('.total')?.remove(); }
    }
    if (cur) {
      let total = cur.querySelector('.total');
      if (!total) {
        cur.insertAdjacentHTML('beforeend', '<span class="count total" hidden></span>');
        total = cur.querySelector('.total');
      }
      if (total.textContent !== String(n)) total.textContent = String(n);
      total.hidden = !n;
      if (!cur.querySelector('.chev')) cur.insertAdjacentHTML('beforeend', CHEV);
    }
  }

  /** The pages you may open, once the page knows who you are (`me` from /api/me). */
  function init(me, { prefer = {}, fallback = {}, go = null, count = true } = {}) {
    Object.assign(opts.prefer, prefer);
    Object.assign(opts.fallback, fallback);
    opts.go = go;
    let shown = [];
    if (me.admin) shown = PAGES;
    else if (me.manages?.length) shown = PAGES.filter((p) => !p.admin);
    else if (me.teams?.length) shown = PAGES.filter((p) => p.member);
    const nav = $('pages');
    const item = (p) => `<a data-page="${p.id}" href="${p.href}" title="${p.title}">${p.label}${p.id === 'requests' ? '<span class="count" hidden></span>' : ''}</a>`;
    nav.innerHTML = shown.map(item).join('');
    nav.hidden = !shown.length;
    let menu = $('pagemenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'pagemenu';
      menu.className = 'pagemenu';
      menu.popover = 'auto';
      menu.addEventListener('beforetoggle', (e) => { if (e.newState === 'closed') shut = Date.now(); });
      nav.after(menu);
    }
    menu.innerHTML = shown.map(item).join('');
    setCount(Number(nav.dataset.count) || 0);
    if (me.admin && count) {
      fetch('/api/admin/requests?count=1', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => { if (b) setCount(Number(b.open) || 0); })
        .catch(() => {});
    }
  }

  /** The number of open channel requests, on Requests. */
  function setCount(n) {
    $('pages').dataset.count = String(n);
    for (const el of document.querySelectorAll('[data-page="requests"] .count:not(.total)')) {
      el.textContent = String(n);
      el.hidden = !n;
      el.closest('a').title = n ? `${n} channel request${n === 1 ? '' : 's'} from team managers to confirm or decline`
        : PAGES.find((p) => p.id === 'requests').title;
    }
    sync();
  }

  /** You, at the right end: your face, your name, and under it `sub`; and your menu. */
  function user(me, sub = '') {
    const name = me.name || me.email || '';
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const initials = name.replace(/\(.*?\)/g, '').split(/[\s,]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    for (const id of ['userAv', 'menuAv']) {
      $(id).textContent = initials;
      $(id).style.background = COLORS[h % COLORS.length];
    }
    $('me').textContent = name;
    $('userSub').textContent = sub;
    $('userSub').hidden = !sub;
    $('menuName').textContent = name;
    $('menuEmail').textContent = me.email || '';
  }
  /** What you are, under your name where no team is on screen. */
  const role = (me) => (me.admin ? 'Admin team' : me.manages?.length ? 'Team manager' : '');

  /** A click on a page: none on the one you are on (a phone opens the menu), else the page's `go`. */
  function click(e) {
    const a = e.target.closest('a[data-page]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const menu = $('pagemenu');
    if (a.hasAttribute('aria-current')) {
      e.preventDefault();
      if (a.closest('#pages') && phone.matches && Date.now() - shut > 300) {
        menu.style.left = `${Math.round(a.getBoundingClientRect().left)}px`;
        menu.showPopover();
      } else menu?.hidePopover();
      return;
    }
    if (menu?.matches(':popover-open')) menu.hidePopover();
    // The logo, on the page it opens: nothing to open.
    if (a.getAttribute('href') === `${location.pathname}${location.search}`) { e.preventDefault(); return; }
    if (opts.go) {
      e.preventDefault();
      opts.go(a.dataset.page, a.getAttribute('href'));
    }
  }

  remember();
  for (const m of ['pushState', 'replaceState']) {
    const native = history[m].bind(history);
    history[m] = (...args) => { native(...args); remember(); sync(); };
  }
  addEventListener('popstate', () => { remember(); sync(); });
  // A page that suggests where another opens (the inbox: the open thread's agent) is asked
  // again when the link is about to be used.
  document.querySelector('header').addEventListener('pointerover', (e) => { if (e.target.closest('a[data-page]')) sync(); });
  document.querySelector('header').addEventListener('focusin', (e) => { if (e.target.closest('a[data-page]')) sync(); });
  document.querySelector('header').addEventListener('click', click);
  $('menu')?.addEventListener('toggle', (e) => $('user').setAttribute('aria-expanded', String(e.newState === 'open')));
  sync();

  return { init, sync, setCount, user, role, remember, href, pageOf };
})();
