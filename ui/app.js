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

  window.fetch = async (input, init = {}) => {
    if (!api(input) || init.redirect) return native(input, init);
    const res = await native(input, { ...init, redirect: 'manual' });
    if (res.type !== 'opaqueredirect') return res;
    signedOut();
    throw new Error('Signed out: sign in again');
  };
})();
