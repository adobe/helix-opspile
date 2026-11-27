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
 * The header of every page (its styles in ui/spectrum.css), as the global `Header`. It runs right after the
 * page's <header>, before the page's own script.
 *
 * The switch between the pages: Inbox, Teams, Customers (each with its agents, read-only but
 * where you manage them) and Topics (the topic map) for every member of a team (Inbox, Teams and
 * Customers, for their overviews, and Topics for Adobe's people on none, `staff` from /api/me,
 * to find what to follow), and
 * COGS (what the inbox costs) too for the admin team; and Stats, klickhaus' statistics of all threads in a new tab,
 * for whom /api/me gives it (`stats`). Each page
 * opens as it was left in this browser tab: the address of every page is kept (sessionStorage)
 * whenever it changes, so the inbox comes back with its team, filters, open thread and "view
 * as", and Teams and Customers with what was picked in them, at its section and the file open
 * there. A page may send another elsewhere: the inbox sends Customers to the customer on screen,
 * Teams to the team picked, and Stats to either (`stats`). The page you
 * are on does nothing when clicked; on a phone it opens the menu of the others.
 *
 * What waits for you is on Inbox in a color for who waits, the same down to a row of the inbox:
 * red, people (a colleague's or a customer's reply in a thread of yours, a mention of you: GET
 * /api/waiting, src/waiting.js); purple with the agent's bubble, the bots (an agent's reply to you,
 * a bot's mention, and the questions thread agents asked you, src/questions.js); blue, your
 * team's requests (the admin team's: channels and people asked for, customers in the portal,
 * bots, conflicts, threads of its inbox). A click on one opens them: the red and the purple the
 * personal view, the blue the admin team's open requests (`REQUESTS`).
 *
 * The color scheme, in your menu's Appearance: the system's (as the browser prefers), light or
 * dark, per browser (localStorage `opspile.scheme`), set as `data-scheme` on <html>, which the
 * tokens follow (src/page.js, `spectrumTokens`), and so does the browser's chrome (theme-color).
 * It is set before the page under the header is drawn, and follows a change made in another tab.

 */
window.Header = (() => {
  const PAGES = [
    { id: 'inbox', label: 'Inbox', href: '/inbox', title: 'Threads with customers, partners and vendors', member: true, internal: true },
    { id: 'teams', label: 'Teams', href: '/inbox/admin?tab=teams', title: 'Ops teams, their people, channels and agents', member: true, internal: true },
    { id: 'orgs', label: 'Customers', href: '/inbox/admin?tab=orgs', title: 'Customers, partners and vendors', member: true, internal: true },
    { id: 'topics', label: 'Topics', href: '/inbox/topics', title: 'What the threads are about', member: true, internal: true },
    { id: 'cogs', label: 'COGS', href: '/inbox/cogs', title: 'What the inbox costs, at list prices', admin: true },
    // On klickhaus, in a new tab: its address comes from /api/me (`stats.url`).
    { id: 'stats', label: 'Stats', href: null, title: 'Statistics of all threads in klickhaus (opens in a new tab)', external: true },
  ];
  const KEY = 'opspile.page.';
  /** The admin team's open requests: its inbox, filtered to them (ui/inbox.js, the Type card). */
  const REQUESTS = '/inbox?team=admin&filters=1&f.type=request&f.resolved=open';
  // What waits: the admin team's requests (for its members), and your questions, with the team
  // of the first one.
  const counts = {
    admin: 0, questions: 0, team: null, you: 0, bots: 0,
  };
  // The threads with messages for you that you have not read (GET /api/waiting, src/waiting.js),
  // by key: `{ n, team, org }`. The inbox tells what it knows better (`waiting`): the threads it
  // has loaded, and those you read there, which the server may not have yet (`readHere`, held
  // for HELD_MS: the room writes a read a few seconds after it).
  const yours = new Map();
  const held = new Map();
  const HELD_MS = 30 * 1000;
  // `n` the people's messages for you (red), `bots` the bots' (purple).
  const live = (k) => (held.get(k) || 0) <= Date.now();
  const youTotal = () => [...yours].reduce((n, [k, x]) => n + (live(k) ? x.n || 0 : 0), 0);
  const botTotal = () => [...yours].reduce((n, [k, x]) => n + (live(k) ? x.bots || 0 : 0), 0);
  const BUBBLE = '<svg class="bubble-ico" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 11H8l-3.2 2.6V11H3a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 3 2.5z"/></svg>';
  const CHEV = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f', '#a16207', '#0e7490'];
  const $ = (id) => document.getElementById(id);
  const phone = matchMedia('(max-width: 699px)');
  const opts = {
    prefer: {}, fallback: {}, go: null, open: null, stats: null, changed: null,
  };
  let countsSaid = '';
  let shut = 0;

  const SCHEME = 'opspile.scheme';
  const SCHEMES = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  /** The color scheme picked in this browser: `light`, `dark` or `system`. */
  function scheme() {
    let s = null;
    try { s = localStorage.getItem(SCHEME); } catch { /* storage is off */ }
    return s === 'light' || s === 'dark' ? s : 'system';
  }
  /** The page in the scheme picked: the tokens, the browser's chrome, the menu's ✓. */
  function applyScheme(s = scheme()) {
    const root = document.documentElement;
    if (s === 'system') delete root.dataset.scheme;
    else root.dataset.scheme = s;
    // theme-color takes no custom properties: each scheme's has its own tag, picked by media.
    for (const meta of document.querySelectorAll('meta[name="theme-color"][media]')) {
      if (!meta.dataset.media) meta.dataset.media = meta.media;
      const own = meta.dataset.media.includes(`prefers-color-scheme: ${s}`);
      meta.media = s === 'system' ? meta.dataset.media : own ? 'all' : 'not all';
    }
    for (const b of document.querySelectorAll('#schemes [data-scheme]')) {
      b.setAttribute('aria-checked', String(b.dataset.scheme === s));
    }
  }
  /**
   * Appearance in your menu, before the keyboard's shortcuts and logging out: in the column
   * they are in, where the menu has columns (the inbox's, on a wide screen).
   */
  function schemeMenu() {
    const menu = $('menu');
    if (!menu || $('schemes')) return;
    const box = document.createElement('section');
    box.innerHTML = `<h4 id="schemesLabel">Appearance</h4><div id="schemes" role="radiogroup" aria-labelledby="schemesLabel">${
      SCHEMES.map((o) => `<button class="item" role="radio" aria-checked="false" data-scheme="${o.id}"${o.title ? ` title="${o.title}"` : ''}><span class="ck s2-check" aria-hidden="true"></span>${o.label}</button>`).join('')}</div>`;
    const sections = [...menu.querySelectorAll('section')];
    const before = sections.find((s) => s.querySelector('.keys')) || sections.at(-1);
    if (before) before.before(box);
    else menu.append(box);
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-scheme]');
      if (!b) return;
      try {
        if (b.dataset.scheme === 'system') localStorage.removeItem(SCHEME);
        else localStorage.setItem(SCHEME, b.dataset.scheme);
      } catch { /* storage is off: this page only */ }
      applyScheme(b.dataset.scheme);
    });
  }
  schemeMenu();
  applyScheme();
  addEventListener('storage', (e) => { if (e.key === SCHEME || e.key === null) applyScheme(); });
  /** Which page an address on this origin is, or null. */
  function pageOf(url) {
    let u;
    try { u = new URL(url, location.origin); } catch { return null; }
    if (u.origin !== location.origin) return null;
    if (u.pathname === '/inbox') return 'inbox';
    if (u.pathname === '/inbox/cogs') return 'cogs';
    if (u.pathname === '/inbox/topics') return 'topics';
    if (u.pathname !== '/inbox/admin') return null;
    const tab = u.searchParams.get('tab');
    return tab === 'orgs' ? tab : 'teams';
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
   * Where a page opens: where the page on screen sends it (`prefer`: the inbox sends Customers
   * to the customer on screen, Teams to its team), else as it was left, else where the
   * page on screen suggests (`fallback`), else its start.
   */
  function href(id) {
    if (id === 'stats') return opts.prefer.stats?.() || stats();
    if (pageOf(location.href) === id) return `${location.pathname}${location.search}`;
    return opts.prefer[id]?.() || kept(id) || opts.fallback[id]?.() || PAGES.find((p) => p.id === id).href;
  }

  /**
   * The Stats page on klickhaus, over the last month, on an org and a team (their slugs), each
   * if given: klickhaus' `t` and `filters` parameters. A team is any of the row's `teams` (the
   * one its channel is filed under and those it is shared with), as the team's inbox has it.
   * Null before /api/me gave its address.
   */
  function stats({ org = null, team = null } = {}) {
    if (!opts.stats) return null;
    const u = new URL(opts.stats);
    u.searchParams.set('t', '1mo');
    const filters = [
      ...(org ? [{ col: '`org.slug`', value: org, exclude: false }] : []),
      ...(team ? [{
        col: 'arrayJoin(`teams`)', value: team, exclude: false, filterCol: '`teams`', filterOp: 'HAS',
      }] : []),
    ];
    if (filters.length) u.searchParams.set('filters', JSON.stringify(filters));
    return u.href;
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

  /**
   * The pages you may open, once the page knows who you are (`me` from /api/me). `go` opens
   * another page (`id`, its address) for the page on screen; `open`, an address of the page on
   * screen, in it (the inbox: the open requests, from the number on Inbox).
   */
  function init(me, {
    prefer = {}, fallback = {}, go = null, open = null, count = true, changed = null,
  } = {}) {
    Object.assign(opts.prefer, prefer);
    Object.assign(opts.fallback, fallback);
    opts.go = go;
    opts.open = open;
    opts.changed = changed;
    opts.stats = me.stats?.url || null;
    const own = PAGES.filter((p) => !p.external);
    let shown = [];
    if (me.admin) shown = own;
    else if (me.manages?.length) shown = own.filter((p) => !p.admin);
    else if (me.teams?.length) shown = own.filter((p) => p.member);
    else if (me.staff) shown = own.filter((p) => p.internal);
    if (opts.stats) shown = [...shown, ...PAGES.filter((p) => p.external)];
    const nav = $('pages');
    const item = (p) => (p.external
      ? `<a data-page="${p.id}" href="${href(p.id)}" title="${p.title}" target="_blank" rel="noopener">${p.label}<span class="ext" aria-hidden="true">↗</span></a>`
      : `<a data-page="${p.id}" href="${p.href}" title="${p.title}">${p.label}${p.id === 'inbox' && (me.admin || me.teams?.length) ? '<span class="count people" hidden></span><span class="count asks" hidden></span>' : ''}${p.id === 'inbox' && me.admin ? '<span class="count" hidden></span>' : ''}</a>`);
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
    setCounts({});
    if (count && me.questions?.open) setCounts({ questions: me.questions.open, team: me.questions.team });
    if (count && typeof fetch === 'function') loadWaiting();
    if (me.admin && count) {
      fetch('/api/admin/requests?count=1', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => { if (b) setCounts({ admin: Number(b.open) || 0 }); })
        .catch(() => {});
    }
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** Who waits, by color: red people, purple the bots, blue the admin team's requests. */
  const WHO = {
    people: () => (counts.you ? `${plural(counts.you, 'message')} for you from people` : ''),
    asks: () => {
      const n = counts.bots + counts.questions;
      return n ? `${plural(n, 'message')} for you from the bots (agents' replies to you, questions for you)` : '';
    },
    admin: () => (counts.admin ? `${plural(counts.admin, 'request')} for the admin team` : ''),
  };
  const kindOf = (el) => ['people', 'asks'].find((c) => el.classList?.contains(c)) || 'admin';
  const numberOf = (kind) => ({ people: counts.you, asks: counts.bots + counts.questions, admin: counts.admin }[kind]);
  /**
   * The numbers on Inbox, a color for who waits: the people's messages for you (`you`, red), the
   * bots' (`bots`) with the questions thread agents asked you (`questions`, the first one's
   * `team`; purple), and the admin team's requests (`admin`, blue), each kept until it is given
   * again. The page you are on, on a phone, shows their sum.
   */
  function setCounts(next) {
    Object.assign(counts, next);
    $('pages').dataset.count = String(counts.you + counts.bots + counts.questions + counts.admin);
    const said = Object.values(WHO).map((f) => f()).filter(Boolean).join(', ');
    for (const el of document.querySelectorAll('[data-page="inbox"] .count:not(.total)')) {
      const kind = kindOf(el);
      const n = numberOf(kind);
      const shown = n > 99 ? '99+' : String(n);
      if (kind === 'asks') el.innerHTML = `${BUBBLE}${shown}`;
      else el.textContent = shown;
      el.hidden = !n;
      el.title = WHO[kind]();
      el.closest('a').title = said ? `${said}, in the inbox` : PAGES.find((p) => p.id === 'inbox').title;
    }
    sync();
    // The page shows the same numbers where they are (the inbox: on its views): told of a change.
    const now = JSON.stringify(counts);
    if (now !== countsSaid) {
      countsSaid = now;
      if (opts.changed) queueMicrotask(opts.changed);
    }
  }
  /** What waits for you, asked again (GET /api/waiting): after a while, or when the inbox says. */
  function loadWaiting() {
    return fetch('/api/waiting', { credentials: 'same-origin', redirect: 'manual' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b) return;
        yours.clear();
        for (const t of b.threads || []) {
          const bots = Number(t.bots) || 0;
          yours.set(t.thread, {
            n: Math.max(0, (Number(t.n) || 0) - bots), bots, team: t.team, org: t.org,
          });
        }
        setCounts({
          you: youTotal(),
          bots: botTotal(),
          ...(b.questions ? { questions: b.questions.open || 0, team: b.questions.team || null } : {}),
        });
      })
      .catch(() => {});
  }
  /**
   * What the inbox knows of threads for you (`{ [key]: { n, team, org } }`, `n` 0 for none):
   * fresher than the last GET /api/waiting for those it has loaded.
   */
  function waiting(known) {
    for (const [k, x] of Object.entries(known || {})) {
      if (x && (x.n > 0 || x.bots > 0)) {
        yours.set(k, {
          n: x.n || 0, bots: x.bots || 0, team: x.team ?? yours.get(k)?.team ?? null, org: x.org ?? null,
        });
        // Something came in since you read it here.
        held.delete(k);
      } else yours.delete(k);
    }
    setCounts({ you: youTotal(), bots: botTotal() });
  }
  /** Threads you read here (their keys): none of theirs waits, whatever the server says for a while. */
  function readHere(keys) {
    for (const k of keys || []) held.set(k, Date.now() + HELD_MS);
    setCounts({ you: youTotal(), bots: botTotal() });
  }
  /** What waits for you, by team its thread is filed under: `{ [team]: { you, bots } }`. */
  function youByTeam() {
    const out = {};
    for (const [k, x] of yours) {
      if (!live(k)) continue;
      const t = out[x.team || ''] || { you: 0, bots: 0 };
      t.you += x.n || 0;
      t.bots += x.bots || 0;
      out[x.team || ''] = t;
    }
    return out;
  }
  /** The number of the admin team's requests that wait, on Inbox: they are threads of its inbox. */
  const setCount = (n) => setCounts({ admin: n });
  /**
   * Where a number on Inbox opens: the red and the purple, the personal view (your threads and
   * the questions for you are there); the blue (or the sum on a phone, when nothing else
   * waits), the admin team's requests.
   */
  const countHref = (kind) => (kind !== 'admin' || !counts.admin ? '/inbox?view=personal' : REQUESTS);

  /** You, at the right end: your face (picture over initials), your name, `sub` under it; your menu. */
  function user(me, sub = '') {
    const name = me.name || me.email || '';
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const initials = name.replace(/\(.*?\)/g, '').split(/[\s,]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    for (const id of ['userAv', 'menuAv']) {
      const av = $(id);
      av.style.background = COLORS[h % COLORS.length];
      av.dataset.hue = String(h % COLORS.length);
      // Every render calls this: the face is only built again when it changes.
      const face = `${initials} ${me.avatar || ''}`;
      if (av.dataset.face === face) continue;
      av.dataset.face = face;
      av.textContent = initials;
      // The picture on top; one that does not load (Gravatar's 404) leaves the initials.
      if (me.avatar) {
        const img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.remove();
        img.src = me.avatar;
        av.append(img);
      }
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
    // Another site, in its own tab: the browser opens it, and the menu closes.
    if (a.target === '_blank') {
      if ($('pagemenu')?.matches(':popover-open')) $('pagemenu').hidePopover();
      return;
    }
    const menu = $('pagemenu');
    // The number on Inbox: the open requests, wherever you are (on a phone, the one on the page
    // you are on, `.total`, opens the menu, where Inbox has its own).
    const badge = a.dataset.page === 'inbox' && e.target.closest('.count:not(.total)');
    if (badge && Number($('pages').dataset.count)) {
      e.preventDefault();
      if (menu?.matches(':popover-open')) menu.hidePopover();
      const to = countHref(kindOf(badge));
      if (pageOf(location.href) === 'inbox' && opts.open) opts.open(to);
      else if (opts.go) opts.go('inbox', to);
      else location.assign(to);
      return;
    }
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

  return {
    init, sync, setCount, setCounts, user, role, remember, href, pageOf, stats, scheme, REQUESTS,
    loadWaiting, waiting, readHere, youByTeam, counts: () => ({ ...counts }),
  };
})();
