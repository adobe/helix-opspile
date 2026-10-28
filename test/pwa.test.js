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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ICONS } from '../src/icons.js';
import { MANIFEST, pwa } from '../src/pwa.js';

const get = (path) => pwa({ method: 'GET' }, path);

describe('installable app', () => {
  it('serves a manifest browsers install from, with icons that exist', async () => {
    const res = get('/manifest.webmanifest');
    assert.equal(res.headers.get('content-type'), 'application/manifest+json');
    const m = await res.json();
    assert.deepEqual([m.start_url, m.scope, m.display], ['/inbox', '/', 'standalone']);
    const sizes = m.icons.map((i) => `${i.sizes} ${i.purpose}`);
    assert.ok(sizes.includes('192x192 any') && sizes.includes('512x512 any') && sizes.includes('512x512 maskable'));
    for (const i of [...MANIFEST.icons, ...MANIFEST.shortcuts.flatMap((s) => s.icons)]) {
      assert.ok(ICONS[i.src], i.src);
    }
  });

  it('serves a service worker that caches nothing and only answers page loads offline', async () => {
    const res = get('/sw.js');
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    const src = await res.text();
    assert.match(src, /mode !== 'navigate'/);
    assert.doesNotMatch(src, /caches\./);
    // A click on a notification opens its thread, in an inbox already open if there is one.
    assert.match(src, /'notificationclick'/);
    assert.match(src, /opspile:open/);
    assert.doesNotThrow(() => new Function(src)); // eslint-disable-line no-new-func
    assert.equal(get('/other'), null);
    assert.equal(pwa({ method: 'POST' }, '/sw.js'), null);
  });
});
