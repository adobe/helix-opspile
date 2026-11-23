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
 * Files, pictures and logos are kept in memory, and the pictures of Adobe's people are made up
 * (the portal would fetch the ones the inbox knows).
 *
 * Adobe's side of a thread (how many listen, the typical wait, what happens right now) is made
 * up too, from the thread's own messages: the inbox's is src/portalstatus.js.
 *
 * `POST /__dev/reply` posts an answer from Adobe in the latest thread (the page shows it
 * within seconds), `POST /__dev/open` opens a channel for a lobby that waits, and
 * `POST /__dev/decline` declines it, as the inbox's admins do. `POST /__dev/typing` has someone
 * at Adobe write in the latest thread for ten seconds, and `POST /__dev/working` and
 * `POST /__dev/draft` turn the agent's work and a draft on and off.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from '../src/icons.js';
import { PORTAL_FILES, portalPage } from '../src/portal/page.js';
import { api } from '../src/portal/api.js';
import * as platform from '../src/portal/platform.js';
import { standing } from '../src/portalstatus.js';
import { d1, PORTAL } from '../test/d1.js';
import { fakeBucket } from '../test/fakes.js';

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

/** What the preview's Adobe does right now (`POST /__dev/working`, `/__dev/draft`). */
const adobe = { working: false, draft: false };

/** Adobe's side of a thread as the inbox would say it, made up from the thread's messages. */
async function status({ root: thread }) {
  if (!thread) {
    return {
      listening: 14, estimate: { minutes: 95, asked: null }, working: false, draft: false,
    };
  }
  // eslint-disable-next-line no-use-before-define
  const { results } = await env.DB.prepare(`SELECT m.at, u.kind != 'customer' AS staff,
      1 AS counted FROM messages m JOIN users u ON u.id = m.author
    WHERE m.root = ? AND m.deleted_at IS NULL ORDER BY m.at`).bind(thread).all();
  const { asked, gap, last } = standing(results);
  const since = asked === null ? (last !== null && (Date.now() - last) / 60000) : gap;
  return {
    listening: 14,
    estimate: {
      minutes: since !== null && since !== false && since <= 30 ? 6 : 95,
      asked: asked === null ? null : new Date(asked).toISOString(),
    },
    working: adobe.working,
    draft: adobe.draft && asked !== null,
  };
}

const env = {
  DB: d1({ migrations: PORTAL }),
  // The portal's bucket, in memory: files, pictures and logos.
  FILES: fakeBucket(),
  PORTAL_DOMAINS: DOMAIN,
  PUBLIC_ORIGIN: `http://localhost:${PORT}`,
  PORTAL_NAME: 'dev',
  OPSPILE: { events: async () => ({ ok: true }), technologies: async () => [], status },
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

/** A made-up PNG, `w` by `h`, of what `pixel(x, y)` says (`[r, g, b]`): no image library. */
function png(w, h, pixel) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      rows.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A face: a head and shoulders in one color on another. */
function face(bg, fg) {
  const head = (x, y) => (x - 48) ** 2 + (y - 38) ** 2 < 18 ** 2;
  const shoulders = (x, y) => (x - 48) ** 2 / 1.6 + (y - 100) ** 2 < 36 ** 2;
  return png(96, 96, (x, y) => (head(x, y) || shoulders(x, y) ? fg : bg));
}

/** A chart: bars of made-up response times, the last ones too high. */
const TIMES = [40, 44, 52, 47, 60, 58, 70, 66, 90, 150, 210, 240, 232, 250, 244, 238, 80, 52];
const chart = png(640, 320, (x, y) => {
  const height = TIMES[Math.floor((x - 40) / 30)] || 0;
  const bar = x > 40 && x < 580 && (x - 40) % 30 < 22 && y > 290 - height && y < 290;
  if (bar) {
    return height > 120 ? [214, 69, 65] : [75, 117, 255];
  }
  return y === 290 || x === 40 ? [140, 140, 140] : [248, 248, 248];
});

/** A logo: an A-shaped mark. */
const mark = png(128, 128, (x, y) => {
  const outer = y > 24 && y < 104 && Math.abs(x - 64) < (y - 24) / 2;
  const inner = y > 70 && Math.abs(x - 64) < (y - 70) / 2.4;
  return outer && !inner ? [228, 60, 40] : [255, 255, 255];
});

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
  // Lee's picture and Acme's logo, uploaded as they would be.
  const { setAvatar, setLogo } = await import('../src/portal/store.js');
  const row = (email) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  await setAvatar(env, await row(`lee.long@${DOMAIN}`), {
    type: 'image/png', bytes: face([90, 60, 160], [240, 220, 250]),
  });
  await setLogo(env, DOMAIN, { type: 'image/png', bytes: mark });
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
  const { uploadFile } = await import('../src/portal/files.js');
  const says = async (who, text, hours, thread, attached = []) => {
    const author = await user(who.id);
    const files = [];
    for (const f of attached) {
      // eslint-disable-next-line no-await-in-loop
      files.push((await uploadFile(env, ch, author, f, ago(hours))).file.id);
    }
    return (await writeMessage(env, ch, author, { root: thread, text, files }, ago(hours))).id;
  };
  // Adobe's people have the pictures the inbox knows of them: here, made-up ones.
  const pictured = async (staff, bg, fg) => {
    const u = await row(staff.email);
    await setAvatar(env, u, { type: 'image/png', bytes: face(bg, fg) });
  };

  const welcome = (await platform.post(env, {
    ...at,
    author: STAFF[0],
    text: 'Welcome to Adobe Enterprise Support, Acme! This is your channel with the Edge ops team. Start a new thread for each question, and we answer you here.',
  }, ago(70))).id;
  await reactTo(env, ch, await user(dana.id), { id: welcome, emoji: '👍' }, ago(69));
  await pictured(STAFF[0], [20, 110, 100], [220, 245, 240]);

  const cache = await says(dana, 'Product pages are stale after publishing\nWe publish from Document Authoring, and `/products/anvil` still shows yesterday\'s price on the live site. Preview is right. The response times since the last publish, and the requests behind them:', 50, undefined, [
    { name: 'response-times.png', type: 'image/png', bytes: chart },
    {
      name: 'requests.csv',
      type: 'text/csv',
      bytes: new TextEncoder().encode('path,status,ms\n/products/anvil,200,231\n/products/hammer,200,244\n'),
    },
  ]);
  await platform.post(env, {
    ...at,
    root: cache,
    author: STAFF[1],
    text: 'Thanks, @Dana Diaz. Two questions:\n\n1. Is the price in the document itself, or does it come from a spreadsheet?\n2. Do you have a CDN of your own in front of the site?',
  }, ago(49));
  await says(dana, 'It comes from the `prices` sheet. And yes, we bring our own CDN.', 48.5, cache);
  await platform.post(env, {
    ...at,
    root: cache,
    author: STAFF[1],
    text: 'Then that is it: the sheet was published, but your CDN was not purged. Set up the push invalidation for it:\n\n```yaml\ncdn:\n  prod:\n    host: www.acme.example\n    type: managed\n```\n\nPublish the sheet again afterwards and the page follows.',
  }, ago(48));
  await says(lee, 'That did it, thank you! :tada:', 47, cache);
  await pictured(STAFF[1], [150, 80, 20], [250, 235, 215]);
  await platform.react(env, {
    ...at, id: cache, emoji: '✅', author: STAFF[1],
  }, ago(46));

  const migration = await says(lee, 'How do we move 4,000 PDFs into Assets?\nThey are on a file share today. Is there an importer, or do we script it?', 6);
  await platform.post(env, {
    ...at,
    root: migration,
    author: STAFF[0],
    text: 'There is a bulk import for that. @Dana Diaz, how are the PDFs organized today: by product, by year, or flat? That decides the folder mapping.',
  }, ago(1.5));

  await says(dana, 'Can we get a second site for the Benelux market?', 0.2);
}

await seed();

const read = (name) => readFileSync(join(root, 'ui', name), 'utf8');
const page = () => portalPage(read('portal.html'), Object.fromEntries(PORTAL_FILES
  .map((name) => [name, read(name)])));

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
  if (pathname === '/__dev/typing') {
    const latest = await env.DB.prepare(`SELECT c.id AS channel, m.root FROM messages m
      JOIN channels c ON c.id = m.channel ORDER BY m.at DESC LIMIT 1`).first();
    if (!latest) {
      return { error: 'no thread yet' };
    }
    // As the inbox says it: again every few seconds while they write.
    const say = () => platform.typing(env, {
      domain: DOMAIN, channel: latest.channel, root: latest.root, author: STAFF[1],
    });
    const again = setInterval(say, 3000);
    setTimeout(() => clearInterval(again), 10000);
    return say();
  }
  if (pathname === '/__dev/working' || pathname === '/__dev/draft') {
    const what = pathname.slice('/__dev/'.length);
    adobe[what] = !adobe[what];
    return { [what]: adobe[what] };
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
      // A file's bytes, a picture, or JSON: the answer as it is.
      const answer = await api(request, env, url, { email: ME });
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
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
