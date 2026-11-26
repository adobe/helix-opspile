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

// Installable app (see src/pwa.js): the service worker only answers page loads made offline.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// iOS opens its on-screen keyboard over the page and moves the page up, header and all, to show
// the text field: it scrolls the page and pans what is shown of it (interactive-widget it
// ignores). While the keyboard is open the page is as tall as what is left above it and follows
// that, so the header stays on screen; html.keyboard drops the home indicator's inset, which the
// keyboard covers.
if (window.visualViewport && matchMedia('(hover: none) and (pointer: coarse)').matches) {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const fit = () => {
    const open = vv.height < root.clientHeight - 100;
    root.classList.toggle('keyboard', open);
    root.style.setProperty('--app-height', open ? `${Math.round(vv.height)}px` : '');
    root.style.setProperty('--app-top', open ? `${Math.round(vv.pageTop)}px` : '');
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}

// Signing in is Cloudflare Access's, in front of /inbox and /api. When its session ends, it
// answers every request with a redirect to its sign-in page, on another origin, which fetch
// cannot follow (CORS) and reports only as "Failed to fetch". So fetches of /api follow no
// redirects (it makes none): a redirect means signed out, and the page says so, with a button
// that signs in again in a window of its own, so what is on the page (a reply being written)
// stays. Signed in again, the page hears `opspile:signedin` and loads what it could not.
(() => {
  const native = window.fetch.bind(window);
  const api = (input) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  };
  let bar = null;
  let popup = null;
  const signedIn = () => native('/api/me', { credentials: 'same-origin', redirect: 'manual' })
    .then((res) => res.ok, () => false);
  const style = document.createElement('style');
  style.textContent = `.signedout { position: fixed; z-index: 1000; left: 50%; transform: translateX(-50%);
    top: calc(10px + env(safe-area-inset-top, 0px)); max-width: calc(100vw - 24px); box-sizing: border-box;
    display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 14px; font-size: 13px;
    background: var(--card); color: var(--ink); border: 1px solid var(--yellow); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  .signedout button { font: inherit; white-space: nowrap; padding: 4px 10px; border: 0; border-radius: 6px;
    background: var(--accent); color: #fff; cursor: pointer; }`;
  document.head.append(style);

  function back() {
    bar?.remove();
    bar = null;
    popup?.close();
    popup = null;
    window.dispatchEvent(new Event('opspile:signedin'));
  }
  function signIn() {
    if (popup && !popup.closed) {
      popup.focus();
      return;
    }
    // /api/me, behind Access like the rest: the window comes back to it once signed in.
    popup = window.open('/api/me', 'opspile-signin', 'popup,width=520,height=680');
    if (!popup) {
      location.reload(); // no window allowed: sign in in this one
      return;
    }
    // This window, not `popup`: signing in from another tab may clear that meanwhile.
    const opened = popup;
    const watch = setInterval(async () => {
      let done = opened.closed;
      try {
        done ||= opened.location.pathname === '/api/me' && opened.document.readyState === 'complete';
      } catch {
        // at the sign-in page, on another origin
      }
      if (!done) return;
      clearInterval(watch);
      // Signed in already, from another tab: the page was told.
      if (!bar) return;
      if (await signedIn()) back();
      else {
        opened.close();
        if (popup === opened) popup = null;
      }
    }, 500);
  }
  function signedOut() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'signedout';
    bar.setAttribute('role', 'alert');
    bar.innerHTML = '<span>Your sign-in has expired: nothing can be loaded or sent.</span>'
      + '<button type="button">Sign in again</button>';
    bar.querySelector('button').onclick = signIn;
    document.body.append(bar);
  }
  // Signed in again in another tab.
  window.addEventListener('focus', async () => {
    if (bar && !(popup && !popup.closed) && await signedIn()) back();
  });

  // D1 turning queries away for a few seconds (src/api.js): 503 with Retry-After. A read is
  // asked once more after it (and a moment at random, so the pages it turned away together do
  // not come back together); what writes is not, its caller says it failed.
  const reads = (input, init) => String(init.method || (input instanceof Request ? input.method : 'GET'))
    .toUpperCase() === 'GET';
  const busy = (res) => res.status === 503 && res.headers.has('retry-after');
  const later = (res) => new Promise((resolve) => {
    const s = Math.min(Number(res.headers.get('retry-after')) || 1, 10);
    setTimeout(resolve, s * 1000 + Math.random() * 1000);
  });

  // D1's bookmark (src/d1session.js): the newest state of the database this browser has seen,
  // from /api's answers and the rooms' events (`D1Bookmark.see`), in every tab. Each fetch of
  // /api says it, so its reads come from a copy of the database at least that new. Bookmarks
  // are hex fields of fixed width: of two as long, the greater is the newer.
  const MARK = 'opspile.d1bookmark';
  const MARK_HEADER = 'x-d1-bookmark';
  let mark = null;
  const newer = (a, b) => typeof a === 'string' && a !== '' && (!b || a.length !== b.length || a > b);
  const marked = () => {
    let kept = null;
    try { kept = localStorage.getItem(MARK); } catch { /* storage is off */ }
    return newer(kept, mark) ? kept : mark;
  };
  const see = (b) => {
    if (!newer(b, marked())) return;
    mark = b;
    try { localStorage.setItem(MARK, b); } catch { /* storage is off */ }
  };
  window.D1Bookmark = { see, get: marked };
  const withMark = (input, init) => {
    const b = marked();
    if (!b) return init;
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set(MARK_HEADER, b);
    return { ...init, headers };
  };
  const ask = (input, init) => native(input, { ...withMark(input, init), redirect: 'manual' }).then((res) => {
    see(res.headers?.get?.(MARK_HEADER));
    return res;
  });

  window.fetch = async (input, init = {}) => {
    if (!api(input) || init.redirect) return native(input, init);
    let res = await ask(input, init);
    if (busy(res) && reads(input, init)) {
      await later(res);
      res = await ask(input, init);
    }
    if (res.type !== 'opaqueredirect') return res;
    signedOut();
    throw new Error('Signed out: sign in again');
  };
})();

// A closed <dialog> leaves as it came (ui/spectrum.css: it fades out as it sinks, its underlay
// with it), so it stays in the page until its exit is over. Meanwhile it is inert, which lets
// the page under it take the next click, and its ids are gone, so a dialog opened while it
// leaves is the only one they name. Whoever waits for the answer does not wait for the exit.
window.Dialog = (() => {
  /** Takes the closed `dlg` out of the page once it has left (right away if it has no exit). */
  function remove(dlg) {
    if (!dlg.isConnected) return;
    dlg.inert = true;
    for (const n of dlg.querySelectorAll('[id]')) n.removeAttribute('id');
    // Asking for its animations starts the transitions its closing set off.
    const exit = dlg.getAnimations();
    let done = false;
    const gone = () => {
      if (done) return;
      done = true;
      if (!dlg.open) dlg.remove();
    };
    if (!exit.length) { gone(); return; }
    Promise.allSettled(exit.map((a) => a.finished)).then(gone);
    // A page in the background draws no frames, and its animations do not finish.
    const end = Math.max(...exit.map((a) => a.effect?.getComputedTiming().endTime || 0));
    setTimeout(gone, end + 100);
  }
  return { remove };
})();

/**
 * Content swaps. A region that shows one subject at a time (the open thread, a file, a topic, a
 * team) has its content replaced in one go when another is picked, and the new content fades
 * in, quickly (S2: what arrives eases out). `Swap.watch(region, subject)` watches the region's
 * children: when they are replaced and `subject()` names another subject than it did for what
 * was there, the region fades in. A placeholder ("Loading…", alone in the region as `.empty`)
 * is shown at once, not faded, and counts as a subject of its own, so the content that
 * replaces it fades in: a thread that has to be loaded fades in once, when it arrives.
 * Re-rendering the same subject (a live update, a save) does not fade, and nothing waits for
 * the fade: the content is in the page, focusable and clickable, from its first frame.
 * `skip()` says when not to (where the region slides in already); with reduced motion, or in
 * a tab in the background, nothing fades.
 *
 * The View Transitions API would cross-fade the old content out as well, but it changes the
 * page only a frame later, in a callback, and the pages read and focus what they have just
 * written, so the new content fades in over nothing instead.
 */
window.Swap = (() => {
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = (v) => (/ms$/.test(v) ? parseFloat(v) : parseFloat(v) * 1000) || 0;
  // `--s2-swap-in` (ui/spectrum.css): a duration, then an easing.
  const timing = (el) => {
    const value = getComputedStyle(el).getPropertyValue('--s2-swap-in').trim();
    const [, duration = '', easing = ''] = /^(\S*)\s*(.*)$/.exec(value);
    return { duration: ms(duration), easing: easing || 'ease-out' };
  };
  const watch = (region, subject, { skip = () => false } = {}) => {
    if (!region || region.__swap) return;
    region.__swap = true;
    const loading = () => {
      const only = region.children.length === 1 && region.firstElementChild;
      return only && only.classList.contains('empty') ? only : null;
    };
    const now = () => `${subject() ?? ''}\n${loading()?.textContent ?? ''}`;
    let shown = now();
    let fade = null;
    new MutationObserver(() => {
      const was = shown;
      shown = now();
      if (was === shown) return;
      fade?.cancel();
      fade = null;
      if (loading() || still() || document.visibilityState !== 'visible' || skip()) return;
      const { duration, easing } = timing(region);
      if (duration) fade = region.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
    }).observe(region, { childList: true });
  };
  return { watch };
})();

/**
 * A link to the app opened in it, installed (src/pwa.js: `handle_links`, with `launch_handler`
 * focus-existing): the window it came to takes it. A page that can show it where it is says so
 * (`Launch.take = (url) => …`, true where it did: the inbox opens a thread, at a message); any
 * other page loads it, which asks first where something would be lost (beforeunload). The launch
 * that loaded the page is its own address, shown already.
 */
window.Launch = (() => {
  const landed = location.href;
  let first = true;
  const launch = { take: null };
  window.launchQueue?.setConsumer?.((params) => {
    const url = params?.targetURL;
    const own = first && url === landed;
    first = false;
    if (!url || own) return;
    if (!launch.take?.(url)) location.assign(url);
  });
  return launch;
})();
