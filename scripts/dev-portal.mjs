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
 * Local preview of the customer portal (src/portal/), with made-up data.
 *
 *   npm run portal:dev                    # http://localhost:8790, a channel with threads
 *   PORT=9000 npm run portal:dev
 *   node scripts/dev-portal.mjs --lobby      # a lobby nobody has asked from yet
 *   node scripts/dev-portal.mjs --requested  # one that waits for its channel
 *   node scripts/dev-portal.mjs --declined   # one that was declined
 *   node scripts/dev-portal.mjs --outsider   # someone of the domain nobody invited
 *   node scripts/dev-portal.mjs --closed     # someone of a domain the portal is not open to
 *
 * What runs is the portal itself: its page as src/portal/worker.js puts it together (read
 * from disk on every request, so saving a file under ui/ shows on reload), its API
 * (src/portal/api.js) and its record, in an in-memory SQLite database with the portal's
 * migrations. What is replaced: Cloudflare Access ("signed in as Dana") and the inbox, which
 * here takes every event and does nothing with it.
 *
 * `POST /__dev/reply` posts an answer from Adobe in the latest thread (the page shows it
 * within its 15 seconds), `POST /__dev/open` opens a channel for a lobby that waits, and
 * `POST /__dev/decline` declines it, as the inbox's admins do.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from '../src/icons.js';
import { assemble } from '../src/pagecore.js';
import { api } from '../src/portal/api.js';
import * as platform from '../src/portal/platform.js';
import { d1, PORTAL } from '../test/d1.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8790;
const has = (flag) => process.argv.includes(`--${flag}`);

// Made-up people and a made-up company.
const DOMAIN = 'acme.example';
const DANA = `dana.diaz@${DOMAIN}`;
const STAFF = [
  { email: 'ada@adobe.example', name: 'Ada Lovelace' },
  { email: 'grace@adobe.example', name: 'Grace Hopper' },
];
const ME = has('closed') ? 'dana.diaz@elsewhere.example'
  : (has('outsider') && `ravi.rao@${DOMAIN}`) || DANA;

const env = {
  DB: d1({ migrations: PORTAL }),
  PORTAL_DOMAINS: DOMAIN,
  PUBLIC_ORIGIN: `http://localhost:${PORT}`,
  PORTAL_NAME: 'dev',
  OPSPILE: { events: async () => ({ ok: true }), technologies: async () => [] },
};

/** One call of the portal's API as `email`. */
async function call(email, method, path, body) {
  const url = new URL(`http://localhost:${PORT}${path}`);
  const res = await api(new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }), env, url, { email });
  return res.json();
}

const HOUR = 60 * 60 * 1000;
const ago = (hours) => Date.now() - hours * HOUR;

async function seed() {
  await call(DANA, 'GET', '/api/me');
  await call(DANA, 'PUT', '/api/profile', { name: 'Dana Diaz' });
  await call(DANA, 'PUT', '/api/lobby', {
    company: 'Acme',
    tech: ['eds', 'da', 'assets', 'analytics'],
    note: 'We move our product pages to Edge Delivery this quarter, and want a place to ask the people who built it.',
  });
  await call(DANA, 'POST', '/api/invite', { email: `lee.long@${DOMAIN}`, name: 'Lee Long' });
  await call(DANA, 'POST', '/api/invite', { email: `mo.malik@${DOMAIN}`, name: 'Mo Malik' });
  await call(`lee.long@${DOMAIN}`, 'GET', '/api/me');
  if (has('lobby') || has('outsider')) {
    return;
  }
  await call(DANA, 'POST', '/api/lobby/request', {});
  if (has('requested')) {
    return;
  }
  if (has('declined')) {
    await platform.decline(env, {
      domain: DOMAIN, reason: 'Acme has a Slack channel with us already: ask Lee to add you there.',
    });
    return;
  }
  const { channel } = await platform.open(env, {
    domain: DOMAIN, name: 'acme', topic: 'Acme and Adobe Enterprise Support', by: STAFF[0],
  });
  const at = { domain: DOMAIN, channel: channel.id };
  const lee = (await call(`lee.long@${DOMAIN}`, 'GET', '/api/me')).me;
  const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(channel.id).first();
  // What a customer writes goes through the store as the API does, at a time of its own.
  const { writeMessage, reactTo } = await import('../src/portal/store.js');
  const user = (id) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  const dana = (await call(DANA, 'GET', '/api/me')).me;
  const says = async (who, text, hours, thread) => {
    const author = await user(who.id);
    return (await writeMessage(env, ch, author, { root: thread, text }, ago(hours))).id;
  };

  const welcome = (await platform.post(env, {
    ...at,
    author: STAFF[0],
    text: 'Welcome to Adobe Enterprise Support, Acme! This is your channel with the Edge ops team. Start a new thread for each question, and we answer you here.',
  }, ago(70))).id;
  await reactTo(env, ch, await user(dana.id), { id: welcome, emoji: '👍' }, ago(69));

  const cache = await says(dana, 'Product pages are stale after publishing\nWe publish from Document Authoring, and `/products/anvil` still shows yesterday\'s price on the live site. Preview is right.', 50);
  await platform.post(env, {
    ...at,
    root: cache,
    author: STAFF[1],
    text: 'Thanks, Dana. Two questions:\n\n1. Is the price in the document itself, or does it come from a spreadsheet?\n2. Do you have a CDN of your own in front of the site?',
  }, ago(49));
  await says(dana, 'It comes from the `prices` sheet. And yes, we bring our own CDN.', 48.5, cache);
  await platform.post(env, {
    ...at,
    root: cache,
    author: STAFF[1],
    text: 'Then that is it: the sheet was published, but your CDN was not purged. Set up the push invalidation for it:\n\n```yaml\ncdn:\n  prod:\n    host: www.acme.example\n    type: managed\n```\n\nPublish the sheet again afterwards and the page follows.',
  }, ago(48));
  await says(lee, 'That did it, thank you!', 47, cache);
  await platform.react(env, {
    ...at, id: cache, emoji: '✅', author: STAFF[1],
  }, ago(46));

  const migration = await says(lee, 'How do we move 4,000 PDFs into Assets?\nThey are on a file share today. Is there an importer, or do we script it?', 6);
  await platform.post(env, {
    ...at,
    root: migration,
    author: STAFF[0],
    text: 'There is a bulk import for that. How are the PDFs organized today: by product, by year, or flat? That decides the folder mapping.',
  }, ago(1.5));

  await says(dana, 'Can we get a second site for the Benelux market?', 0.2);
}

await seed();

const read = (name) => readFileSync(join(root, 'ui', name), 'utf8');
const { default: MARKDOWN } = await import('../src/ui-markdown.bundle.js');
const page = () => assemble(read('portal.html'), {
  'portal.js': read('portal.js'),
  'app.js': read('app.js'),
  'markdown.js': MARKDOWN,
  'spectrum-fonts.css': read('spectrum-fonts.css'),
  'spectrum.css': read('spectrum.css'),
  'spectrum-portal.css': read('spectrum-portal.css'),
});

/** What the inbox's admins do, for the preview. */
async function dev(pathname) {
  if (pathname === '/__dev/open') {
    const opened = await platform.open(env, { domain: DOMAIN, name: 'acme', by: STAFF[0] });
    await platform.post(env, {
      domain: DOMAIN, channel: opened.channel.id, author: STAFF[0], text: 'Welcome, Acme!',
    });
    return opened;
  }
  if (pathname === '/__dev/decline') {
    return platform.decline(env, { domain: DOMAIN, reason: 'Ask again once your contract is signed.' });
  }
  if (pathname === '/__dev/reply') {
    const latest = await env.DB.prepare(`SELECT channel, root FROM messages
      ORDER BY at DESC LIMIT 1`).first();
    return latest ? platform.post(env, {
      domain: DOMAIN,
      channel: latest.channel,
      root: latest.root,
      author: STAFF[1],
      text: 'We are on it. More in a minute.',
    }) : { error: 'no thread yet' };
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/__dev/') && req.method === 'POST') {
      const done = await dev(url.pathname);
      res.writeHead(done ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(done || { error: 'not found' }));
      return;
    }
    if (ICONS[url.pathname]) {
      res.writeHead(200, { 'content-type': ICONS[url.pathname].type });
      res.end(Buffer.from(ICONS[url.pathname].base64, 'base64'));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const answer = await api(request, env, url, { email: ME });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(await answer.text());
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(page());
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`${e.stack}\n`);
  }
}).listen(PORT, () => {
  console.log(`customer portal preview: http://localhost:${PORT}/ (signed in as ${ME})`);
});
