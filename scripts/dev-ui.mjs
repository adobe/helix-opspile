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
 *   node scripts/dev-ui.mjs --admin    # signed in as a member of the admin team
 *   node scripts/dev-ui.mjs --manager  # signed in as the manager of Edge ops, not an admin
 *   node scripts/dev-ui.mjs --big      # a prod-sized inbox (some 250 threads, long ones too)
 *   node scripts/dev-ui.mjs --latency=400  # every /api answer waits 400 ms, as production's do
 *
 * For scripts/perf-ui.mjs, `POST /__dev/simulate?thread=<key>` posts a message into a thread
 * (a random one without `thread`) and sends the live update, as the simulation does.
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
import { ICONS } from '../src/icons.js';
import { pwa } from '../src/pwa.js';
import { inboxPage as withEmoji } from '../src/page.js';
import { partnerOf, relationOf } from '../src/profiles.js';
import { resolution } from '../src/resolve.js';
import { readState, waitingOn } from '../src/threads.js';
import { createAdmin } from './dev-ui-admin.mjs';
import { createKnowledgeBases } from './dev-ui-kb.mjs';
import { createStore } from './dev-ui-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = join(root, 'ui');
const PORT = Number(process.env.PORT) || 8787;
const SIMULATE = !process.argv.includes('--no-sim');
// Dana in the admin team: the inbox shows the switch to the knowledge-base editor, "View as"
// (read-only) and label review.
const ADMIN = process.argv.includes('--admin');
// Dana manages Edge ops and is in no admin team: what team managers see.
const MANAGER = process.argv.includes('--manager');
const SIM_EVERY_MS = 25 * 1000;
const LATENCY_MS = Number(process.argv.find((a) => a.startsWith('--latency='))?.slice(10)) || 0;
// Pages of the inbox, as the Worker serves them (`before` cursor, `page.next`).
const INBOX_PAGE = Number((process.argv.find((a) => a.startsWith('--page=')) || '').slice(7)) || 100;
// What the admin team would say about the fake orgs (src/api.js: customer unless set).
const ORG_TYPES = { initech: 'vendor' };
const SESSION_FILE = join(root, '.dev-ui-session.json');
const VALIDATE_MS = 60 * 1000;

const store = createStore(Date.now(), { big: process.argv.includes('--big') });
const kb = await createKnowledgeBases();
const adminApi = createAdmin(store, { manager: MANAGER, bases: kb.list() });
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

// ---- reactions, as D1's `reactions` would hold them ---------------------------------------

// `${thread}|${message id}` -> [{ emoji, person, at }]. Every thank-you starts with a
// thumbs-up from a teammate; the oldest resolved-looking thread has a ✅ from one.
const reactions = new Map();
const PICKER_TEAMS = {
  thumbsup: '👍', heart: '❤️', joy: '😂', open_mouth: '😮', eyes: '👀', pray: '🙏', tada: '🎉', white_check_mark: '✅',
};
const CHECKS = new Set(['white_check_mark', '✅']);
const personNamed = (name) => [...store.people.values()].find((p) => p.name === name);
{
  const tom = personNamed('Tom Okafor');
  for (const entry of store.threads.values()) {
    for (const m of entry.messages) {
      if (/thank/i.test(m.body) && tom) {
        reactions.set(`${entry.key}|${m.id}`, [{ emoji: 'thumbsup', person: tom.id, at: m.at }]);
      }
    }
  }
  for (const entry of store.threads.values()) {
    // The big inbox (--big) comes with reactions of its own.
    for (const r of entry.reactionSeeds || []) {
      const who = [...store.people.values()].find((p) => p.key === r.by);
      const k = `${entry.key}|${r.id}`;
      const list = reactions.get(k) || [];
      reactions.set(k, [...list, { emoji: r.emoji, person: who.id, at: entry.row.any_at }]);
    }
  }
  const done = [...store.threads.values()]
    .find((e) => (store.labels.get(e.key)?.resolved_p ?? 0) >= 0.5 && e.row.root_at);
  if (done && tom) {
    reactions.set(`${done.key}|${done.row.root_id}`, [{ emoji: 'white_check_mark', person: tom.id, at: done.row.any_at }]);
  }
}

// Shared drafts, one per thread, as src/drafts.js keeps them in D1. Tom has one waiting.
const drafts = new Map();
{
  const tom = personNamed('Tom Okafor');
  const open = [...store.threads.values()]
    .find((e) => e.row.kind !== 'alert' && (store.labels.get(e.key)?.resolved_p ?? 0) < 0.5);
  if (open && tom) {
    const at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    drafts.set(open.key, {
      thread: open.key,
      body: 'Thanks for the details. We rolled back the config change; can you confirm it works now?',
      mentions: [],
      by: { id: tom.id, name: tom.name },
      created_at: at,
      updated_at: at,
    });
  }
}
const draftSummary = (d) => d && ({
  by: d.by,
  updated_at: d.updated_at,
  preview: d.body.length > 140 ? `${d.body.slice(0, 139)}…` : d.body,
});

function reactionsOn(key, id) {
  const out = [];
  for (const r of reactions.get(`${key}|${id}`) || []) {
    let e = out.find((x) => x.emoji === r.emoji);
    if (!e) {
      e = {
        emoji: r.emoji, count: 0, names: [], mine: false,
      };
      out.push(e);
    }
    e.count += 1;
    e.names.push(store.people.get(r.person)?.name || '?');
    e.mine = e.mine || r.person === ME;
  }
  return out;
}

/** As src/resolve.js derives it from D1: staff ✅ on the root, the latest customer message. */
function resolutionOf(entry) {
  const checks = (reactions.get(`${entry.key}|${entry.row.root_id}`) || [])
    .filter((r) => CHECKS.has(r.emoji) && store.people.get(r.person)?.staff)
    .map((r) => ({ at: r.at, person: r.person, name: store.people.get(r.person).name }));
  const customerAt = entry.messages
    .filter((m) => m.author.kind === 'person' && !m.author.staff && !m.deletedAt)
    .map((m) => m.at).sort().pop() || null;
  return resolution({ checks, customerAt }, store.labels.get(entry.key) || null, ME);
}

function setReaction(entry, id, emoji, remove) {
  const k = `${entry.key}|${id}`;
  const list = (reactions.get(k) || []).filter((r) => !(r.emoji === emoji && r.person === ME));
  if (!remove) {
    list.push({ emoji, person: ME, at: new Date().toISOString() });
  }
  reactions.set(k, list);
}

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

/** A person's identity key on a platform, like `messages.author_key`. */
const keyOf = (p, source) => `${source}:T-FAKE:${p ? p.key : 'bot'}`;

/** Profile cards for these identity keys, as src/profiles.js builds them from D1. */
function profiles(keys) {
  const out = {};
  for (const k of new Set(keys.filter(Boolean))) {
    const [source, , who] = k.split(':');
    const p = [...store.people.values()].find((x) => x.key === who);
    const domain = p ? p.email.split('@').pop() : null;
    const partner = partnerOf(domain, store.partners);
    out[k] = p ? {
      name: p.name,
      avatar: null,
      platform: source,
      kind: 'person',
      title: p.title || null,
      company: p.company || null,
      domain,
      relation: relationOf({}, { kind: 'person', staff: p.staff, email: p.email }, store.partners),
      partner: partner ? partner.name : null,
      teams: store.teams.filter((t) => t.members.includes(p.id)).map((t) => t.name),
    } : {
      name: 'Alertmanager', avatar: null, platform: source, kind: 'bot', relation: 'bot', teams: [],
    };
  }
  return out;
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
    participants: [...seen].slice(0, 5).map(([name, p]) => ({
      name, staff: Boolean(p?.staff), avatar: null, key: p ? keyOf(p, entry.ch.source) : null,
    })),
    customerDomain: domains[0] || null,
  };
}

function inbox(team, before = null) {
  const latest = (r) => r.last_at || r.any_at || '';
  const all = [...store.threads.values()]
    .map((e) => e.row)
    .filter((r) => r.team === team && r.kind !== 'ignore')
    .sort((a, b) => latest(b).localeCompare(latest(a)) || b.thread.localeCompare(a.thread));
  const [at, key] = before ? String(before).split('|') : [null, null];
  const after = at === null ? all
    : all.filter((r) => latest(r) < at || (latest(r) === at && r.thread < key));
  const pageRows = after.slice(0, INBOX_PAGE);
  const lastRow = pageRows[pageRows.length - 1];
  const page = { next: after.length > INBOX_PAGE && lastRow ? `${latest(lastRow)}|${lastRow.thread}` : null };
  const rows = pageRows
    .map((r) => ({
      ...r, root_known: r.root_at !== null, org_type: ORG_TYPES[r.org] || 'customer',
    }));
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
  const threads = readState(rows, marks, mentions, ME)
    .map((t) => ({
      ...t,
      label: store.labels.get(t.thread) || null,
      ...people(store.threads.get(t.thread)),
      members: [{ thread: t.thread, last_at: t.last_at, any_at: t.any_at }],
      posters: [...new Set(store.threads.get(t.thread).messages
        .map((m) => byName.get(m.author.name)?.id).filter(Boolean))],
      mentioned: store.mentions.filter((m) => m.thread === t.thread)
        .map((m) => ({ person: m.person, staff: Boolean(store.people.get(m.person)?.staff) })),
      reactions: Object.values(store.threads.get(t.thread).messages
        .flatMap((m) => reactionsOn(t.thread, m.id))
        .reduce((acc, r) => ({
          ...acc, [r.emoji]: { emoji: r.emoji, count: (acc[r.emoji]?.count || 0) + r.count },
        }), {})),
      resolution: resolutionOf(store.threads.get(t.thread)),
      draft: draftSummary(drafts.get(t.thread)) || null,
    }))
    .map((t) => ({ ...t, waiting_on: waitingOn(t) }));
  return {
    team,
    me: { id: ME, name: store.people.get(ME).name, readonly: false },
    profiles: profiles(threads.flatMap((t) => t.participants.map((p) => p.key))),
    people: Object.fromEntries([...store.people.values()]
      .map((p) => [p.id, {
        name: p.name, staff: p.staff, relation: relationOf({}, p, store.partners),
      }])),
    teams: Object.fromEntries(store.teams.filter((t) => t.members.includes(ME))
      .map((t) => [t.slug, { name: t.name, members: t.members }])),
    members: members(team),
    threads,
    page,
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
    .map(({ meta, body }) => ({
      ...meta,
      body,
      avatar: null,
      authorKey: meta.author.kind === 'system' ? null : keyOf(
        [...store.people.values()].find((p) => p.name === meta.author.name),
        entry.row.source,
      ),
      reactions: reactionsOn(key, meta.id),
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
    profiles: profiles(messages.map((m) => m.authorKey)),
    watermarks,
    label: store.labels.get(key) || null,
    model: store.labels.get(key) || null,
    reviews: [],
    facts: store.facts.get(key) || [],
    resolution: resolutionOf(entry),
    draft: drafts.get(key) || null,
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

/** The fake `/api/kb*` (src/kbadmin.js), over the in-memory knowledge bases. */
async function kbApi(req, res, url) {
  // A manager edits their teams' knowledge bases only, as in src/kbadmin.js.
  const allowed = (repo) => !MANAGER || repo === 'kb-team-edge';
  const body = req.method === 'GET' ? {} : await readJson(req);
  // The list (with its agent counts), the channels and their agents, and the agents' MCP
  // servers: src/kbadmin.js itself.
  if (['/api/kb', '/api/kb/channels', '/api/kb/agent'].includes(url.pathname)
    || url.pathname === '/api/kb/mcp' || url.pathname.startsWith('/api/kb/mcp/')) {
    const r = await adminApi.kb(req, url, req.method === 'GET' ? null : body);
    const out = await r.json();
    if (url.pathname === '/api/kb') {
      const names = new Map(kb.list().map((b) => [b.repo, b.name]));
      out.bases = out.bases.map((b) => ({ ...b, name: names.get(b.repo) || b.name }));
    }
    return json(res, out, r.status);
  }
  const repo = req.method === 'GET' ? url.searchParams.get('repo') : body.repo;
  if (!kb.has(repo) || !allowed(repo)) {
    return json(res, { error: 'no such knowledge base' }, 404);
  }
  if (url.pathname === '/api/kb/files') {
    const files = await kb.files(repo);
    return json(res, {
      repo, files, truncated: false, hasSystemPrompt: files.some((f) => f.path === 'systemprompt.md'),
    });
  }
  if (url.pathname === '/api/kb/log') {
    return json(res, { repo, commits: await kb.log(repo) });
  }
  if (url.pathname === '/api/kb/file' && req.method === 'GET') {
    const r = await kb.read(repo, url.searchParams.get('path'));
    return json(res, r, r.error ? 404 : 200);
  }
  if (url.pathname === '/api/kb/file') {
    const remove = req.method === 'DELETE';
    const base = body.base || null;
    const change = remove ? { path: body.path, delete: true, base }
      : {
        path: body.path, content: body.content, base, create: !base,
      };
    const message = body.message || `${remove ? 'Delete' : 'Update'} ${body.path}`;
    const r = await kb.write(repo, [change], {
      message, by: `human:${store.me.email}`, at: new Date().toISOString(), logEntry: `**Update**: ${message} (${store.me.name})`, author: { name: store.me.name, email: store.me.email },
    });
    if (r.error) {
      return json(res, { error: r.error }, 400);
    }
    if (r.conflict) {
      const current = await kb.read(repo, body.path);
      return json(res, { error: r.conflict, current: current.error ? null : current }, 409);
    }
    const now = remove ? null : await kb.read(repo, body.path);
    return json(res, {
      ok: true, commit: r.commit, unchanged: r.unchanged, hash: now && now.hash,
    });
  }
  return json(res, { error: 'not found' }, 404);
}

const teamsOf = (id) => store.teams.filter((t) => t.members.includes(id))
  .map(({ slug, name }) => ({ slug, name }));

/**
 * With `--admin`, whom an admin looks at the inbox as (`x-opspile-as`, or `as=`), as in
 * src/api.js; null for Dana herself.
 */
function viewingAs(req, url) {
  const as = Number(req.headers['x-opspile-as'] || url.searchParams.get('as'));
  return ADMIN && as && as !== ME ? store.people.get(as) || null : null;
}

async function api(req, res, url) {
  if (backendState.mode === 'prod') {
    return proxyApi(req, res, url, backendState);
  }
  const team = url.searchParams.get('team');
  const as = viewingAs(req, url);
  // As src/api.js: looking as someone else is read-only.
  if (as && req.method !== 'GET') {
    return json(res, { error: 'read-only while viewing as someone else' }, 403);
  }
  if (url.pathname === '/api/kb' || url.pathname.startsWith('/api/kb/')) {
    return kbApi(req, res, url);
  }
  if (url.pathname.startsWith('/api/admin/')) {
    const body = req.method === 'GET' ? null : await readJson(req);
    const r = await adminApi(req, url, body);
    return json(res, await r.json(), r.status);
  }
  if (url.pathname === '/api/me' && as) {
    return json(res, {
      id: as.id,
      name: as.name,
      email: as.email,
      teams: teamsOf(as.id),
      admin: false,
      viewer: { id: ME, name: store.me.name },
      readonly: true,
      connected: {},
      react: {},
    });
  }
  if (url.pathname === '/api/me') {
    const {
      id, name, email, teams,
    } = store.me;
    // Dana is not in the admin team (unless --admin), except on the admin pages, so they can
    // be tried.
    const admin = !MANAGER && (ADMIN || store.me.admin || /\/inbox\/(kb|admin)\b/.test(req.headers.referer || ''));
    // Fake mode: both accounts count as connected, so the composer can be tried out.
    return json(res, {
      id,
      name,
      email,
      teams: MANAGER ? teams.map((t) => ({ ...t, role: t.slug === 'edge' ? 'manager' : 'member' })) : teams,
      admin,
      manages: MANAGER ? ['edge'] : [],
      connected: { slack: true, teams: true },
      react: { slack: true, teams: true },
    });
  }
  if (url.pathname === '/api/people' && ADMIN) {
    // Everyone in a team, for "View as".
    return json(res, {
      people: [...store.people.values()]
        .filter((p) => store.teams.some((t) => t.members.includes(p.id)))
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  if (url.pathname === '/api/review/queue' && ADMIN) {
    // No labels in the fake data, so nothing to review.
    return json(res, { queue: [], answers: {} });
  }
  if (url.pathname.startsWith('/api/review') || url.pathname === '/api/people') {
    // The fake user is not in the admin team, so the review API answers as it does for her.
    return json(res, { error: 'label review is for the admin team' }, 403);
  }
  if (url.pathname === '/api/inbox' && as) {
    // Dana's inbox of that team, marked as theirs: enough to try the read-only view.
    if (!teamsOf(as.id).some((t) => t.slug === team)) {
      return json(res, { error: 'not a member of this team' }, 403);
    }
    return json(res, { ...inbox(team, url.searchParams.get('before')), me: { id: as.id, name: as.name, readonly: true } });
  }
  if (url.pathname === '/api/inbox') {
    if (!inTeam(team)) {
      return json(res, { error: 'not a member of this team' }, 403);
    }
    return json(res, inbox(team, url.searchParams.get('before')));
  }
  if (url.pathname === '/api/thread') {
    const result = thread(url.searchParams.get('thread'));
    return result ? json(res, result) : json(res, { error: 'not found' }, 404);
  }
  if (url.pathname === '/api/agent' && req.method === 'GET') {
    // The thread agent's latest turn (src/agent/turn.js), made up: in ACME's channel, it works
    // for a few seconds after the thread is first asked about, then leaves a note.
    const entry = store.threads.get(url.searchParams.get('thread'));
    if (!entry || !inTeam(entry.row.team)) {
      return json(res, { error: 'not found' }, 404);
    }
    if (entry.row.channel_id !== 'C0ACMEAEM') {
      return json(res, { enabled: false });
    }
    entry.agentAsked ??= Date.now();
    const startedAt = new Date(entry.agentAsked).toISOString();
    const turn = Date.now() - entry.agentAsked < 8000
      ? {
        state: 'working', text: 'Checking a web page', startedAt, endedAt: null,
      }
      : {
        state: 'done',
        startedAt,
        endedAt: new Date(entry.agentAsked + 8000).toISOString(),
        text: 'www.acme.example answers 503 on /en/* and /de/*; preview is fine, so it is the CDN config from the 14:00 flush, not the origin.\n\n'
          + '- Updated the draft: asks Sam for one failing request id, links the purge docs\n'
          + '- Filed *cdn-503-after-config-change* in the ACME knowledge base',
      };
    return json(res, { enabled: true, turn });
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
  if (url.pathname === '/api/draft' && (req.method === 'PUT' || req.method === 'DELETE')) {
    // As src/drafts.js: `base` is the version the text was written from.
    const {
      thread: key, text: body, mentions = [], base = null,
    } = await readJson(req);
    const entry = store.threads.get(key);
    if (!entry || !inTeam(entry.row.team)) {
      return json(res, { error: 'not found' }, 404);
    }
    const current = drafts.get(key);
    const conflict = () => json(res, {
      error: `${current.by.name} changed this draft meanwhile`, conflict: true, draft: current,
    }, 409);
    if (req.method === 'DELETE') {
      if (current && base && current.updated_at !== base) {
        return conflict();
      }
      drafts.delete(key);
      broadcast(entry.row.team, { type: 'draft', thread: key });
      return json(res, { ok: true, discarded: Boolean(current), draft: current || null });
    }
    if (!String(body || '').trim()) {
      return json(res, { error: 'write something to save (up to 8000 characters)' }, 400);
    }
    if (current && current.updated_at !== base) {
      return conflict();
    }
    const at = new Date().toISOString();
    const me = store.people.get(ME);
    const draft = {
      thread: key,
      body,
      mentions,
      by: { id: ME, name: me.name },
      created_at: current ? current.created_at : at,
      updated_at: at,
    };
    drafts.set(key, draft);
    console.log(`draft saved on ${key}`);
    broadcast(entry.row.team, { type: 'draft', thread: key });
    return json(res, { ok: true, draft });
  }
  if (url.pathname === '/api/post' && req.method === 'POST') {
    const {
      thread: key, text: reply, mentions = [], draft: base,
    } = await readJson(req);
    if (base && drafts.get(key)?.updated_at === base) {
      drafts.delete(key);
    }
    if (mentions.length) {
      console.log(`post mentions ${JSON.stringify(mentions)}`);
    }
    const entry = store.threads.get(key);
    if (!entry || !inTeam(entry.row.team) || !String(reply || '').trim()) {
      return json(res, { error: 'not found' }, 404);
    }
    // As the real reply would: it arrives a moment later, like a platform event, with the
    // platform's id, and on Slack with emoji as :shortcodes: and _italics_ as Slack writes them.
    const at = new Date();
    const id = store.newId(key, at.getTime());
    const arrived = entry.row.source === 'slack'
      ? String(reply).trim().replace(/🤖/g, ':robot_face:').replace(/🥁/g, ':drum_with_drumsticks:')
        .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1_$2_')
      : String(reply).trim();
    setTimeout(() => {
      store.post(key, 'dana', arrived, at.toISOString(), id);
      broadcast(entry.row.team, { type: 'thread', thread: key });
    }, 1200);
    return json(res, { ok: true, platform: entry.row.source, id });
  }
  if (url.pathname === '/api/react' && req.method === 'POST') {
    const {
      thread: key, id, emoji, remove,
    } = await readJson(req);
    const entry = store.threads.get(key);
    if (!entry || !inTeam(entry.row.team) || !entry.messages.some((m) => m.id === id) || !emoji) {
      return json(res, { error: 'not found' }, 404);
    }
    const native = entry.row.source === 'teams' ? PICKER_TEAMS[emoji] || emoji : emoji;
    setReaction(entry, id, native, remove);
    console.log(`react ${remove ? '-' : '+'}${native}`);
    broadcast(entry.row.team, { type: 'thread', thread: key });
    return json(res, { ok: true, emoji: native });
  }
  if (url.pathname === '/api/resolve' && req.method === 'POST') {
    const { thread: key, undo } = await readJson(req);
    const entry = store.threads.get(key);
    if (!entry || !inTeam(entry.row.team)) {
      return json(res, { error: 'not found' }, 404);
    }
    if (!entry.row.root_at) {
      return json(res, { error: 'the first message of this thread is not known yet' }, 409);
    }
    const emoji = entry.row.source === 'teams' ? '✅' : 'white_check_mark';
    const mine = (reactions.get(`${key}|${entry.row.root_id}`) || [])
      .some((r) => r.person === ME && CHECKS.has(r.emoji));
    if (undo && !mine) {
      return json(res, { error: 'you have not resolved this thread; only whoever did can undo it' }, 409);
    }
    setReaction(entry, entry.row.root_id, emoji, true);
    if (!undo) {
      setReaction(entry, entry.row.root_id, emoji, false);
    }
    console.log(`resolve ${undo ? 'undo' : ''}`);
    broadcast(entry.row.team, { type: 'thread', thread: key });
    return json(res, { ok: true, resolved: !undo });
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
  const html = withEmoji(await readFile(join(uiDir, 'inbox.html'), 'utf8'));
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
    if (file && !['inbox.html', 'kb.html', 'admin.html'].includes(file)) {
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

/** A new message in a random conversation, or in `key` (POST /__dev/simulate?thread=). */
function simulate(key) {
  const live = [...store.threads.values()].filter((e) => e.row.kind === 'channel');
  const entry = store.threads.get(key) || live[Math.floor(Math.random() * live.length)];
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
    if (url.pathname === '/inbox/kb' || url.pathname === '/inbox/admin') {
      const html = await readFile(join(uiDir, url.pathname === '/inbox/kb' ? 'kb.html' : 'admin.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(html.replace('</body>', `${banner()}${RELOAD_CLIENT}\n</body>`));
      return;
    }
    if (url.pathname === '/inbox') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(await inboxPage());
      return;
    }
    if (ICONS[url.pathname]) {
      const { type, base64 } = ICONS[url.pathname];
      res.writeHead(200, { 'content-type': type }).end(Buffer.from(base64, 'base64'));
      return;
    }
    // The manifest and the service worker, as the Worker serves them.
    const app = pwa({ method: req.method }, url.pathname);
    if (app) {
      res.writeHead(app.status, Object.fromEntries(app.headers)).end(await app.text());
      return;
    }
    if (url.pathname === '/__dev/simulate' && req.method === 'POST') {
      simulate(url.searchParams.get('thread'));
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__dev/reload') {
      reloadStream(req, res);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (LATENCY_MS) {
        await new Promise((r) => {
          setTimeout(r, LATENCY_MS);
        });
      }
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
