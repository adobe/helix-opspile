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

/*
 * The admin team's pages for ops teams (#17) and orgs (#18), over /api/admin (src/admin.js).
 *
 * Team managers (and every member of a self-managed team) see the teams they manage, add and
 * remove members and promote or demote them, and ask the admin team for channels (a request:
 * they pick one in the same search the admin team adds channels with). The admin team confirms
 * or declines the requests under Requests; the rest is for the admin team.
 *
 * Teams: create, rename and delete teams; add members (found by name or email) and remove
 * them; the rules that file channels under the team (a channel-name prefix like `aem-`, a
 * Teams team name, a Slack Connect team id); and manual assignments of single channels. Orgs: display name, icon and
 * type (customer, partner, vendor), and manual assignments. Changes apply at once, without
 * asking (the status line names the channels a rule change moved), and go to the API one
 * after the other, so many can be made in a row (see `serial`). Text fields save when they
 * change. A change updates the open page in place (see "view state"); nothing reloads.
 */
const state = {
  me: null, tab: 'teams', listError: '', teams: [], unassigned: null, orgs: [], types: [], sel: null, filter: '', view: null,
  requests: [], openRequests: 0, names: {}, noIcon: false,
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const favicon = (icon) => (/^https:\/\//.test(icon) ? icon : `/api/admin/favicon?domain=${encodeURIComponent(icon)}`);
// The domains whose favicon did not load: Google has none (the Worker answers 404 for its
// globe, src/favicons.js). Learned as the icons load (the error listener at the start).
const missing = new Set();
/**
 * An org's icon as the inbox shows it: its own, else the favicon of its usual mail domain
 * (`domain`), else none, which the list shows as an empty square.
 */
const ico = (icon, domain) => {
  const shown = icon || domain;
  if (!shown || missing.has(shown)) return `<span class="ico none" title="${shown ? `No favicon for ${esc(shown)}` : 'No icon'}"></span>`;
  const title = icon || `The favicon of ${domain}, the mail domain of its people`;
  return `<img class="ico" src="${esc(favicon(shown))}" data-icon="${esc(shown)}" alt="" title="${esc(title)}">`;
};
/** Whether an org has no icon the inbox can show (as far as the page knows). */
const iconless = (o) => { const shown = o.icon || o.domain; return !shown || missing.has(shown); };
const ago = (at) => {
  if (!at) return '';
  const d = (Date.now() - Date.parse(at)) / 86400000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 60 ? `${Math.round(d)} days ago` : new Date(at).toLocaleDateString();
};
const FIELD_LABEL = {
  name: 'Channel name', group_name: 'Teams team or Discord server name', connected: 'Slack Connect team id', channel_id: 'Channel id',
};
const UNASSIGNED = '_unassigned';
/** From this probability on, Clef says an icon is the org's (src/favicons.js). */
const FITS = 0.5;

async function send(path, method, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: data };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The status line of the open page: the last thing done, every failure since the current
// burst of changes began (the successes after them do not hide them), and how many changes
// are still on their way.
let note = { kind: '', text: '' };
const failures = [];
const queue = { tail: Promise.resolve(), pending: 0 };
function showStatus() {
  const el = $('status');
  if (!el) return;
  const saving = queue.pending ? `Saving ${queue.pending} change${queue.pending === 1 ? '' : 's'}…` : '';
  el.className = `status ${failures.length ? 'err' : note.kind}`;
  el.textContent = [...failures, note.text, saving].filter(Boolean).join(' · ');
}
function status(kind, text) {
  if (kind === 'err') {
    failures.push(text);
    if (failures.length > 5) failures.shift();
  } else {
    note = { kind, text };
  }
  showStatus();
}
const failed = (what, r) => status('err', `${what}: ${r.body.error || `failed (${r.status})`}`);

/**
 * Changes go out one after the other, in the order they were made, while the page stays
 * usable: a burst of clicks is a queue, not a race. Two rule changes at once would each be
 * planned without the other, and an undo could overtake what it undoes.
 */
function serial(fn) {
  // A new burst: the failures of the last one were seen.
  if (!queue.pending) failures.length = 0;
  queue.pending += 1;
  showStatus();
  const run = queue.tail.then(fn).finally(() => {
    queue.pending -= 1;
    showStatus();
  });
  queue.tail = run.catch(() => {});
  return run;
}

/**
 * An API call. GETs go out at once, changes through the queue (`parallel` skips it). A
 * request that was not served is sent again: a 429 always, a 503 or a lost connection when
 * sending it twice cannot do a thing twice (`idempotent`). Answers `ok: false` on failure,
 * never throws.
 */
// eslint-disable-next-line default-param-last -- call(path) reads, call(path, 'POST', body) writes
async function call(path, method = 'GET', body, { parallel = false, idempotent = method !== 'POST' } = {}) {
  const attempt = async () => {
    for (let i = 0; ; i += 1) {
      let r;
      try {
        // The attempts are one after the other, with a pause between them.
        // eslint-disable-next-line no-await-in-loop
        r = await send(path, method, body);
      } catch (e) {
        r = { ok: false, status: 0, body: { error: `no answer (${e.message}), it may not have been saved` } };
      }
      const again = r.status === 429 || (idempotent && (r.status === 0 || r.status === 503));
      if (!again || i >= 3) return r;
      // eslint-disable-next-line no-await-in-loop
      await sleep(500 * 2 ** i);
    }
  };
  return method === 'GET' || parallel ? attempt() : serial(attempt);
}

/**
 * Runs `fn` once at a time per `key` (a button clicked twice, a channel picked again while
 * it is being added); renders draw the buttons of a busy key disabled (`off`).
 */
const busy = new Set();
async function once(key, fn) {
  if (busy.has(key)) return null;
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}
const off = (key) => (busy.has(key) ? ' disabled' : '');
/** Runs `fn` with the button `b` disabled meanwhile (a render may have replaced it since). */
function press(b, fn) {
  b.disabled = true;
  return Promise.resolve(fn()).finally(() => { if (b.isConnected) b.disabled = false; });
}
/** `once`, with the button `b` disabled meanwhile. */
const hold = (b, key, fn) => press(b, () => once(key, fn));

const orgLabel = (slug) => {
  const o = state.orgs.find((x) => x.slug === slug);
  return o && o.name ? o.name : slug;
};
// The admin team holds the channels no other team has (yet); adding a team to one of those
// moves it, adding a team to any other channel shares it (src/shares.js).
const isHolding = (slug) => !slug || slug === UNASSIGNED || slug === 'admin';
const teamLabel = (slug) => (slug === UNASSIGNED ? 'Unassigned' : (state.teams.find((t) => t.slug === slug)?.name || state.names[slug] || slug));

/** The channels a rule change moved, in a few words. */
function movesText(moves) {
  const to = [...new Set(moves.map((m) => teamLabel(m.to.team)))].join(', ');
  return `${moves.slice(0, 5).map((m) => plainName(m.channel)).join(', ')}${moves.length > 5 ? ` and ${moves.length - 5} more` : ''} → ${to}`;
}

/**
 * A rule change, applied at once: the answer lists the channels it moved, which the status
 * line names and the page re-files in place. Returns the answer, or null when refused.
 */
async function ruleChange(method, path, body, what = 'Rule change') {
  const done = await call(path, method, body, { idempotent: method !== 'POST' || path === '/api/admin/assign' });
  if (!done.ok) { failed(what, done); return null; }
  const { moves } = done.body;
  // An assignment names its channel already; a rule says which channels it moved.
  const which = path === '/api/admin/assign' ? '' : ` (${movesText(moves)})`;
  status('ok', moves.length ? `${what}: re-filing ${moves.length} channel${moves.length === 1 ? '' : 's'}${which}.` : `${what}: saved, no channel moves.`);
  return done.body;
}

// ---- navigation ---------------------------------------------------------------------------

// What is picked on each tab, in the URL.
const PARAM = { teams: 'team', orgs: 'org', requests: 'request' };
const PICK = { teams: 'a team', orgs: 'an org', requests: 'a request' };
function toUrl() {
  const q = new URLSearchParams({ tab: state.tab });
  if (state.sel) q.set(PARAM[state.tab], state.sel);
  history.replaceState(null, '', `/inbox/admin?${q}`);
  // Phones show the list or what is picked in it (see the styles).
  document.body.classList.toggle('picked', Boolean(state.sel));
}

/**
 * Teams, Orgs and Requests are pages of the header (ui/header.js), each opening as it was
 * left: one of them, from its address, without loading the page again. Going to another is a
 * new history entry (`push`), so Back returns to the one before.
 */
function openUrl(url, { push = true } = {}) {
  const q = new URL(url, location.origin).searchParams;
  const tab = ['orgs', 'requests'].includes(q.get('tab')) && state.me.admin ? q.get('tab') : 'teams';
  if (push) history.pushState(null, '', url);
  switchTab(tab);
  const sel = q.get(PARAM[tab]);
  if (sel) select(sel);
}

async function load() {
  // Team managers see their teams only, and no orgs.
  const [teams, orgs, requests] = await Promise.all([call('/api/admin/teams'),
    state.me.admin ? call('/api/admin/orgs') : Promise.resolve({ body: {} }),
    state.me.admin ? call('/api/admin/requests') : Promise.resolve({ body: {} })]);
  if (!teams.ok) { $('list').innerHTML = `<div class="empty">${esc(teams.body.error || 'Could not load.')}</div>`; return false; }
  state.teams = teams.body.teams;
  state.names = teams.body.names || {};
  state.requests = requests.body.requests || [];
  state.openRequests = requests.body.open ?? teams.body.requests ?? 0;
  renderCount();
  state.unassigned = teams.body.unassigned;
  state.orgs = orgs.body.orgs || [];
  state.types = orgs.body.types || ['customer', 'partner', 'vendor'];
  return true;
}

function wireFilter() {
  $('filter').oninput = (e) => {
    state.filter = e.target.value;
    renderList();
  };
  for (const el of $('list').querySelectorAll('[data-sel]')) el.onclick = () => select(el.dataset.sel);
}

/**
 * Redraws the list on the left, which every change does for its counts, keeping what is
 * being typed in its fields (a new team's name, say) and where the cursor is.
 */
function renderList() {
  const typed = [...$('list').querySelectorAll('input[id], select[id]')].map((el) => ({
    id: el.id, value: el.value, touched: el.dataset.touched,
  }));
  const focus = document.activeElement && $('list').contains(document.activeElement) ? document.activeElement : null;
  const at = focus && focus.id ? { id: focus.id, start: focus.selectionStart, end: focus.selectionEnd } : null;
  drawList();
  for (const t of typed) {
    const el = $(t.id);
    if (el && $('list').contains(el) && t.id !== 'filter') {
      el.value = t.value;
      if (t.touched) el.dataset.touched = t.touched;
    }
  }
  if (at && $(at.id)) {
    $(at.id).focus();
    if (at.start !== null && at.start !== undefined) $(at.id).setSelectionRange(at.start, at.end);
  }
}

/** A failure of the list's forms, kept until the next one succeeds. */
function listError(text) {
  state.listError = text;
  if ($('listStatus')) $('listStatus').textContent = text;
}

function drawList() {
  const f = state.filter.toLowerCase();
  if (state.tab === 'teams') {
    const rows = state.teams.filter((t) => !f || `${t.name} ${t.slug}`.toLowerCase().includes(f)).map((t) => `
      <div class="row${state.sel === t.slug ? ' on' : ''}" data-sel="${esc(t.slug)}">
        <span class="name">${esc(t.name)} <span class="sub">${esc(t.slug)}</span></span>
        ${t.self_managed ? '<span class="tag manual" title="Every member is a team manager">self-managed</span>' : ''}
        <span class="sub">${t.members} people · ${t.channels} ch${t.shared ? ` + ${t.shared} shared` : ''}</span></div>`).join('');
    const un = state.unassigned && state.unassigned.channels ? `<div class="row${state.sel === UNASSIGNED ? ' on' : ''}" data-sel="${UNASSIGNED}">
        <span class="name"><i>Unassigned</i></span><span class="sub">${state.unassigned.channels} ch</span></div>` : '';
    $('list').innerHTML = `<input class="search" id="filter" placeholder="Filter teams" value="${esc(state.filter)}">
      <h2>${state.me.admin ? 'Ops teams' : 'Teams you manage'}</h2>${rows || '<div class="empty">No teams.</div>'}${un}
      ${state.me.admin ? `<h2>New team</h2><form class="form" id="newTeam"><input id="ntName" placeholder="Name" class="grow" required>
        <input id="ntSlug" placeholder="slug" pattern="[a-z0-9][a-z0-9-]*" required style="width:110px"><button class="primary">Create</button></form>` : ''}
      <div class="status err" id="listStatus">${esc(state.listError)}</div>`;
    if (!state.me.admin) {
      wireFilter();
      return;
    }
    $('ntName').oninput = () => { if (!$('ntSlug').dataset.touched) $('ntSlug').value = $('ntName').value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
    $('ntSlug').oninput = () => { $('ntSlug').dataset.touched = '1'; };
    $('newTeam').onsubmit = async (e) => {
      e.preventDefault();
      const body = { slug: $('ntSlug').value, name: $('ntName').value };
      // Emptied at once, for the next team; back in the fields if it could not be created.
      $('ntSlug').value = '';
      $('ntName').value = '';
      delete $('ntSlug').dataset.touched;
      const r = await call('/api/admin/teams', 'POST', body);
      if (!r.ok) {
        listError(`${body.name}: ${r.body.error || `failed (${r.status})`}`);
        if ($('ntName') && !$('ntName').value) {
          $('ntName').value = body.name;
          $('ntSlug').value = body.slug;
          $('ntSlug').dataset.touched = '1';
        }
        return;
      }
      state.listError = '';
      state.teams.push({
        ...r.body.team, members: 0, rules: 0, channels: 0, threads: 0,
      });
      state.teams.sort((x, y) => x.name.localeCompare(y.name));
      select(r.body.team.slug);
    };
  } else if (state.tab === 'requests') {
    const match = (r) => !f || `${plainName(r.channel)} ${r.channel.channelId} ${teamLabel(r.team)} ${r.requestedBy.name || ''} ${r.requestedBy.email}`
      .toLowerCase().includes(f);
    const row = (r) => `<div class="row${String(state.sel) === String(r.id) ? ' on' : ''}" data-sel="${r.id}">
        <span class="name">${channelName(r.channel)} <span class="sub">→ ${esc(teamLabel(r.team))}</span></span>
        ${r.status === 'open' ? '' : statusTag(r)}<span class="sub">${esc(ago(r.status === 'open' ? r.requestedAt : r.decidedAt))}</span></div>`;
    const open = state.requests.filter((r) => r.status === 'open' && match(r));
    const decided = state.requests.filter((r) => r.status !== 'open' && match(r));
    $('list').innerHTML = `<input class="search" id="filter" placeholder="Filter requests" value="${esc(state.filter)}">
      <h2>Waiting for a decision</h2>${open.map(row).join('') || `<div class="empty">${f ? 'Nothing matches.' : 'No request is waiting.'}</div>`}
      ${decided.length ? `<h2>Decided</h2>${decided.map(row).join('')}` : ''}
      <p class="hint">Team managers ask for channels on their team's page. Confirming one assigns the channel to the team, as adding it on the team's page does.</p>`;
  } else {
    const rows = state.orgs.filter((o) => (!f || `${o.name || ''} ${o.slug}`.toLowerCase().includes(f))
      && (!state.noIcon || iconless(o))).map((o) => `
      <div class="row${state.sel === o.slug ? ' on' : ''}" data-sel="${esc(o.slug)}">
        ${ico(o.icon, o.domain)}<span class="name">${esc(o.name || o.slug)}${o.name ? ` <span class="sub">${esc(o.slug)}</span>` : ''}</span>
        ${o.type !== 'customer' ? `<span class="tag ${o.type}">${esc(o.type)}</span>` : ''}
        <span class="sub">${o.channels} ch</span></div>`).join('');
    $('list').innerHTML = `<input class="search" id="filter" placeholder="Filter ${state.orgs.length} orgs" value="${esc(state.filter)}">
      <label class="only"><input type="checkbox" id="noIcon"${state.noIcon ? ' checked' : ''}> Only the ${state.orgs.filter(iconless).length} without an icon</label>
      ${rows || '<div class="empty">Nothing matches.</div>'}
      <h2>New org</h2><form class="form" id="newOrg"><input id="noName" placeholder="Display name" class="grow" required>
        <select id="noType">${state.types.map((t) => `<option>${t}</option>`).join('')}</select><button class="primary">Create</button></form>
      <p class="hint">Channels are filed under an org by the rules (<code>aem-&lt;slug&gt;</code>) or a manual assignment.</p>
      <div class="status err" id="listStatus">${esc(state.listError)}</div>`;
    $('noIcon').onchange = (e) => {
      state.noIcon = e.target.checked;
      renderList();
    };
    $('newOrg').onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: $('noName').value, type: $('noType').value };
      $('noName').value = '';
      const r = await call('/api/admin/orgs', 'POST', body);
      if (!r.ok) {
        listError(`${body.name}: ${r.body.error || `failed (${r.status})`}`);
        if ($('noName') && !$('noName').value) $('noName').value = body.name;
        return;
      }
      state.listError = '';
      state.orgs.push({ ...r.body.org, channels: 0, threads: 0 });
      state.orgs.sort((x, y) => (x.name || x.slug).localeCompare(y.name || y.slug));
      select(r.body.org.slug);
    };
  }
  wireFilter();
}

function select(sel) {
  state.sel = sel;
  toUrl();
  renderList();
  if (state.tab === 'teams') showTeam(sel);
  else if (state.tab === 'requests') showRequest(sel);
  else showOrg(sel);
}

/** Back to the list (phones), its filter as it was. */
function unselect() {
  state.sel = null;
  toUrl();
  renderList();
  $('detail').innerHTML = `<div class="empty">Pick ${PICK[state.tab]}.</div>`;
}
const backButton = () => `<button class="back" data-back title="Back to the list" aria-label="Back to the ${state.tab}"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg></button>`;

function switchTab(tab) {
  state.tab = tab;
  state.sel = null;
  state.filter = '';
  toUrl();
  renderList();
  $('detail').innerHTML = `<div class="empty">Pick ${PICK[tab]}.</div>`;
}

// ---- view state ---------------------------------------------------------------------------
//
// The open team or org is kept in `state.view` (what the API said, then every change the
// page made). A change updates it and redraws only the part it touches (a table, the list
// on the left), so scroll position and focus stay where they are.

/** Adds `n` channels and `threads` threads to a team's or an org's counts in the list. */
function count(kind, slug, n, threads) {
  if (kind === 'team' && slug === UNASSIGNED) {
    if (state.unassigned) {
      state.unassigned.channels += n;
      state.unassigned.threads += threads;
    }
    return;
  }
  const list = kind === 'team' ? state.teams : state.orgs;
  const row = list.find((x) => x.slug === slug);
  if (row) {
    row.channels = Math.max(0, (row.channels || 0) + n);
    row.threads = Math.max(0, (row.threads || 0) + threads);
  }
}

/**
 * What a rule change moved, applied to the open view and to the counts on the left: a
 * channel that left this team (org) goes from the table, one that came is added.
 */
function applyMoves(moves, v = state.view) {
  for (const m of moves) {
    const threads = m.from.reduce((n, f) => n + f.threads, 0);
    for (const kind of ['team', 'org']) {
      for (const f of m.from) {
        if (f[kind] !== m.to[kind]) {
          count(kind, f[kind], -1, -f.threads);
          count(kind, m.to[kind], 1, f.threads);
        }
      }
    }
    if (v) {
      const id = m.channel.channelId;
      const before = v.channels.filter((c) => c.channelId === id);
      const at = v.channels.findIndex((c) => c.channelId === id);
      v.channels = v.channels.filter((c) => c.channelId !== id);
      const was = before[0] || {};
      // The teams it is shared with keep it, wherever it is filed; the team it is filed under
      // now does not need it shared as well.
      const sharedWith = (was.sharedWith || []).filter((t) => t !== m.to.team);
      let row = null;
      if (m.to[v.target] === v.value || (v.target === 'team' && sharedWith.includes(v.value))) {
        row = {
          source: m.channel.source,
          tenant: m.channel.tenant,
          channelId: m.channel.channelId,
          name: m.channel.name,
          groupName: was.groupName || m.channel.groupName || null,
          team: m.to.team,
          sharedWith,
          org: m.to.org,
          kind: m.to.kind,
          threads,
          latest: before.map((c) => c.latest).filter(Boolean).sort().pop() || null,
          manual: was.manual || { team: null, org: null },
        };
      } else if (at >= 0) {
        // A channel that left stays in its row, marked, until the page is loaded again: the
        // rows below do not move up under the pointer of someone going down the list.
        row = {
          ...was, sharedWith, left: m.to, threads,
        };
      }
      // Where it was, or on top when it is new here.
      if (row) v.channels.splice(at >= 0 ? at : 0, 0, row);
    }
  }
}

/** Marks a channel of the view `v` as assigned by hand (`rule`), or not (null). */
function setManual(channelId, rule, v = state.view) {
  for (const c of v.channels.filter((x) => x.channelId === channelId)) {
    c.manual = { ...c.manual, [v.target]: rule ? { id: rule.id, value: rule.value } : null };
  }
}

// ---- channels (shared) ------------------------------------------------------------------

/** `text`, escaped, with every occurrence of one of `words` (lower case) marked. */
function hl(text, words = []) {
  const t = String(text ?? '');
  const lower = t.toLowerCase();
  const marks = new Array(t.length).fill(false);
  for (const w of words) {
    for (let i = w ? lower.indexOf(w) : -1; i >= 0; i = lower.indexOf(w, i + 1)) marks.fill(true, i, i + w.length);
  }
  let out = '';
  let open = false;
  for (let i = 0; i < t.length; i += 1) {
    if (marks[i] !== open) { out += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
    out += esc(t[i]);
  }
  return open ? `${out}</mark>` : out;
}

/**
 * A channel's name as people know it: on Teams the team first (`acme-support › Main`), since a
 * Teams team has many channels called Main or General; on Slack `#name`.
 */
function channelName(c, words) {
  if (c.source === 'teams') {
    return `${c.groupName ? `${hl(c.groupName, words)} <span class="sep">›</span> ` : ''}${hl(c.name || c.channelId, words)}`;
  }
  return `#${hl(c.name || c.channelId, words)}`;
}
/** A channel's name as text, for the status line. */
const plainName = (c) => (c.source === 'teams'
  ? `${c.groupName ? `${c.groupName} › ` : ''}${c.name || c.channelId}` : `#${c.name || c.channelId}`);
const platform = (c) => ({ teams: 'Teams', discord: 'Discord' }[c.source] || `Slack${c.shared ? ' Connect' : ''}`);
const pct = (p) => `${Math.round((p || 0) * 100)}%`;
/** Clef's pick for a channel, as a tag. */
function clefTag(clef, here) {
  if (!clef) return '';
  const kind = clef.kind && clef.kind !== 'channel' ? ` · ${esc(clef.kind)}` : '';
  const title = `Clef: ${clef.team === 'none' ? 'no ops team' : teamLabel(clef.team)} (${pct(clef.p)}), ${clef.kind || '?'} (${pct(clef.kindP)})`;
  if (here !== undefined) {
    return `<span class="tag clef${here >= 0.5 ? ' yes' : ''}" title="${esc(title)}">Clef ${pct(here)}${kind}</span>`;
  }
  return `<span class="tag clef" title="${esc(title)}">Clef: ${esc(clef.team === 'none' ? 'none' : teamLabel(clef.team))} ${pct(clef.p)}${kind}</span>`;
}

/**
 * Places a picker's list below its field, or above it when there is not enough room below
 * (the field is at the bottom of the page), and no taller than the room there is.
 */
function placePicks(input, picks) {
  const r = input.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 16;
  const above = r.top - document.querySelector('header').getBoundingClientRect().bottom - 16;
  const up = below < 240 && above > below;
  picks.classList.toggle('up', up);
  picks.style.maxHeight = `${Math.max(120, Math.min(360, up ? above : below))}px`;
}

/** The channels card: a table (redrawn on its own) and a picker that assigns one here. */
function channelsCard(target) {
  // A team manager asks the admin team for a channel instead (a request).
  if (!state.me.admin) {
    return `<div class="card"><h2>Channels</h2><div id="channelsTable"></div>
    <div class="form picker"><input id="pick" class="grow" placeholder="Ask for a channel: search by channel, Teams team, customer or id" autocomplete="off" aria-label="Ask for a channel"><div class="picks" id="picks" hidden></div></div>
    <div id="askSlot"></div>
    <p class="hint">The admin team decides which channels a team gets. Pick a channel to ask them to add it to this team, with a note; they confirm or decline, and the answer shows under Requests. A channel another team holds is shared with this one: it stays filed under its team, and is in this team's inbox too.</p></div>`;
  }
  return `<div class="card"><h2>Channels</h2><div id="channelsTable"></div>
    <div class="form picker"><input id="pick" class="grow" placeholder="${target === 'team' ? 'Add a channel to this team' : 'Assign a channel here by hand'}: search by channel, Teams team, customer, team or id" autocomplete="off" aria-label="${target === 'team' ? 'Add a channel' : 'Assign a channel'}"><div class="picks" id="picks" hidden></div></div>
    <p class="hint">${target === 'team'
    ? `A channel has one team it is filed under (its folders, knowledge base and agents) and can be shared with more, whose inboxes have it too. Adding a channel ${esc(teamLabel('admin'))} holds files it under this team whatever the rules say (a channel-id rule with priority 10); adding one another team holds shares it with this team, and it stays where it is.${state.view.value !== 'admin' ? ` <b>→ ${esc(teamLabel('admin'))}</b> hands a channel back to the admin team.` : ''}`
    : 'A manual assignment files one channel under this org whatever the rules say (a channel-id rule with priority 10).'}</p></div>`;
}

/**
 * Assigns a channel (as the API listed it) to the open team or org by hand, or to another
 * `value`, and updates the page: the view it was made on, if that is still open. The same
 * assignment twice at once is made once; others queue up behind it (see `serial`).
 */
const assignKey = (target, channelId, value) => `assign:${target}:${channelId}:${value}`;
function assignHere(c, value = state.view.value) {
  const v = state.view;
  const { target } = v;
  const { channelId, source } = c;
  return once(assignKey(target, channelId, value), async () => {
    const what = `${plainName(c)} → ${target === 'team' ? teamLabel(value) : orgLabel(value)}`;
    const res = await ruleChange('POST', '/api/admin/assign', {
      target, value, channelId, source,
    }, what);
    if (!res) return null;
    if (res.shared) {
      // Another team holds it: shared with this one, filed where it is.
      const rows = v.channels.filter((x) => x.channelId === channelId);
      for (const row of rows) row.sharedWith = [...new Set([...(row.sharedWith || []), value])];
      if (!rows.length && value === v.value) {
        v.channels.unshift({ ...c, sharedWith: [...(c.sharedWith || []), value], manual: c.manual || { team: null, org: null } });
      }
      if (res.shared.added) {
        const row = state.teams.find((t) => t.slug === value);
        if (row) row.shared = (row.shared || 0) + 1;
      }
      status('ok', `Shared: ${plainName(c)} is in ${teamLabel(value)}'s inbox too, and stays filed under ${teamLabel(res.shared.from)}.`);
    }
    applyMoves(res.moves, v);
    // A channel that came here: what the move does not say about it.
    for (const row of v.channels.filter((x) => x.channelId === channelId)) {
      row.groupName = row.groupName || c.groupName || null;
      row.shared = row.shared ?? c.shared;
      row.latest = row.latest || c.latest || null;
      row.orgName = row.orgName || c.orgName || null;
    }
    // A request for it is answered by this (src/requests.js `settleRequests`).
    if (target === 'team' && state.requests.some((x) => x.status === 'open' && x.team === value && x.channel.channelId === channelId)) {
      refreshRequests();
    }
    // Already here by rule: no move, but now by hand. A channel the API did not move
    // (no threads yet) shows up once something is filed.
    if (value === v.value && !res.shared) setManual(channelId, res.rule, v);
    // A suggestion taken stays in its row, marked, for the same reason as a channel that left.
    if (value === v.value) for (const x of v.suggestions || []) if (x.channelId === channelId) x.added = true;
    if (v === state.view) {
      renderChannels();
      if ($('suggestTable')) renderSuggestions();
    }
    renderList();
    return res;
  });
}

function renderChannels() {
  const { target, channels } = state.view;
  const other = target === 'team' ? 'org' : 'team';
  // On the admin team's page, Clef's pick for each channel, to hand it to that team.
  const triage = target === 'team' && state.view.value === 'admin' && channels.some((c) => c.clef && !c.left);
  // On another team's page, a way to hand a channel back to the admin team.
  const back = target === 'team' && state.me.admin && state.view.value !== 'admin'
    && state.teams.some((t) => t.slug === 'admin');
  const rows = channels.map((c) => {
    if (c.left) {
      return `<tr class="left"><td>${channelName(c)}<div class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></div></td>
        <td colspan="${triage ? 5 : 4}" class="sub">${c.left.unshared ? `Out of this team's inbox; it stays filed under ${esc(teamLabel(c.left.team))}.`
  : `Moved to ${esc(teamLabel(c.left.team))} / ${esc(orgLabel(c.left.org))}${c.left.kind !== 'channel' ? ` (${esc(c.left.kind)})` : ''}; its threads are re-filed in the background.`}</td></tr>`;
    }
    const manual = c.manual[target];
    const shares = c.sharedWith || [];
    // On a team's page, a channel another team holds and shares with this one.
    const sharedHere = target === 'team' && c.team !== state.view.value && shares.includes(state.view.value);
    const also = shares.filter((t) => t !== state.view.value);
    const alsoTag = target === 'team' && also.length
      ? ` <span class="tag" title="Shared: in these teams' inboxes too">also ${esc(also.map(teamLabel).join(', '))}</span>` : '';
    const teamCell = `${esc(teamLabel(c.team))}${shares.length ? ` <span class="tag" title="Shared: in these teams' inboxes too">+ ${esc(shares.map(teamLabel).join(', '))}</span>` : ''}`;
    const pick = triage && c.clef && c.clef.team !== 'none' && c.clef.team !== 'admin' && state.teams.some((t) => t.slug === c.clef.team) ? c.clef.team : null;
    return `<tr><td>${channelName(c)}<div class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></div></td>
      <td>${other === 'org' ? esc(orgLabel(c.org)) : teamCell}${c.kind !== 'channel' ? ` <span class="tag">${esc(c.kind)}</span>` : ''}${alsoTag}</td>
      <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td>
      ${triage ? `<td class="nw">${clefTag(c.clef)}${pick ? ` <button class="link" data-give="${esc(c.channelId)}" data-source="${esc(c.source)}" data-team="${esc(pick)}"${off(assignKey(target, c.channelId, pick))} title="Assign it to ${esc(teamLabel(pick))} by hand">→ ${esc(teamLabel(pick))}</button>` : ''}</td>` : ''}
      <td class="nw">${sharedHere ? `<span class="tag manual" title="Filed under ${esc(teamLabel(c.team))}, and in this team's inbox too">shared by ${esc(teamLabel(c.team))}</span>
        ${state.me.admin ? `<button class="link" data-unshare="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unshare:${state.view.value}:${c.channelId}`)} title="Take it out of this team's inbox; it stays filed under ${esc(teamLabel(c.team))}">remove</button>` : ''}`
    : `${manual ? `<span class="tag manual" title="Assigned by hand, whatever the rules say">manual</span>
        ${state.me.admin ? `<button class="link" data-unassign="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unassign:${target}:${c.channelId}`)}>undo</button>` : ''}` : '<span class="sub">by rule</span>'}
        ${back && c.team !== 'admin' ? ` <button class="link" data-give="${esc(c.channelId)}" data-source="${esc(c.source)}" data-team="admin"${off(assignKey(target, c.channelId, 'admin'))} title="Move it back to ${esc(teamLabel('admin'))}: assigned there by hand, whatever the rules say">→ ${esc(teamLabel('admin'))}</button>` : ''}`}</td></tr>`;
  }).join('');
  $('channelsTable').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>${other === 'org' ? 'Org' : 'Team'}</th><th>Threads</th><th>Latest</th>${triage ? '<th>Clef suggests</th>' : ''}<th></th></tr>${rows}</table>`
    : '<div class="empty">No channel is filed here.</div>';
  const v = state.view;
  const find = (id) => channels.find((c) => c.channelId === id);
  for (const b of $('channelsTable').querySelectorAll('[data-unassign]')) {
    const id = b.dataset.unassign;
    b.onclick = () => hold(b, `unassign:${target}:${id}`, async () => {
      const res = await ruleChange('DELETE', '/api/admin/assign', { target, channelId: id, source: b.dataset.source }, `Undo ${plainName(find(id) || { channelId: id })}`);
      if (!res) return;
      setManual(id, null, v);
      applyMoves(res.moves, v);
      if (v === state.view) renderChannels();
      renderList();
    });
  }
  for (const b of $('channelsTable').querySelectorAll('[data-give]')) {
    b.onclick = () => press(b, () => assignHere(find(b.dataset.give), b.dataset.team));
  }
  for (const b of $('channelsTable').querySelectorAll('[data-unshare]')) {
    const c = find(b.dataset.unshare);
    const team = v.value;
    b.onclick = () => hold(b, `unshare:${team}:${c.channelId}`, async () => {
      const res = await call('/api/admin/share', 'DELETE', { team, channelId: c.channelId, source: c.source });
      if (!res.ok) { failed(`Remove ${plainName(c)}`, res); return; }
      // Out of the inbox, but in its row until the page is loaded again (see applyMoves).
      for (const x of v.channels.filter((y) => y.channelId === c.channelId)) {
        x.left = {
          team: x.team, org: x.org, kind: x.kind, unshared: true,
        };
      }
      const row = state.teams.find((t) => t.slug === team);
      if (row) row.shared = Math.max(0, (row.shared || 0) - 1);
      status('ok', `${plainName(c)} is out of ${teamLabel(team)}'s inbox; it stays filed under ${teamLabel(c.team)}.`);
      if (v === state.view) renderChannels();
      renderList();
    });
  }
}

/**
 * The picker that assigns a channel here: finds channels by anything it shows of them (channel
 * name, Teams team name, both as `team › channel`, platform, customer, the team they are in)
 * or id; every word has to match, spaces and punctuation aside (`channelMatch` in
 * src/admin.js). Each row says where the
 * channel is, its customer, where it is filed and how busy it is, with the matches marked.
 * Arrow keys and Enter pick, Escape closes.
 */
function wireChannelPicker() {
  const { target, value } = state.view;
  let timer;
  let list = [];
  let at = 0;
  let words = [];
  const input = $('pick');
  const picks = $('picks');
  // The admin team assigns the channel; a team manager asks for it.
  const asks = !state.me.admin;
  const pending = (c) => asks && (state.view.requests || []).some((x) => x.status === 'open' && x.channel.channelId === c.channelId);
  const pickIt = async (c) => {
    picks.hidden = true;
    input.value = '';
    list = [];
    if (asks) askFor(c); else await assignHere(c);
  };
  const render = () => {
    picks.innerHTML = list.map((c, i) => {
      const match = c.match || [];
      const org = c.org && !c.org.startsWith('_') ? (c.orgName || c.org) : '';
      // The org's slug only when the search found it there and not in the display name.
      const slug = c.orgName && match.includes('org') && !match.includes('orgName') ? ` <span class="mono">${hl(c.org, words)}</span>` : '';
      const id = match.length === 1 && match[0] === 'channelId' ? ` · id <span class="mono">${hl(c.channelId, words)}</span>` : '';
      const here = c[target] === value;
      // Adding a team to a channel another team holds shares it; one the admin team holds moves.
      const shares = target === 'team' && !here && !isHolding(c.team) && !isHolding(value);
      return `<div class="row pickrow${i === at ? ' on' : ''}" data-i="${i}">
        <span class="name"><span class="ch">${channelName(c, words)}</span>
          <span class="sub">${esc(platform(c))}${org ? ` · customer <b>${hl(org, words)}</b>${slug}` : ''}${id}
          · ${c.threads} thread${c.threads === 1 ? '' : 's'}${c.latest ? `, ${esc(ago(c.latest))}` : ''}</span></span>
        <span class="where">${pending(c) ? '<span class="tag open" title="Asked for already: waiting for the admin team">requested</span><br>' : ''}${here ? '<span class="tag manual">here by rule</span>' : `<span class="sub">now in</span> ${hl(teamLabel(c.team), words)}${target === 'org' ? ` / ${esc(orgLabel(c.org))}` : ''}${shares ? '<br><span class="sub" title="It stays filed under its team, and is in this team\'s inbox too">shares it here</span>' : ''}`}
          ${target === 'team' && c.clef ? `<br>${clefTag(c.clef, c.clef.teams[value] ?? 0)}` : ''}</span></div>`;
    }).join('') || '<div class="empty" style="padding:8px">No channel matches.</div>';
    picks.hidden = false;
    placePicks(input, picks);
    for (const el of picks.querySelectorAll('[data-i]')) {
      // The list shown when the row is picked.
      // eslint-disable-next-line no-loop-func
      el.onmousedown = (e) => { e.preventDefault(); pickIt(list[Number(el.dataset.i)]); };
    }
    const on = picks.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { picks.hidden = true; list = []; return; }
    timer = setTimeout(async () => {
      const r = await call(`/api/admin/channels?q=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return;
      // Not the separators (`›`, `>`, `/`) of a name typed as it is shown.
      words = q.toLowerCase().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
      const seen = new Set();
      // A manager asks only for channels that are not in the team's inbox yet.
      list = (r.body.channels || []).filter((c) => (asks ? c.team !== value : c[target] !== value || !c.manual[target]))
        .filter((c) => target !== 'team' || !(c.sharedWith || []).includes(value))
        .filter((c) => !seen.has(c.channelId) && seen.add(c.channelId));
      at = 0;
      render();
    }, 200);
  };
  input.onkeydown = (e) => {
    if (picks.hidden || !list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickIt(list[at]);
    } else if (e.key === 'Escape') {
      picks.hidden = true;
    }
  };
  input.onblur = () => setTimeout(() => { picks.hidden = true; }, 200);
}

// ---- suggested channels -------------------------------------------------------------------

const CLEF_SHOWN = 10;

/** One suggested channel: where it is, who of the team is active in it, what Clef says. */
function suggestionRow(c, total) {
  const org = c.org && !c.org.startsWith('_') ? (c.orgName || c.org) : '';
  const who = c.people.map((p) => {
    const did = [p.posted ? `${p.posted} post${p.posted === 1 ? '' : 's'}` : '', p.reacted ? `${p.reacted} reaction${p.reacted === 1 ? '' : 's'}` : '', p.member ? 'member' : '']
      .filter(Boolean).join(', ');
    // The rank weighs each person down by how many of the admin team's channels they are in.
    const where = p.channels && total ? `; active in ${p.channels} of the admin team's ${total} channels, weight ${p.weight}` : '';
    return `<span class="person" title="${esc(did + where)}">${esc(p.name)}<span class="sub"> · ${esc(did)}</span></span>`;
  }).join('');
  return `<tr><td>${channelName(c)}<div class="sub">${esc(platform(c))}${org ? ` · customer <b>${esc(org)}</b>` : ''}${c.topic ? ` · <span title="${esc(c.topic)}">${esc(c.topic.length > 80 ? `${c.topic.slice(0, 80)}…` : c.topic)}</span>` : ''}</div></td>
    <td>${who || '<span class="sub">nobody yet</span>'}</td>
    <td>${c.clef ? clefTag(c.clef, c.clef.here) : '<span class="sub">not yet</span>'}</td>
    <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td>
    <td>${c.added ? '<span class="tag manual">added</span>' : `<button data-add="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(assignKey('team', c.channelId, state.view.value))}>Add</button>`}</td></tr>`;
}

function renderSuggestions() {
  const { suggestions = [], coverage, showAllClef } = state.view;
  const active = suggestions.filter((c) => c.people.length);
  const clefOnly = suggestions.filter((c) => !c.people.length);
  const shown = showAllClef ? clefOnly : clefOnly.slice(0, CLEF_SHOWN);
  const row = (c) => suggestionRow(c, coverage && coverage.channels);
  const head = '<tr><th>Channel</th><th>Active here from this team</th><th>Clef</th><th>Threads</th><th>Latest</th><th></th></tr>';
  const none = '<tr><td colspan="6" class="sub">No member of this team posts, reacts or is a member in a channel the admin team holds.</td></tr>';
  const table = suggestions.length ? `<table>${head}${active.length ? active.map(row).join('') : none}
    ${clefOnly.length ? `<tr class="section"><td colspan="6">Clef also suggests, though nobody from this team is active there</td></tr>${shown.map(row).join('')}` : ''}</table>
    ${clefOnly.length > shown.length ? `<button class="link" id="sMore">Show ${clefOnly.length - shown.length} more</button>` : ''}`
    : '<div class="empty">No channel of the admin team has members of this team in it, and Clef suggests none.</div>';
  $('suggestTable').innerHTML = `${table}
    ${coverage ? `<p class="hint">Of the admin team's ${coverage.channels} channels, Clef has classified ${coverage.classified} and the members of ${coverage.membersListed} are listed; the cron does a batch every 20 minutes.
      ${coverage.classified < coverage.channels ? '<button class="link" id="sClassify">Classify a batch now</button>' : ''}</p>` : ''}`;
  for (const b of $('suggestTable').querySelectorAll('[data-add]')) {
    b.onclick = () => press(b, () => assignHere(state.view.suggestions.find((x) => x.channelId === b.dataset.add)));
  }
  if ($('sMore')) $('sMore').onclick = () => { state.view.showAllClef = true; renderSuggestions(); };
  if ($('sClassify')) {
    const b = $('sClassify');
    b.onclick = () => hold(b, 'classify', async () => {
      const v = state.view;
      status('', 'Clef is classifying a batch of channels…');
      // A batch takes a while: not in the queue, so changes made meanwhile go out.
      const r = await call('/api/admin/classify', 'POST', { limit: 10 }, { parallel: true });
      if (!r.ok) { failed('Classify', r); return; }
      status('ok', `Classified ${r.body.classified} channel${r.body.classified === 1 ? '' : 's'}; ${r.body.pending} to go.`);
      const t = await call(`/api/admin/team?slug=${encodeURIComponent(v.value)}`);
      if (t.ok) {
        // What was added meanwhile, and is still being re-filed, shows as added.
        const here = new Set(v.channels.filter((c) => !c.left).map((c) => c.channelId));
        v.suggestions = (t.body.suggestions || []).map((c) => (here.has(c.channelId) ? { ...c, added: true } : c));
        v.coverage = t.body.coverage;
        if (v === state.view) renderSuggestions();
      }
    });
  }
}

// ---- teams --------------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function renderMembers() {
  const { members, team } = state.view;
  const role = (m) => {
    if (team.self_managed) return '<span class="tag manual" title="Every member of a self-managed team is a team manager">manager</span>';
    return m.role === 'manager'
      ? `<span class="tag manual">manager</span> <button class="link" data-role="member" data-person="${m.id}"${off(`member:${team.slug}:${m.id}`)} title="Back to member">demote</button>`
      : `<button class="link" data-role="manager" data-person="${m.id}"${off(`member:${team.slug}:${m.id}`)} title="May add and remove members and edit the team's knowledge base">make manager</button>`;
  };
  $('membersTable').innerHTML = members.length
    ? `<table><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr>${members.map((m) => `<tr>
      <td>${esc(m.name || '')}${m.staff ? '' : ' <span class="tag vendor" title="Not marked as Adobe staff">not staff</span>'}</td><td class="mono">${esc(m.email)}</td>
      <td>${role(m)}</td>
      <td><button class="link" data-remove="${m.id}"${off(`member:${team.slug}:${m.id}`)} style="color:var(--red)">remove</button></td></tr>`).join('')}</table>`
    : '<div class="empty">Nobody yet.</div>';
  const v = state.view;
  // One change at a time per person: a role change and a removal in a row go out in order,
  // but the same click twice once.
  for (const b of $('membersTable').querySelectorAll('[data-role]')) {
    const m = members.find((x) => String(x.id) === b.dataset.person);
    b.onclick = () => hold(b, `member:${team.slug}:${m.id}`, async () => {
      const res = await call('/api/admin/members', 'PUT', { team: team.slug, person: m.id, role: b.dataset.role });
      if (!res.ok) { failed(m.name || m.email, res); return; }
      m.role = res.body.role;
      status('ok', `${m.name || m.email} is ${m.role === 'manager' ? 'a team manager now' : 'a member again'}.`);
      if (v === state.view) renderMembers();
    });
  }
  for (const b of $('membersTable').querySelectorAll('[data-remove]')) {
    const m = members.find((x) => String(x.id) === b.dataset.remove);
    b.onclick = () => hold(b, `member:${team.slug}:${m.id}`, async () => {
      const res = await call('/api/admin/members', 'DELETE', { team: team.slug, person: m.id });
      if (!res.ok) { failed(`Remove ${m.name || m.email}`, res); return; }
      v.members = v.members.filter((x) => x.id !== m.id);
      const row = state.teams.find((t) => t.slug === team.slug);
      if (row) row.members -= 1;
      status('ok', `Removed ${m.name || m.email}.`);
      if (v === state.view) renderMembers();
      renderList();
    });
  }
}

/**
 * Adding a member: one field that finds people by name or email (people opspile knows, and
 * platform accounts that posted), staff first; an email nobody has yet can be added as is.
 * Arrow keys and Enter pick, Escape closes. The field keeps the focus for the next one.
 */
function wireMemberPicker() {
  const slug = state.view.team.slug;
  const input = $('mFind');
  const picks = $('mPicks');
  let timer;
  let list = [];
  let at = 0;
  const v = state.view;
  // The field is cleared at once, for the next person, while this one is being added.
  const add = (p) => {
    picks.hidden = true;
    input.value = '';
    list = [];
    input.focus();
    return once(`add:${slug}:${p.email}`, async () => {
      // Adding someone twice keeps one membership: safe to send again.
      const res = await call('/api/admin/members', 'POST', { team: slug, email: p.email, name: p.name || undefined }, { idempotent: true });
      if (!res.ok) { failed(`Add ${p.name || p.email}`, res); return; }
      const { person } = res.body;
      const had = v.members.find((m) => m.id === person.id);
      if (had) had.role = person.role;
      if (!had) {
        v.members.push(person);
        v.members.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
        const row = state.teams.find((t) => t.slug === slug);
        if (row) row.members += 1;
      }
      status('ok', `Added ${person.name || person.email}.`);
      if (v === state.view) renderMembers();
      renderList();
    });
  };
  const render = () => {
    picks.innerHTML = list.map((p, i) => `<div class="row${i === at ? ' on' : ''}" data-i="${i}">
      <span class="name">${p.name ? esc(p.name) : `<i>${esc(p.email)}</i>`} ${p.name ? `<span class="sub mono">${esc(p.email)}</span>` : ''}</span>
      ${p.new ? '<span class="tag">new person</span>' : ''}${p.staff ? '' : '<span class="tag vendor">not staff</span>'}
      ${p.teams && p.teams.length ? `<span class="sub">${esc(p.teams.map(teamLabel).join(', '))}</span>` : ''}</div>`).join('')
      || '<div class="empty" style="padding:8px">Nobody matches. Type a full email address to add someone new.</div>';
    picks.hidden = false;
    placePicks(input, picks);
    for (const el of picks.querySelectorAll('[data-i]')) {
      // eslint-disable-next-line no-loop-func
      el.onmousedown = (e) => { e.preventDefault(); add(list[Number(el.dataset.i)]); };
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { picks.hidden = true; list = []; return; }
    timer = setTimeout(async () => {
      const r = await call(`/api/admin/people?team=${encodeURIComponent(slug)}&q=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return;
      list = r.body.people || [];
      const email = q.toLowerCase();
      if (EMAIL.test(email) && !list.some((p) => p.email === email)) {
        list.push({ email, name: null, new: true, staff: true });
      }
      at = 0;
      render();
    }, 150);
  };
  input.onkeydown = (e) => {
    if (picks.hidden || !list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(list[at]);
    } else if (e.key === 'Escape') {
      picks.hidden = true;
    }
  };
  input.onblur = () => setTimeout(() => { picks.hidden = true; }, 150);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The prefix a pattern stands for (`^aem-` → `aem-`), or null for any other expression. */
function prefixOf(pattern) {
  const m = /^\^((?:\\.|[^\\.*+?()[\]{}|$^])*)$/.exec(pattern || '');
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
}
function describe(r) {
  const prefix = prefixOf(r.pattern);
  return prefix !== null ? `starts with <code>${esc(prefix)}</code>` : `matches <code>${esc(r.pattern)}</code>`;
}

function ruleRow(r) {
  return `<tr data-rule="${r.id}"><td>${esc(FIELD_LABEL[r.field] || r.field)}</td><td>${describe(r)}</td>
    <td>${r.source ? `<span class="tag">${esc(r.source)} only</span>` : ''}</td>
    <td class="n">${r.priority}</td><td class="sub">${esc(r.note || '')}</td>
    <td><button class="link" data-edit="${r.id}">edit</button><button class="link" data-del="${r.id}"${off(`rule:${r.id}`)} style="color:var(--red)">delete</button></td></tr>`;
}

function ruleForm(r = {}) {
  const prefix = r.pattern ? prefixOf(r.pattern) : '';
  const mode = prefix !== null ? 'prefix' : 'regex';
  return `<form class="form" id="ruleForm" data-id="${r.id || ''}">
    <select id="rField">${Object.entries(FIELD_LABEL).map(([k, v]) => `<option value="${k}"${(r.field || 'name') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <select id="rMode"><option value="prefix"${mode === 'prefix' ? ' selected' : ''}>starts with</option><option value="regex"${mode === 'regex' ? ' selected' : ''}>regular expression</option></select>
    <input id="rPattern" class="grow mono" placeholder="aem-" value="${esc(mode === 'prefix' ? prefix : r.pattern)}" required>
    <select id="rSource"><option value="">Every platform</option><option value="slack"${r.source === 'slack' ? ' selected' : ''}>Slack only</option><option value="teams"${r.source === 'teams' ? ' selected' : ''}>Teams only</option><option value="discord"${r.source === 'discord' ? ' selected' : ''}>Discord only</option></select>
    <input id="rPriority" type="number" min="0" max="10000" value="${r.priority ?? 100}" style="width:80px" title="Priority: the lowest matching rule wins">
    <input id="rNote" placeholder="Note" value="${esc(r.note || '')}">
    <button class="primary">${r.id ? 'Save rule' : 'Add rule'}</button>${r.id ? '<button type="button" id="rCancel">Cancel</button>' : ''}
  </form>`;
}

/** The team's own rules (not manual assignments, which the channels card shows). */
const ownRules = () => state.view.rules.filter((x) => x.value === state.view.team.slug && x.field !== 'channel_id');

function renderRules() {
  const own = ownRules();
  $('rulesTable').innerHTML = own.length
    ? `<table><tr><th>Field</th><th>Pattern</th><th></th><th>Priority</th><th>Note</th><th></th></tr>${own.map(ruleRow).join('')}</table>`
    : '<div class="empty">No rule files channels under this team yet.</div>';
  for (const b of $('rulesTable').querySelectorAll('[data-edit]')) {
    b.onclick = () => {
      $('ruleSlot').innerHTML = ruleForm(state.view.rules.find((x) => String(x.id) === b.dataset.edit));
      wireRuleForm();
      $('rPattern').focus();
    };
  }
  const v = state.view;
  for (const b of $('rulesTable').querySelectorAll('[data-del]')) {
    const id = Number(b.dataset.del);
    b.onclick = () => hold(b, `rule:${id}`, async () => {
      const res = await ruleChange('DELETE', '/api/admin/rules', { id }, 'Delete rule');
      if (!res) return;
      v.rules = v.rules.filter((x) => x.id !== res.deleted);
      const row = state.teams.find((t) => t.slug === v.team.slug);
      if (row) row.rules -= 1;
      applyMoves(res.moves, v);
      if (v === state.view) {
        renderRules();
        renderChannels();
      }
      renderList();
    });
  }
}

/**
 * The rule form. Submitted, it is emptied at once for the next rule while this one is saved;
 * a rule that could not be saved comes back into it, unless the next one is being typed.
 */
function wireRuleForm() {
  const v = state.view;
  const slug = v.team.slug;
  const reset = (r) => { $('ruleSlot').innerHTML = ruleForm(r); wireRuleForm(); };
  $('ruleForm').onsubmit = async (e) => {
    e.preventDefault();
    const id = Number($('ruleForm').dataset.id) || null;
    const raw = $('rPattern').value.trim();
    const body = {
      ...(id ? { id } : {}),
      target: 'team',
      field: $('rField').value,
      pattern: $('rMode').value === 'prefix' ? `^${escapeRe(raw)}` : raw,
      value: slug,
      source: $('rSource').value || null,
      priority: Number($('rPriority').value),
      note: $('rNote').value,
    };
    const focused = document.activeElement && document.activeElement.id;
    reset();
    if (focused && $(focused)) $(focused).focus();
    const res = await ruleChange(id ? 'PUT' : 'POST', '/api/admin/rules', body, `${id ? 'Save' : 'Add'} rule ${raw}`);
    if (!res) {
      if (v === state.view && !$('rPattern').value) reset(body);
      return;
    }
    if (id) {
      v.rules = v.rules.map((x) => (x.id === id ? res.rule : x));
    } else {
      v.rules.push(res.rule);
      const row = state.teams.find((t) => t.slug === slug);
      if (row) row.rules += 1;
    }
    applyMoves(res.moves, v);
    if (v === state.view) {
      renderRules();
      renderChannels();
    }
    renderList();
  };
  if ($('rCancel')) $('rCancel').onclick = () => reset();
}

/**
 * A page being loaded: true while it is still the one asked for last (a team picked while
 * another was loading takes over), and the status line of the last page is not carried on.
 */
let loading = 0;
function loadingPage() {
  const ticket = ++loading;
  note = { kind: '', text: '' };
  $('detail').innerHTML = '<div class="empty">Loading…</div>';
  return () => ticket === loading;
}

async function showTeam(slug) {
  const current = loadingPage();
  const r = await call(`/api/admin/team?slug=${encodeURIComponent(slug)}`);
  if (!current()) return;
  if (!r.ok) { $('detail').innerHTML = `<div class="empty">${esc(r.body.error)}</div>`; return; }
  const {
    team, members, rules, channels, suggestions, coverage, requests = [],
  } = r.body;
  const v = {
    target: 'team', value: slug, team, members, rules, channels, suggestions, coverage, requests,
  };
  state.view = v;
  const templates = rules.filter((x) => x.value !== slug);
  const real = slug !== UNASSIGNED;
  const admin = Boolean(state.me.admin);
  let title = '<h1 style="margin:0;font-size:20px">Unassigned channels</h1>';
  if (real) {
    title = admin ? `<input class="big" id="tName" value="${esc(team.name)}" aria-label="Team name">`
      : `<h1 style="margin:0;font-size:20px;flex:1">${esc(team.name)}</h1>`;
  }
  $('detail').innerHTML = `
    <div class="title">${backButton()}${title}
      <span class="sub mono">${esc(team.slug)}</span>
      ${real ? `<a href="/inbox/kb?team=${encodeURIComponent(team.slug)}">Knowledge base</a>` : ''}
      ${admin && real && team.slug !== 'admin' ? '<button class="danger" id="tDelete">Delete team</button>' : ''}</div>
    <div class="status" id="status"></div>
    ${real ? `<div class="card"><label style="display:flex;gap:8px;align-items:center">
      <input type="checkbox" id="tSelf"${team.self_managed ? ' checked' : ''}${admin ? '' : ' disabled'}>
      <span><b>Self-managed</b>: every member is a team manager and may add and remove members and edit the team's knowledge base.</span></label>
      <p class="hint">${admin ? 'Turning it on makes every member a manager, now and when they join. Turning it off keeps the roles as they are; new members join as members, and managers can be demoted.' : 'Only the admin team changes this.'}</p></div>` : ''}
    ${real ? `<div class="card"><h2>Members</h2><div id="membersTable"></div>
      <div class="form picker"><input id="mFind" class="grow" placeholder="Add a member: type a name or an email" autocomplete="off" aria-label="Add a member"><div class="picks" id="mPicks" hidden></div></div>
      <p class="hint">Members see this team's inbox. They also need to be in the Access policy of the inbox.</p></div>

    ${admin ? `<div class="card"><h2>Rules</h2><div id="rulesTable"></div>
      <div id="ruleSlot">${ruleForm()}</div>
      <p class="hint">A channel goes to the team of the matching rule with the lowest priority. Example: channel name starts with <code>aem-</code>.</p>
      ${templates.length ? `<p class="hint">${templates.length} rule${templates.length === 1 ? '' : 's'} name the team from the match ($1) and may also apply.</p>` : ''}</div>` : ''}` : ''}
    ${channelsCard('team')}
    ${real && (!admin || v.requests.length) ? `<div class="card"><h2>Requests</h2><div id="requestsTable"></div>
      <p class="hint">${admin ? 'Channels this team\'s managers asked for. Review one to confirm or decline it.' : 'The channels this team asked the admin team for, and their answers.'}</p></div>` : ''}
    ${suggestions ? `<div class="card"><h2>Suggested channels</h2>
      <p class="hint" style="margin:0 0 8px">Channels the admin team holds (no rule files them under a team) where members of ${esc(team.name)} post, react or are members, and the ones Clef thinks are this team's. Add assigns one here by hand.</p>
      <div id="suggestTable"></div></div>` : ''}`;
  showStatus();
  renderChannels();
  if (suggestions) renderSuggestions();
  wireChannelPicker();
  if ($('requestsTable')) renderRequests();
  if (!real) return;
  renderMembers();
  wireMemberPicker();
  $('tSelf').onchange = async () => {
    const box = $('tSelf');
    const on = box.checked;
    const res = await call('/api/admin/teams', 'PUT', { slug, selfManaged: on });
    if (!res.ok) {
      // Unless it was turned again meanwhile.
      if (box.isConnected && box.checked === on) box.checked = !on;
      failed('Self-managed', res);
      return;
    }
    v.team.self_managed = on;
    if (on) for (const m of v.members) m.role = 'manager';
    const row = state.teams.find((t) => t.slug === slug);
    if (row) row.self_managed = on;
    status('ok', on ? 'Self-managed: every member is a team manager now.' : 'Not self-managed any more: roles stay as they are.');
    if (v === state.view) renderMembers();
    renderList();
  };
  if (!admin) return;
  renderRules();
  wireRuleForm();
  $('tName').onchange = async () => {
    const name = $('tName').value.trim();
    const res = await call('/api/admin/teams', 'PUT', { slug, name });
    if (!res.ok) { failed('Rename', res); return; }
    v.team.name = name;
    const row = state.teams.find((t) => t.slug === slug);
    if (row) row.name = name;
    status('ok', 'Renamed.');
    renderList();
  };
  if ($('tDelete')) {
    // Only a team without rules or threads can be deleted (the API refuses the others).
    $('tDelete').onclick = () => hold($('tDelete'), `delete:${slug}`, async () => {
      const res = await call('/api/admin/teams', 'DELETE', { slug });
      if (!res.ok) { failed(`Delete ${team.name}`, res); return; }
      state.teams = state.teams.filter((t) => t.slug !== slug);
      if (state.tab === 'teams' && state.sel === slug) switchTab('teams'); else renderList();
    });
  }
}

// ---- channel assignment requests ----------------------------------------------------------
//
// A team manager asks for a channel on their team's page (`askFor`); the admin team decides
// under Requests (`showRequest`): Confirm runs the assignment the team's page makes, after its
// dry run said what it moves; Decline takes a reason. Both pages show what came of each.

const who = (p) => esc((p && (p.name || p.email)) || 'someone');
const STATUS = {
  open: 'pending', confirmed: 'confirmed', declined: 'declined', withdrawn: 'withdrawn',
};
const statusTag = (r) => `<span class="tag ${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span>`;

/** What came of a request, in a few words: who decided, when, and what it did. */
function decisionText(r) {
  const when = r.decidedAt ? ` ${esc(ago(r.decidedAt))}` : '';
  if (r.status === 'open') return `${statusTag(r)} waiting for the admin team`;
  if (r.status === 'withdrawn') return `${statusTag(r)} by ${who(r.decidedBy)}${when}`;
  if (r.status === 'declined') {
    return `${statusTag(r)} by ${who(r.decidedBy)}${when}${r.reason ? `: <span class="note">${esc(r.reason)}</span>` : ''}`;
  }
  const did = {
    moved: `filed under ${esc(teamLabel(r.team))}; its threads are re-filed`,
    shared: `shared with ${esc(teamLabel(r.team))}; it stays filed under ${esc(teamLabel(r.channel.team))}`,
    assigned: `assigned to ${esc(teamLabel(r.team))}; nothing to move yet`,
  }[r.outcome] || '';
  return `${statusTag(r)} by ${who(r.decidedBy)}${when}${did ? `: ${did}` : ''}`;
}

/** The number of open requests, on Requests in the header. */
function renderCount() {
  Header.setCount(state.me.admin ? state.openRequests : 0);
}

/** A request as it is now, everywhere the page shows it (the lists, the open team page). */
function updateRequest(r) {
  const was = state.requests.find((x) => x.id === r.id);
  if (was && was.status === 'open' && r.status !== 'open') state.openRequests = Math.max(0, state.openRequests - 1);
  if (was) Object.assign(was, r); else if (state.me.admin) state.requests.unshift(r);
  if (state.view && state.view.requests) {
    const mine = state.view.requests.find((x) => x.id === r.id);
    if (mine) Object.assign(mine, r); else if (state.view.value === r.team) state.view.requests.unshift(r);
  }
  renderCount();
}

/** The requests as the API has them now, after a change that may have answered some. */
async function refreshRequests() {
  const r = await call('/api/admin/requests');
  if (!r.ok) return;
  state.requests = r.body.requests;
  state.openRequests = r.body.open;
  renderCount();
  const v = state.view;
  if (v && v.requests) {
    for (const x of v.requests) Object.assign(x, state.requests.find((y) => y.id === x.id) || {});
    if ($('requestsTable')) renderRequests();
  }
  if (state.tab === 'requests') renderList();
}

/** The team page's requests: what was asked for, by whom, and the answer. */
function renderRequests() {
  const v = state.view;
  const rows = v.requests.map((r) => `<tr><td>${channelName(r.channel)}<div class="sub">${esc(platform(r.channel))} · <span class="mono">${esc(r.channel.channelId)}</span></div></td>
    <td class="nw">${who(r.requestedBy)}<div class="sub">${esc(ago(r.requestedAt))}</div></td>
    <td class="note">${esc(r.note || '')}</td>
    <td>${decisionText(r)}</td>
    <td class="nw">${r.status !== 'open' ? '' : state.me.admin
    ? `<button class="link" data-review="${r.id}">review</button>`
    : `<button class="link" data-withdraw="${r.id}"${off(`request:${r.id}`)} title="Take the request back">withdraw</button>`}</td></tr>`).join('');
  $('requestsTable').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>Asked by</th><th>Note</th><th>Answer</th><th></th></tr>${rows}</table>`
    : '<div class="empty">Nothing asked for yet. Search for a channel above to ask for it.</div>';
  for (const b of $('requestsTable').querySelectorAll('[data-review]')) {
    b.onclick = () => { switchTab('requests'); select(b.dataset.review); };
  }
  for (const b of $('requestsTable').querySelectorAll('[data-withdraw]')) {
    const r = v.requests.find((x) => String(x.id) === b.dataset.withdraw);
    b.onclick = () => hold(b, `request:${r.id}`, async () => {
      const res = await call('/api/admin/requests', 'DELETE', { id: r.id, team: r.team });
      if (res.body.request) updateRequest(res.body.request);
      if (!res.ok) failed(`Withdraw ${plainName(r.channel)}`, res);
      else status('ok', `Withdrew the request for ${plainName(r.channel)}.`);
      if (v === state.view) renderRequests();
    });
  }
}

/**
 * A team manager picked a channel: a short form to ask the admin team for it, with a note.
 * Sent, the request shows under Requests as pending.
 */
function askFor(c) {
  const v = state.view;
  const asked = v.requests.find((x) => x.status === 'open' && x.channel.channelId === c.channelId);
  if (asked) {
    status('', `${plainName(c)} is asked for already; it waits for the admin team.`);
    return;
  }
  const shares = !isHolding(c.team);
  $('askSlot').innerHTML = `<form class="form" id="askForm">
    <span style="flex-basis:100%">Ask the admin team to add <b>${channelName(c)}</b> to ${esc(teamLabel(v.value))}
      <span class="sub">(now in ${esc(teamLabel(c.team))}${shares ? '; it would be shared with this team and stay filed there' : ''})</span></span>
    <input id="askNote" class="grow" maxlength="500" placeholder="Note for the admin team (optional): why this team should have it" aria-label="Note for the admin team">
    <button class="primary">Send request</button><button type="button" id="askCancel">Cancel</button></form>`;
  $('askNote').focus();
  $('askCancel').onclick = () => { $('askSlot').innerHTML = ''; $('pick').focus(); };
  $('askForm').onsubmit = (e) => {
    e.preventDefault();
    const why = $('askNote').value.trim();
    $('askSlot').innerHTML = '';
    return once(`ask:${v.value}:${c.channelId}`, async () => {
      // The same request twice is refused as a duplicate: safe to send again.
      const res = await call('/api/admin/requests', 'POST', {
        team: v.value, source: c.source, channelId: c.channelId, note: why || undefined,
      }, { idempotent: true });
      if (res.body.request) updateRequest(res.body.request);
      if (!res.ok) failed(`Ask for ${plainName(c)}`, res);
      else status('ok', `Asked for ${plainName(c)}; the admin team confirms or declines it.`);
      if (v === state.view) renderRequests();
    });
  };
}

/** What confirming a request does, from the assignment's dry run. */
function previewText(r, res) {
  const name = channelName(r.channel);
  const team = esc(teamLabel(r.team));
  if (!res.ok) return `<span class="status err">${esc(res.body.error || `Could not try it (${res.status}).`)}</span>`;
  const { moves, shared } = res.body;
  if (shared) {
    return `Shares ${name} with ${team}: it stays filed under ${esc(teamLabel(shared.from))} (its folders, knowledge base and agents) and is in ${team}'s inbox too. Nothing moves.`;
  }
  if (!moves.length) return `Files ${name} under ${team} by hand (a channel-id rule with priority 10). It has no threads here yet, so nothing moves now.`;
  const items = moves.map((m) => {
    const threads = m.from.reduce((n, f) => n + f.threads, 0);
    const from = [...new Set(m.from.map((f) => teamLabel(f.team)))].join(', ');
    return `<li>${channelName(m.channel)}: ${threads} thread${threads === 1 ? '' : 's'} from ${esc(from)} to ${esc(teamLabel(m.to.team))} / ${esc(orgLabel(m.to.org))}</li>`;
  }).join('');
  return `Files ${name} under ${team} by hand (a channel-id rule with priority 10), and re-files:<ul>${items}</ul>`;
}

/** A request, for the admin team: what is asked, by whom, and Confirm or Decline. */
function drawRequest(r, preview) {
  const c = r.channel;
  const org = c.org && !c.org.startsWith('_') ? (c.orgName || orgLabel(c.org)) : '';
  const open = r.status === 'open';
  $('detail').innerHTML = `
    <div class="title">${backButton()}<h1 style="margin:0;font-size:20px;flex:1">${channelName(c)} <span class="sep">→</span> ${esc(teamLabel(r.team))}</h1>${statusTag(r)}</div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label>Channel</label><span>${channelName(c)} <span class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></span></span>
      <label>Now</label><span>${c.team ? `filed under <b>${esc(teamLabel(c.team))}</b>` : 'no threads yet'}${org ? ` · customer <b>${esc(org)}</b>` : ''} · ${c.threads} thread${c.threads === 1 ? '' : 's'}</span>
      <label>For</label><span><a href="/inbox/admin?tab=teams&team=${encodeURIComponent(r.team)}">${esc(teamLabel(r.team))}</a></span>
      <label>Asked by</label><span>${who(r.requestedBy)} <span class="sub">${esc(ago(r.requestedAt))}</span></span>
      ${r.note ? `<label>Note</label><span class="note">${esc(r.note)}</span>` : ''}
      ${open ? '' : `<label>Answer</label><span>${decisionText(r)}</span>`}
    </div></div>
    ${open ? `<div class="card"><h2>Confirming it</h2><div class="preview" id="rqPreview">${preview ? previewText(r, preview) : '<span class="sub">Trying it…</span>'}</div>
      <div class="form"><button class="primary" id="rqConfirm"${preview && preview.ok ? '' : ' disabled'}${off(`request:${r.id}`)}>Confirm</button></div></div>
      <div class="card"><h2>Declining it</h2><form class="form" id="rqDeclineForm"><input id="rqReason" class="grow" maxlength="500" placeholder="Reason, for the manager (optional)" aria-label="Reason">
      <button class="danger" id="rqDecline"${off(`request:${r.id}`)}>Decline</button></form></div>` : ''}`;
  showStatus();
  if (!open) return;
  /** After a decision: the lists, the counts and this page. */
  const decided = (req) => {
    updateRequest(req);
    renderList();
    if (state.tab === 'requests' && String(state.sel) === String(req.id)) drawRequest(req, preview);
  };
  $('rqConfirm').onclick = () => hold($('rqConfirm'), `request:${r.id}`, async () => {
    const res = await call('/api/admin/requests/confirm', 'POST', { id: r.id });
    if (!res.ok) {
      failed(`Confirm ${plainName(c)}`, res);
      if (res.body.request) decided(res.body.request);
      return;
    }
    applyMoves(res.body.moves, null);
    if (res.body.shared && res.body.shared.added) {
      const row = state.teams.find((t) => t.slug === r.team);
      if (row) row.shared = (row.shared || 0) + 1;
    }
    status('ok', res.body.shared
      ? `Confirmed: ${plainName(c)} is in ${teamLabel(r.team)}'s inbox too, and stays filed under ${teamLabel(res.body.shared.from)}.`
      : `Confirmed: ${plainName(c)} is filed under ${teamLabel(r.team)}${res.body.moves.length ? '; its threads are re-filed' : ''}.`);
    decided(res.body.request);
  });
  $('rqDeclineForm').onsubmit = (e) => {
    e.preventDefault();
    const b = $('rqDecline');
    hold(b, `request:${r.id}`, async () => {
      const res = await call('/api/admin/requests/decline', 'POST', { id: r.id, reason: $('rqReason').value.trim() || undefined });
      if (!res.ok) failed(`Decline ${plainName(c)}`, res);
      else status('ok', `Declined ${plainName(c)} for ${teamLabel(r.team)}.`);
      if (res.body.request) decided(res.body.request);
    });
  };
}

async function showRequest(id) {
  const current = loadingPage();
  state.view = null;
  const r = state.requests.find((x) => String(x.id) === String(id));
  if (!r) { $('detail').innerHTML = '<div class="empty">No such request.</div>'; return; }
  drawRequest(r, null);
  if (r.status !== 'open') return;
  // The assignment's dry run: what confirming moves, or that it shares the channel.
  const preview = await call('/api/admin/requests/confirm', 'POST', { id: r.id, dryRun: true }, { parallel: true, idempotent: true });
  if (!current()) return;
  if (preview.body.request && preview.body.request.status !== 'open') {
    updateRequest(preview.body.request);
    renderList();
  }
  drawRequest(r, preview);
}

// ---- orgs ---------------------------------------------------------------------------------

async function showOrg(slug) {
  const current = loadingPage();
  const r = await call(`/api/admin/org?slug=${encodeURIComponent(slug)}`);
  if (!current()) return;
  if (!r.ok) { $('detail').innerHTML = `<div class="empty">${esc(r.body.error)}</div>`; return; }
  const {
    org, rules, channels, types, domains = [],
  } = r.body;
  const v = {
    target: 'org', value: slug, org, rules, channels,
  };
  const domain = domains[0] || null;
  state.view = v;
  $('detail').innerHTML = `
    <div class="title">${backButton()}<span id="oIco">${ico(org.icon, domain)}</span><input class="big" id="oName" value="${esc(org.name || '')}" placeholder="${esc(org.slug)}" aria-label="Display name">
      <span class="sub mono">${esc(org.slug)}</span><button class="danger" id="oDelete" title="Forget the name, icon and type"${org.updated_at ? '' : ' hidden'}>Reset</button></div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label>Type</label><span class="seg" id="oType">${types.map((t) => `<button type="button" data-type="${t}" aria-pressed="${org.type === t}">${t}</button>`).join('')}</span>
      <label for="oIcon">Icon</label><span style="display:flex;gap:8px;align-items:center"><input id="oIcon" class="mono" style="flex:1" value="${esc(org.icon || '')}" placeholder="example.com, or https://…/logo.png"></span>
      <label>Suggestions</label><div class="icons" id="oIcons"><span class="sub">Looking for icons…</span></div>
    </div><p class="hint">The inbox shows the display name and icon instead of the slug and the favicon of the customer's mail domain${domain ? ` (here ${esc(domain)})` : ''}. A domain shows its favicon; an https URL is used as the image. The suggestions are the favicons of the websites its name and its people's mail domains suggest, and the icons those sites name, most likely first as Clef sees them; pick one to use it.</p></div>
    ${channelsCard('org')}
    ${rules.length ? `<div class="card"><h2>Rules naming this org</h2><table><tr><th>Field</th><th>Pattern</th><th>Value</th><th>Priority</th><th>Note</th></tr>
      ${rules.filter((x) => x.field !== 'channel_id' || x.note !== 'manual assignment').map((x) => `<tr><td>${esc(FIELD_LABEL[x.field] || x.field)}</td><td>${describe(x)}</td><td><code>${esc(x.value)}</code></td><td class="n">${x.priority}</td><td class="sub">${esc(x.note || '')}</td></tr>`).join('')}</table></div>` : ''}`;
  showStatus();
  renderChannels();
  wireChannelPicker();
  const pressed = () => $('oType').querySelector('[aria-pressed="true"]')?.dataset.type || 'customer';
  /** Shows an org's fields as saved, without touching the field being typed in. */
  const show = (o) => {
    if (document.activeElement !== $('oName')) $('oName').value = o.name || '';
    if (document.activeElement !== $('oIcon')) $('oIcon').value = o.icon || '';
    for (const x of $('oType').querySelectorAll('[data-type]')) x.setAttribute('aria-pressed', String(x.dataset.type === o.type));
    $('oIco').innerHTML = ico(o.icon, domain);
    markIcons();
    $('oDelete').hidden = !o.updated_at;
    const row = state.orgs.find((x) => x.slug === slug);
    if (row) Object.assign(row, { name: o.name, icon: o.icon, type: o.type });
    renderList();
  };
  // Each save sends every field as the page shows it; only the answer to the last one is
  // shown, so an earlier answer does not take back what was changed after it.
  let saves = 0;
  const save = async (patch) => {
    const now = {
      name: $('oName').value, icon: $('oIcon').value, type: pressed(), ...patch,
    };
    const mine = ++saves;
    const res = await call('/api/admin/orgs', 'PUT', { slug, ...now });
    if (!res.ok) { failed('Save', res); return; }
    if (mine !== saves) return;
    v.org = res.body.org;
    status('ok', 'Saved.');
    if (v === state.view) show(res.body.org);
  };
  // The icon suggestions (src/favicons.js), each a button that makes it the org's icon.
  let found = [];
  const markIcons = () => {
    const now = $('oIcon').value.trim();
    for (const b of $('oIcons').querySelectorAll('[data-icon]')) b.setAttribute('aria-pressed', String(b.dataset.icon === now));
  };
  const tile = (c) => {
    const share = c.p === null || c.p === undefined ? '' : `${Math.round(c.p * 100)}%`;
    const what = c.via === 'favicon' ? `The favicon of ${c.host}` : `${c.icon}, named by ${c.host}`;
    return `<button type="button" class="iconpick${c.p !== null && c.p < FITS ? ' weak' : ''}" data-icon="${esc(c.icon)}"
      title="${esc(`${what}${c.title ? ` (“${c.title}”)` : ''}${share ? `: ${share} the org's, says Clef` : ''}`)}"><img src="${esc(c.via === 'favicon' ? favicon(c.icon) : c.src)}" alt="">
      <span class="host">${esc(c.host)}${c.via === 'site' ? ' <span class="sub">site</span>' : ''}</span><span class="sub">${share}</span></button>`;
  };
  const drawIcons = () => {
    $('oIcons').innerHTML = `${found.map(tile).join('') || '<span class="sub">No icon found on the websites its name suggests.</span>'}
      <button type="button" class="again" id="oIconsAgain" title="Fetch the icons and ask Clef again">Look again</button>`;
    markIcons();
    for (const b of $('oIcons').querySelectorAll('[data-icon]')) {
      b.onclick = () => {
        $('oIcon').value = b.dataset.icon;
        markIcons();
        save();
      };
    }
    $('oIconsAgain').onclick = () => press($('oIconsAgain'), () => lookForIcons(true));
  };
  const lookForIcons = async (fresh) => {
    const res = await call(`/api/admin/org-icons?slug=${encodeURIComponent(slug)}${fresh ? '&fresh=1' : ''}`);
    if (v !== state.view) return;
    if (!res.ok) {
      $('oIcons').innerHTML = `<span class="sub">Could not look for icons: ${esc(res.body.error || res.status)}</span>`;
      return;
    }
    found = res.body.icons || [];
    drawIcons();
  };
  lookForIcons(false);
  // A new name suggests other websites.
  $('oName').onchange = () => save().then(() => lookForIcons(false));
  $('oIcon').onchange = () => { markIcons(); save(); };
  for (const b of $('oType').querySelectorAll('[data-type]')) {
    b.onclick = () => {
      for (const x of $('oType').querySelectorAll('[data-type]')) x.setAttribute('aria-pressed', String(x === b));
      save({ type: b.dataset.type });
    };
  }
  // Its channels stay where they are; it is shown by its slug again.
  $('oDelete').onclick = () => hold($('oDelete'), `reset:${slug}`, async () => {
    const res = await call('/api/admin/orgs', 'DELETE', { slug });
    if (!res.ok) { failed('Reset', res); return; }
    v.org = {
      slug, name: null, icon: null, type: 'customer', updated_at: null,
    };
    status('ok', 'Reset.');
    if (v !== state.view) return;
    $('oName').value = '';
    $('oIcon').value = '';
    show(v.org);
  });
}

// ---- start ------------------------------------------------------------------------------

(async () => {
  const me = await call('/api/me');
  if (!me.ok) { $('list').innerHTML = `<div class="empty">${esc(me.body.error || 'Not signed in.')}</div>`; return; }
  state.me = me.body;
  Header.user(state.me, Header.role(state.me));
  if (!state.me.admin && !state.me.manages?.length) {
    $('list').innerHTML = '<div class="empty">These pages are for the admin team and team managers.</div>';
    $('detail').innerHTML = '<div class="empty"><a href="/inbox">Back to the inbox</a></div>';
    return;
  }
  Header.init(state.me, {
    count: false, // renderCount, from the requests loaded here
    go: (id, url) => (['teams', 'orgs', 'requests'].includes(id) ? openUrl(url) : location.assign(url)),
  });
  if (!(await load())) return;
  // An icon that does not load: Google has no favicon for the domain (or the image is gone).
  // The org is then shown without one, and counts as one without an icon.
  let redraw = 0;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('ico') || !img.dataset.icon) return;
    missing.add(img.dataset.icon);
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'ico none', title: `No favicon for ${img.dataset.icon}` }));
    clearTimeout(redraw);
    redraw = setTimeout(() => { if (state.tab === 'orgs') renderList(); }, 300);
  }, true);
  $('detail').addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) { unselect(); return; }
    // A link to another team or org here (a request's team) opens it as the header does.
    const a = e.target.closest('a[href^="/inbox/admin?"]');
    if (a && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      openUrl(a.getAttribute('href'));
    }
  });
  window.addEventListener('popstate', () => openUrl(location.href, { push: false }));
  openUrl(location.href, { push: false });
})();
