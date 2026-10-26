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

import { retiredOrigins } from './subscription.js';

// Pages people open in a browser. On a retired origin they move to PUBLIC_ORIGIN; everything
// machines call there (Slack events, Graph notifications, /mcp and its OAuth, the API) still
// answers, for whatever has not learnt the new address yet.
const PAGES = /^\/(?:$|inbox(?:\/|$)|oauth\/authorize$|api\/oauth\/consent\/|api\/auth\/(?:slack|teams)\/(?:start|callback)$)/;

/** A 301 to the same path on PUBLIC_ORIGIN, when the request came to a retired origin. */
export function moved(request, env, url) {
  if (!['GET', 'HEAD'].includes(request.method) || !PAGES.test(url.pathname)) {
    return null;
  }
  const to = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (!to || url.origin === to || !retiredOrigins(env).includes(url.origin)) {
    return null;
  }
  return new Response(null, {
    status: 301, headers: { location: `${to}${url.pathname}${url.search}`, 'cache-control': 'no-store' },
  });
}
