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

import { ICON_EDGE } from './icons.js';

/**
 * The installable app: the web app manifest and a service worker. Both are public (outside
 * the Access application, which covers /inbox and /api): browsers fetch the manifest without
 * credentials. The worker caches nothing; it only answers a page load that fails because the
 * device is offline, with a page that says so.
 */

export const MANIFEST = {
  id: '/inbox',
  name: 'opspile',
  short_name: 'opspile',
  description: 'The ops inbox for Slack and Microsoft Teams',
  start_url: '/inbox',
  scope: '/',
  display: 'standalone',
  background_color: '#0f1114',
  theme_color: ICON_EDGE,
  icons: [
    {
      src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any',
    },
    {
      src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any',
    },
    {
      src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable',
    },
  ],
  shortcuts: [
    { name: 'Inbox', url: '/inbox', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    { name: 'Knowledge bases', url: '/inbox/kb', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    { name: 'Admin', url: '/inbox/admin', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
  ],
};

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>opspile · offline</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1114;color:#e8eaed;display:grid;
place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}
button{font:inherit;margin-top:12px;padding:6px 16px;border-radius:16px;border:1px solid #2a2f36;
background:#1a1e23;color:inherit}</style></head><body><main><h1>You are offline</h1>
<p>opspile needs a connection to show the inbox.</p>
<button onclick="location.reload()">Try again</button></main></body></html>`;

/**
 * The service worker's source. Page loads go to the network; only a failed one is answered.
 * The inbox shows its notifications through it (ui/inbox.js); a click on one brings an open
 * inbox forward and has it open the thread (`opspile:open`), or opens the thread's inbox.
 */
export const SERVICE_WORKER = `// opspile service worker: no cache, only an offline page, and notification clicks.
const OFFLINE = ${JSON.stringify(OFFLINE)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, {
    status: 503, headers: { 'content-type': 'text/html; charset=utf-8' },
  })));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/inbox', self.location.origin);
  if (url.origin !== self.location.origin) return;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const inboxes = all.filter((c) => new URL(c.url).pathname === '/inbox');
    const win = inboxes.find((c) => c.focused) || inboxes[0];
    if (win) {
      await win.focus();
      win.postMessage({ type: 'opspile:open', url: url.href });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
`;

/** GET /manifest.webmanifest and /sw.js, or null. */
export function pwa(request, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  if (pathname === '/manifest.webmanifest') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' },
    });
  }
  if (pathname === '/sw.js') {
    return new Response(SERVICE_WORKER, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      },
    });
  }
  return null;
}
