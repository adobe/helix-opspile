#!/usr/bin/env node
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

/**
 * Copies the Cloudflare Access session of the production inbox from a logged-in Chrome
 * into `.dev-ui-session.json`, so the local UI preview (scripts/dev-ui.mjs) uses the
 * production API. The file's presence is what switches the preview from fake data to
 * production, read-only. The cookie is never printed.
 *
 *   node scripts/dev-ui-session.mjs <origin>        # copy (after signing in over there)
 *   node scripts/dev-ui-session.mjs --clear         # back to fake data
 *   node scripts/dev-ui-session.mjs <origin> --cdp http://127.0.0.1:9222
 *
 * Chrome must run with --remote-debugging-port (9222 by default) and have the production
 * inbox open and signed in. It reads cookies over the DevTools protocol; playwright-cli
 * redacts cookie values, so it cannot be used for this.
 */

import { chmod, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev-ui-session.json');
const COOKIE = 'CF_Authorization';

function args(argv) {
  const out = { cdp: 'http://127.0.0.1:9222', clear: false, origin: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--clear') {
      out.clear = true;
    } else if (a === '--cdp') {
      i += 1;
      out.cdp = argv[i];
    } else {
      out.origin = a;
    }
  }
  return out;
}

/** Storage.getCookies over the browser's DevTools socket. */
async function browserCookies(cdp) {
  const { webSocketDebuggerUrl: wsUrl } = await fetch(`${cdp.replace(/\/$/, '')}/json/version`)
    .then((r) => r.json());
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot reach the browser at ${cdp}`));
  });
  return new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== 1) {
        return;
      }
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result.cookies);
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
  });
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.clear) {
    await rm(SESSION_FILE, { force: true });
    console.log('cleared: the UI preview uses fake data again');
    return;
  }
  if (!opts.origin) {
    throw new Error('usage: node scripts/dev-ui-session.mjs <origin> [--cdp <url>] | --clear');
  }
  const { origin, host } = new URL(opts.origin);
  const cookie = (await browserCookies(opts.cdp)).find((c) => c.name === COOKIE
    && (c.domain === host || host.endsWith(c.domain.replace(/^\./, ''))));
  if (!cookie) {
    throw new Error(`no ${COOKIE} cookie for ${host} in that browser: open the inbox there and sign in first`);
  }
  await writeFile(SESSION_FILE, `${JSON.stringify({
    origin,
    cookie: `${COOKIE}=${cookie.value}`,
    copiedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(SESSION_FILE, 0o600);
  console.log(`copied the session for ${host} (value not shown); the UI preview now uses`
    + ' the production API, read-only. Run with --clear to go back to fake data.');
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
