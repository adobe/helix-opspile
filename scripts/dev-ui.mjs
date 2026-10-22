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
 * Local, live-reloading preview of the inbox UI with fake data.
 *
 *   npm run ui:dev                 # http://localhost:8787/inbox
 *   PORT=9000 npm run ui:dev
 *   node scripts/dev-ui.mjs --no-sim   # no simulated incoming messages
 *
 * What is shared with the Worker: `ui/inbox.html`, served from disk on every request (the
 * Worker imports the same file), and the pure helpers `readState`, `waitingOn`, `titleOf`
 * (src/threads.js) and `parse`, `render` (src/channels.js). What is replaced: D1, R2, the
 * TeamRoom Durable Object and Cloudflare Access, which are an in-memory store
 * (dev-ui-fixtures.mjs) and "signed in as Dana".
 *
 * With a production session (see scripts/dev-ui-session.mjs), `/api/*` is proxied to the
 * production Worker instead, read-only, and the page's banner says so.
 *
 * Saving `ui/inbox.html` reloads the page. `npm run ui:dev` runs this file under
 * `node --watch`, so saving anything under `scripts/` or `src/` restarts the server with
 * fresh fake data, and the page reloads once it is back.
 */

import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/channels.js';
import { readState, waitingOn } from '../src/threads.js';
import { createStore } from './dev-ui-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = join(root, 'ui');
const PORT = Number(process.env.PORT) || 8787;
const SIMULATE = !process.argv.includes('--no-sim');
const SIM_EVERY_MS = 25 * 1000;
const INBOX_LIMIT = 200;
const SESSION_FILE = join(root, '.dev-ui-session.json');
const VALIDATE_MS = 60 * 1000;

const store = createStore();
const ME = store.me.id;
const sockets = new Map(); // team slug -> Set of WebSocket-ish sockets
const reloadClients = new Set();

// Which backend answers: the presence of a session file selects production, read-only.
let backendState = { mode: 'fake' };
let validation = { key: '', at: 0, ok: false };

/**
 * Reads the session file on every request. A session the production Worker does not accept
 * falls back to fake data, and the page says so.
 */
async function refreshBackend() {
  const session = await readFile(SESSION_FILE, 'utf8')
    .then((s) => JSON.parse(s))
    .catch(() => null);
  let next = { mode: 'fake' };
  if (session?.origin && session?.cookie) {
    const key = `${session.origin}|${session.cookie}`;
    if (validation.key !== key || Date.now() - validation.at > VALIDATE_MS) {
      const ok = await fetch(`${session.origin}/api/me`, {
        headers: { cookie: session.cookie, accept: 'application/json' },
        redirect: 'manual',
      }).then((r) => r.status === 200, () => false);
      validation = { key, at: Date.now(), ok };
    }
    next = validation.ok
      ? { mode: 'prod', origin: session.origin, cookie: session.cookie }
      : { mode: 'fake', expired: true };
  }
  if (next.mode !== backendState.mode || next.expired !== backendState.expired) {
    const names = { prod: 'production API (read-only)', fake: 'fake data' };
    const why = next.expired ? ' (the production session was not accepted)' : '';
    console.log(`[backend] ${names[next.mode]}${why}`);
  }
  backendState = next;
}

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
  return true;
};

const text = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
  return true;
};

const inTeam = (team) => store.teams.some((t) => t.slug === team && t.members.includes(ME));

// ---- live events -----------------------------------------------------------------------

function broadcast(team, event) {
  const data = JSON.stringify(event);
  for (const socket of sockets.get(team) || []) {
    socket.send(data);
  }
}

// ---- API, the same shapes as src/api.js -----------------------------------------------

function members(team) {
  return store.teams.find((t) => t.slug === team).members
    .map((id) => store.people.get(id))
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Thread participants and the customer's domain, the way src/api.js derives them. */
function people(entry) {
  const seen = new Map();
  for (const m of [...entry.messages].sort((a, b) => a.at.localeCompare(b.at))) {
    if (m.author.kind === 'person' && !m.deletedAt && !seen.has(m.author.name)) {
      seen.set(m.author.name, [...store.people.values()].find((p) => p.name === m.author.name));
    }
  }
  const domains = [...seen.values()].filter((p) => p && !p.staff).map((p) => p.email.split('@').pop());
  return {
    participants: [...seen].slice(0, 5)
      .map(([name, p]) => ({ name, staff: Boolean(p?.staff), avatar: null })),
    customerDomain: domains[0] || null,
  };
}

function inbox(team) {
  const rows = [...store.threads.values()]
    .map((e) => e.row)
    .filter((r) => r.team === team && r.kind !== 'ignore')
    .sort((a, b) => (b.last_at || b.any_at || '').localeCompare(a.last_at || a.any_at || ''))
    .slice(0, INBOX_LIMIT)
    .map((r) => ({ ...r, root_known: r.root_at !== null }));
  const teamIds = new Set(members(team).map((m) => m.id));
  const keys = new Set(rows.map((r) => r.thread));
  // As in src/api.js: the team's marks, plus every staff member's (for "unseen by Adobe").
  const marks = [...store.watermarks.values()]
    .filter((w) => keys.has(w.thread)
      && (teamIds.has(w.person) || store.people.get(w.person).staff))
    .map((w) => ({
      person: w.person,
      thread: w.thread,
      read_at: w.read_at,
      staff: store.people.get(w.person).staff ? 1 : 0,
      in_team: teamIds.has(w.person) ? 1 : 0,
    }));
  const mentions = store.mentions.filter((m) => keys.has(m.thread) && teamIds.has(m.person));
  const byName = new Map([...store.people.values()].map((p) => [p.name, p]));
  return {
    team,
    me: { id: ME, name: store.people.get(ME).name, readonly: false },
    people: Object.fromEntries([...store.people.values()]
      .map((p) => [p.id, { name: p.name, staff: p.staff }])),
    teams: Object.fromEntries(store.teams.filter((t) => t.members.includes(ME))
      .map((t) => [t.slug, { name: t.name, members: t.members }])),
    members: members(team),
    threads: readState(rows, marks, mentions, ME)
      .map((t) => ({
        ...t,
        label: store.labels.get(t.thread) || null,
        ...people(store.threads.get(t.thread)),
        members: [{ thread: t.thread, last_at: t.last_at, any_at: t.any_at }],
        posters: [...new Set(store.threads.get(t.thread).messages
          .map((m) => byName.get(m.author.name)?.id).filter(Boolean))],
        mentioned: store.mentions.filter((m) => m.thread === t.thread)
          .map((m) => ({ person: m.person, staff: Boolean(store.people.get(m.person)?.staff) })),
      }))
      .map((t) => ({ ...t, waiting_on: waitingOn(t) })),
  };
}

function thread(key) {
  const entry = store.threads.get(key);
  if (!entry || !inTeam(entry.row.team)) {
    return null;
  }
  const teamIds = new Set(members(entry.row.team).map((m) => m.id));
  const messages = [...store.files.entries()]
    .filter(([path]) => path.startsWith(entry.row.path))
    .map(([, body]) => parse(body))
    .filter(Boolean)
    // Fake reactions: a thumbs-up from a teammate on every thank-you.
    .map(({ meta, body }) => ({
      ...meta,
      body,
      avatar: null,
      reactions: /thank/i.test(body) ? [{ emoji: 'thumbsup', count: 1, names: ['Tom Okafor'] }] : [],
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const watermarks = [...store.watermarks.values()]
    .filter((w) => w.thread === key && teamIds.has(w.person))
    .map(({ person, read_at: readAt, via }) => ({
      person, thread: key, read_at: readAt, via,
    }));
  return {
    thread: entry.row,
    members: [{
      thread: key, root_at: entry.row.root_at, last_at: entry.row.last_at, any_at: entry.row.any_at,
    }],
    messages,
    watermarks,
    label: store.labels.get(key) || null,
    model: store.labels.get(key) || null,
    reviews: [],
    facts: store.facts.get(key) || [],
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** Forwards a GET to production with the session cookie. Nothing is written there. */
async function proxyApi(req, res, url, b) {
  if (req.method !== 'GET') {
    // A read mark would show up for the whole team, so the preview does not send one.
    return json(res, { error: 'read-only: the local preview does not write to production' }, 403);
  }
  const upstream = await fetch(`${b.origin}${url.pathname}${url.search}`, {
    headers: { cookie: b.cookie, accept: 'application/json' },
    redirect: 'manual',
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(res, { error: 'production session expired: run npm run ui:session' }, 401);
  }
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
  return true;
}

async function api(req, res, url) {
  if (backendState.mode === 'prod') {
    return proxyApi(req, res, url, backendState);
  }
  const team = url.searchParams.get('team');
  if (url.pathname === '/api/me') {
    const {
      id, name, email, teams, admin,
    } = store.me;
    // Fake mode: both accounts count as connected, so the composer can be tried out.
    return json(res, {
      id, name, email, teams, admin, connected: { slack: true, teams: true },
    });
  }
  if (url.pathname.startsWith('/api/review')) {
    // The fake user is not in the admin team, so the review API answers as it does for her.
    return json(res, { error: 'label review is for the admin team' }, 403);
  }
  if (url.pathname === '/api/inbox') {
    if (!inTeam(team)) {
      return json(res, { error: 'not a member of this team' }, 403);
    }
    return json(res, inbox(team));
  }
  if (url.pathname === '/api/thread') {
    const result = thread(url.searchParams.get('thread'));
    return result ? json(res, result) : json(res, { error: 'not found' }, 404);
  }
  if (url.pathname === '/api/mentionable') {
    // As D1 would answer: known people, those who posted in the thread first, then staff.
    const entry = store.threads.get(url.searchParams.get('thread'));
    if (!entry || !inTeam(entry.row.team)) {
      return json(res, { error: 'not found' }, 404);
    }
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const here = new Set(thread(entry.row.thread).messages.map((m) => m.author && m.author.name));
    const found = [...store.people.values()]
      .filter((p) => !q || p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(` ${q}`))
      .map((p) => ({
        id: `${entry.row.source}-${p.key}`, name: p.name, avatar: null, here: here.has(p.name), staff: p.staff,
      }))
      .sort((a, b) => (b.here - a.here) || (b.staff - a.staff) || a.name.localeCompare(b.name))
      .slice(0, 8);
    return json(res, { platform: entry.row.source, people: found });
  }
  if (url.pathname === '/api/post' && req.method === 'POST') {
    const { thread: key, text: reply, mentions = [] } = await readJson(req);
    if (mentions.length) {
      console.log(`post mentions ${JSON.stringify(mentions)}`);
    }
    const entry = store.threads.get(key);
    if (!entry || !inTeam(entry.row.team) || !String(reply || '').trim()) {
      return json(res, { error: 'not found' }, 404);
    }
    // As the real reply would: it arrives a moment later, like a platform event.
    setTimeout(() => {
      store.post(key, 'dana', String(reply).trim());
      broadcast(entry.row.team, { type: 'thread', thread: key });
    }, 1200);
    return json(res, { ok: true, platform: entry.row.source, id: 'fake' });
  }
  if (url.pathname === '/api/read' && req.method === 'POST') {
    const { thread: key, at } = await readJson(req);
    const entry = store.threads.get(key);
    if (!entry || !inTeam(entry.row.team) || typeof at !== 'string') {
      return json(res, { error: 'not found' }, 404);
    }
    store.read(ME, key, at);
    broadcast(entry.row.team, {
      type: 'read', person: ME, thread: key, at,
    });
    res.writeHead(204).end();
    return true;
  }
  return false;
}

// ---- WebSocket (RFC 6455, text frames only, no dependencies) ---------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/* The framing below is bit-level by nature. */
/* eslint-disable no-bitwise */
/** Splits complete frames off the buffer. Client frames are masked. */
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) {
      break;
    }
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) {
        break;
      }
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) {
        break;
      }
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < p + 4) {
        break;
      }
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) {
      break;
    }
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) {
      for (let i = 0; i < len; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}
/* eslint-enable no-bitwise */

function handleClientMessage(team, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.type === 'read' && store.threads.get(msg.thread)) {
    store.read(ME, msg.thread, msg.at);
    broadcast(team, {
      type: 'read', person: ME, thread: msg.thread, at: msg.at,
    });
  }
}

/** Answers the handshake. Returns false, after refusing, when this is not a WebSocket request. */
function acceptUpgrade(req, socket) {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return false;
  }
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
    + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return true;
}

/** Calls `onText` for each text frame from the browser, and answers pings and closes. */
function readFrames(socket, onText) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    const parsed = parseFrames(Buffer.concat([pending, chunk]));
    pending = parsed.rest;
    for (const f of parsed.frames) {
      if (f.opcode === 0x8) {
        socket.end();
      } else if (f.opcode === 0x9) {
        socket.write(Buffer.from([0x8a, f.payload.length, ...f.payload]));
      } else if (f.opcode === 0x1) {
        onText(f.payload.toString('utf8'));
      }
    }
  });
}

function fakeLive(req, socket, team) {
  if (!inTeam(team) || !acceptUpgrade(req, socket)) {
    return;
  }
  const conn = {
    send: (data) => socket.write(frame(data)),
  };
  if (!sockets.has(team)) {
    sockets.set(team, new Set());
  }
  sockets.get(team).add(conn);
  const drop = () => sockets.get(team)?.delete(conn);
  socket.on('close', drop);
  socket.on('error', drop);
  readFrames(socket, (data) => handleClientMessage(team, data));
}

/**
 * Relays the production team socket to the browser. Messages from the browser are dropped:
 * the preview never marks anything read in production.
 */
function relayLive(req, socket, team, b) {
  if (!acceptUpgrade(req, socket)) {
    return;
  }
  const upstream = new WebSocket(
    `${b.origin.replace(/^https/, 'wss')}/api/live?team=${encodeURIComponent(team)}`,
    { headers: { cookie: b.cookie } },
  );
  upstream.onmessage = (e) => socket.write(frame(String(e.data)));
  upstream.onopen = () => console.log(`[live] production socket open (${team})`);
  upstream.onerror = () => socket.end();
  upstream.onclose = (e) => {
    console.log(`[live] production socket closed (${e.code})`);
    socket.end();
  };
  socket.on('close', () => upstream.close());
  socket.on('error', () => upstream.close());
  readFrames(socket, () => {});
}

function upgrade(req, socket, url) {
  const team = url.searchParams.get('team');
  if (backendState.mode === 'prod') {
    relayLive(req, socket, team, backendState);
  } else {
    fakeLive(req, socket, team);
  }
}

// ---- live reload -----------------------------------------------------------------------

const RELOAD_CLIENT = `<script>(() => {
  const es = new EventSource('/__dev/reload');
  let lost = false;
  es.onerror = () => { lost = true; };
  es.onopen = () => { if (lost) location.reload(); };
  es.onmessage = () => location.reload();
})();</script>`;

function banner() {
  const prod = backendState.mode === 'prod';
  const label = prod
    ? 'production API · read-only'
    : `fake data${backendState.expired ? ' · production session not accepted: npm run ui:session' : ''}`;
  const color = prod ? '#2e9e5b' : '#b4540a';
  return '<div id="dev-banner" style="position:fixed;left:8px;bottom:8px;z-index:9999;'
    + `font:12px system-ui;padding:3px 8px;border-radius:6px;background:${color};color:#fff">`
    + `${label}</div>`;
}

async function inboxPage() {
  const html = await readFile(join(uiDir, 'inbox.html'), 'utf8');
  return html.replace('</body>', `${banner()}${RELOAD_CLIENT}\n</body>`);
}

function reloadStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  reloadClients.add(res);
  req.on('close', () => reloadClients.delete(res));
}

function watchUi() {
  let timer;
  watch(uiDir, (event, file) => {
    if (file && file !== 'inbox.html') {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of reloadClients) {
        res.write('data: reload\n\n');
      }
      console.log(`[ui] ${file || 'inbox.html'} changed, reloading ${reloadClients.size} page(s)`);
    }, 100);
  });
}

// ---- simulated traffic -----------------------------------------------------------------

const LINES = [
  'Still seeing it on the second region too.',
  'Rolled back the change, watching the error rate now.',
  'Can we get an ETA on this? Our on-call is asking.',
  'Confirmed fixed on our side, thanks!',
  'Opened a ticket, linking it here.',
];

function simulate() {
  const live = [...store.threads.values()].filter((e) => e.row.kind === 'channel');
  const entry = live[Math.floor(Math.random() * live.length)];
  const teamMembers = members(entry.row.team).map((m) => store.people.get(m.id));
  // Customers of the thread's org answer sometimes, staff the rest of the time.
  const customers = [...store.people.values()].filter((p) => p.org === entry.row.org);
  const pool = customers.length && Math.random() < 0.5 ? customers : teamMembers;
  const sender = pool[Math.floor(Math.random() * pool.length)];
  const body = LINES[Math.floor(Math.random() * LINES.length)];
  store.post(entry.row.thread, sender.key, body);
  broadcast(entry.row.team, { type: 'thread', thread: entry.row.thread });
  console.log(`[sim] ${sender.name} in ${entry.row.channel_name}`);
}

// ---- server ----------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    await refreshBackend();
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/inbox' }).end();
      return;
    }
    if (url.pathname === '/inbox') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(await inboxPage());
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__dev/reload') {
      reloadStream(req, res);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!(await api(req, res, url))) {
        json(res, { error: 'not found' }, 404);
      }
      return;
    }
    text(res, 'not found\n', 404);
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/live') {
    upgrade(req, socket, url);
  } else {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  }
});

watchUi();
if (SIMULATE) {
  setInterval(() => {
    if (backendState.mode === 'fake') {
      simulate();
    }
  }, SIM_EVERY_MS).unref();
}

await refreshBackend();
server.listen(PORT, () => {
  console.log(`opspile UI preview: http://localhost:${PORT}/inbox`);
  if (backendState.mode === 'fake') {
    console.log(`signed in as ${store.me.name}; ${SIMULATE ? `new messages every ${SIM_EVERY_MS / 1000}s` : 'no simulated messages'}`);
  }
});
