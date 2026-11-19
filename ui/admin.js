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
 * or declines the requests under Requests; the rest is for the admin team. Customers ask too,
 * from the customer portal, for a channel: the admin team opens one under Requests, and a team's
 * managers on their team's page, when the team follows a technology the customer picked.
 *
 * Teams: create, rename and delete teams; add members (found by name or email) and remove
 * them; the rules that file channels under the team (a channel-name prefix like `aem-`, a
 * Teams team name, a Slack Connect team id); and manual assignments of single channels, one of
 * which moves a channel to the team picked under its name (`moveMenu`). Orgs: display name, icon and
 * type (customer, partner, vendor), and manual assignments. Bots: which of the bots in the
 * threads are Adobe's, and so on Adobe's side in the inbox (src/ourbots.js). Changes apply at once, without
 * asking (the status line names the channels a rule change moved), and go to the API one
 * after the other, so many can be made in a row (see `serial`). Text fields save when they
 * change. A change updates the open page in place (see "view state"); nothing reloads.
 */
const state = {
  me: null, tab: 'teams', listError: '', teams: [], unassigned: null, orgs: [], types: [], sel: null, filter: '', view: null,
  requests: [], openRequests: 0, names: {}, noIcon: false,
  // The bots the inbox knows (GET /api/admin/bots), and whether the list shows only Adobe's.
  bots: [], onlyOurs: false,
  // The customers waiting in the customer portal, and whether it is connected to this inbox.
  portal: [], portalBound: false,
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The inbox's address of a favicon (GET /api/favicon), so the browser keeps one copy for both.
const favicon = (icon) => (/^https:\/\//.test(icon) ? icon : `/api/favicon?domain=${encodeURIComponent(icon)}`);
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
/**
 * Asks before something that cannot be taken back, in the page, with a modal <dialog>:
 * resolves true for `yes`, false otherwise (Escape too). The focus starts on Cancel.
 */
function confirmFirst(question, detail, yes) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm';
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-labelledby', 'confirmTitle');
    dlg.innerHTML = `<form method="dialog"><h2 id="confirmTitle">${esc(question)}</h2><p>${esc(detail)}</p>
      <div class="apply"><button value="no">Cancel</button><button value="yes" class="danger">${esc(yes)}</button></div></form>`;
    dlg.addEventListener('cancel', () => { dlg.returnValue = 'no'; });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); Dialog.remove(dlg); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[value="no"]').focus();
  });
}
/** How many channels, in words: "1 channel", "48 channels". */
const channelCount = (n) => `${n} ${n === 1 ? 'channel' : 'channels'}`;

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
const PARAM = {
  teams: 'team', orgs: 'org', bots: 'bot', requests: 'request',
};
const PICK = {
  teams: 'a team', orgs: 'an org', bots: 'a bot', requests: 'a request',
};
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
function openUrl(url, { push = true, instant = false } = {}) {
  const q = new URL(url, location.origin).searchParams;
  const tab = ['orgs', 'bots', 'requests'].includes(q.get('tab')) && state.me.admin ? q.get('tab') : 'teams';
  if (push) history.pushState(null, '', url);
  const sel = q.get(PARAM[tab]);
  const open = () => {
    switchTab(tab);
    if (sel) select(sel);
  };
  // Phones slide between the list and what is picked in it within a page, not to another page
  // or from one picked to another.
  if (instant || tab !== state.tab || (sel && state.sel)) instantly(open);
  // Back to the list within the page: as its back button, what was picked slides out as it was.
  else if (!sel && state.sel) unselect();
  else open();
}

/**
 * Runs `fn` without the phones' slide between the list and what is picked (see the styles):
 * its changes are applied before the slide is back.
 */
function instantly(fn) {
  const main = document.querySelector('main');
  main.classList.add('instant');
  try {
    fn();
  } finally {
    main.getBoundingClientRect();
    main.classList.remove('instant');
  }
}

async function load() {
  // Team managers see their teams only, and no orgs.
  const [teams, orgs, requests, bots] = await Promise.all([call('/api/admin/teams'),
    state.me.admin ? call('/api/admin/orgs') : Promise.resolve({ body: {} }),
    state.me.admin ? call('/api/admin/requests') : Promise.resolve({ body: {} }),
    state.me.admin ? call('/api/admin/bots') : Promise.resolve({ body: {} })]);
  if (!teams.ok) { $('list').innerHTML = `<div class="empty">${esc(teams.body.error || 'Could not load.')}</div>`; return false; }
  state.teams = teams.body.teams;
  state.names = teams.body.names || {};
  state.requests = requests.body.requests || [];
  state.portal = requests.body.portal || [];
  state.conflicts = requests.body.conflicts || [];
  state.portalBound = Boolean(requests.body.portalBound);
  state.openRequests = requests.body.open ?? teams.body.requests ?? 0;
  renderCount();
  state.unassigned = teams.body.unassigned;
  state.orgs = orgs.body.orgs || [];
  state.types = orgs.body.types || ['customer', 'partner', 'vendor'];
  state.bots = bots.body.bots || [];
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
      <div class="row two${state.sel === t.slug ? ' on' : ''}" data-sel="${esc(t.slug)}" title="${esc(t.name)} (${esc(t.slug)})">
        <span class="name">${esc(t.name)}</span>
        <span class="sub">${t.self_managed ? '<span title="Every member is a team manager">Self-managed</span> · ' : ''}${t.members} ${t.members === 1 ? 'person' : 'people'} · ${channelCount(t.channels)}${t.shared ? ` + ${t.shared} shared` : ''} · ${esc(t.slug)}</span></div>`).join('');
    const un = state.unassigned && state.unassigned.channels ? `<div class="row two${state.sel === UNASSIGNED ? ' on' : ''}" data-sel="${UNASSIGNED}">
        <span class="name"><i>Unassigned</i></span><span class="sub">${channelCount(state.unassigned.channels)}</span></div>` : '';
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter teams" value="${esc(state.filter)}"></label>
      <h2>${state.me.admin ? 'Ops teams' : 'Teams you manage'}</h2>${rows || '<div class="empty">No teams.</div>'}${un}
      ${state.me.admin ? `<h2>New team</h2><form class="form" id="newTeam"><label class="fld grow"><span>Name</span><input id="ntName" required></label>
        <label class="fld"><span>Slug</span><input id="ntSlug" pattern="[a-z0-9][a-z0-9-]*" required></label><button class="primary">Create</button></form>` : ''}
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
  } else if (state.tab === 'bots') {
    drawBots(f);
  } else if (state.tab === 'requests') {
    const match = (r) => !f || `${plainName(r.channel)} ${r.channel.channelId} ${teamLabel(r.team)} ${r.requestedBy.name || ''} ${r.requestedBy.email}`
      .toLowerCase().includes(f);
    const row = (r) => `<div class="row${String(state.sel) === String(r.id) ? ' on' : ''}" data-sel="${r.id}">
        <span class="name">${channelName(r.channel)} <span class="sub">${r.move && r.channel.team ? `${esc(teamLabel(r.channel.team))} ` : ''}→ ${esc(teamLabel(r.team))}</span></span>
        ${r.status === 'open' ? '' : statusTag(r)}<span class="sub">${esc(ago(r.status === 'open' ? r.requestedAt : r.decidedAt))}</span></div>`;
    const open = state.requests.filter((r) => r.status === 'open' && match(r));
    const decided = state.requests.filter((r) => r.status !== 'open' && match(r));
    // The customers in the portal: each asks for a channel of its own.
    const asks = state.portal.filter((r) => !f || `${r.company || ''} ${r.domain} ${r.requestedBy.name || ''} ${r.requestedBy.email || ''}`.toLowerCase().includes(f));
    const waiting = asks.filter((r) => r.status === 'open');
    const answered = asks.filter((r) => r.status !== 'open');
    // The conflicts between the teams' technologies (src/techconflicts.js).
    const clash = (state.conflicts || []).filter((c) => !f || conflictTitle(c).toLowerCase().includes(f));
    const unsettled = clash.filter((c) => !c.kept);
    const kept = clash.filter((c) => c.kept);
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter requests" value="${esc(state.filter)}"></label>
      ${waiting.length ? `<h2>Customers waiting in the portal</h2>${waiting.map(portalRow).join('')}` : ''}
      <h2>Waiting for a decision</h2>${open.map(row).join('') || `<div class="empty">${f ? 'Nothing matches.' : 'No request is waiting.'}</div>`}
      ${unsettled.length ? `<h2>Conflicts between technologies</h2>${unsettled.map(conflictRow).join('')}` : ''}
      ${decided.length || answered.length || kept.length ? `<h2>Decided</h2>${answered.map(portalRow).join('')}${decided.map(row).join('')}${kept.map(conflictRow).join('')}` : ''}
      <p class="hint">Team managers ask for channels on their team's page, and thread agents for whoever asks them in a thread's sidebar. Confirming one assigns the channel to the team, as adding it on the team's page does; one that asks for a move moves it, also from another team.</p>`;
  } else {
    const rows = state.orgs.filter((o) => (!f || `${o.name || ''} ${o.slug}`.toLowerCase().includes(f))
      && (!state.noIcon || iconless(o))).map((o) => `
      <div class="row${state.sel === o.slug ? ' on' : ''}" data-sel="${esc(o.slug)}">
        ${ico(o.icon, o.domain)}<span class="name">${esc(o.name || o.slug)}${o.name ? ` <span class="sub">${esc(o.slug)}</span>` : ''}</span>
        ${o.type !== 'customer' ? `<span class="tag ${o.type}">${esc(o.type)}</span>` : ''}
        <span class="sub">${channelCount(o.channels)}</span></div>`).join('');
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter orgs" value="${esc(state.filter)}"></label>
      <label class="only"><input type="checkbox" id="noIcon"${state.noIcon ? ' checked' : ''}> Only the ${state.orgs.filter(iconless).length} without an icon</label>
      ${rows || '<div class="empty">Nothing matches.</div>'}
      <h2>New org</h2><form class="form" id="newOrg"><label class="fld grow"><span>Display name</span><input id="noName" required></label>
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
  else if (state.tab === 'requests' && String(sel).startsWith(PORTAL)) showPortalRequest(String(sel).slice(PORTAL.length));
  else if (state.tab === 'requests' && String(sel).startsWith(CONFLICT)) showConflict(String(sel).slice(CONFLICT.length));
  else if (state.tab === 'requests') showRequest(sel);
  else if (state.tab === 'bots') showBot(sel);
  else showOrg(sel);
}

/** Back to the list (phones), its filter as it was. */
function unselect() {
  state.sel = null;
  toUrl();
  renderList();
  // What was picked slides out as it was (phones); then it goes.
  const out = $('detail').getAnimations().map((a) => a.finished);
  Promise.allSettled(out).then(() => {
    if (!state.sel) $('detail').innerHTML = `<div class="empty pick">Pick ${PICK[state.tab]}.</div>`;
  });
}
const backButton = () => `<button class="back" data-back title="Back to the list" aria-label="Back to the ${state.tab}"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg></button>`;

function switchTab(tab) {
  state.tab = tab;
  state.sel = null;
  state.filter = '';
  toUrl();
  renderList();
  $('detail').innerHTML = `<div class="empty pick">Pick ${PICK[tab]}.</div>`;
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
const platform = (c) => ({ teams: 'Teams', discord: 'Discord', portal: 'Portal' }[c.source] || `Slack${c.shared ? ' Connect' : ''}`);
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
  picks.classList.toggle('s2-up', up);
  picks.style.maxHeight = `${Math.max(120, Math.min(360, up ? above : below))}px`;
}

/** The channels card: a table (redrawn on its own) and a picker that assigns one here. */
function channelsCard(target) {
  // A team manager asks the admin team for a channel instead (a request).
  if (!state.me.admin) {
    return `<div class="card"><h2>Channels</h2><div id="channelsTable"></div>
    <div class="form picker"><label class="fld grow"><span>Ask for a channel</span><input id="pick" autocomplete="off"></label><div class="picks s2-float" id="picks" hidden></div></div>
    <p class="hint">Search by channel, Teams team, customer or id.</p>
    <div id="askSlot"></div>
    <p class="hint">The admin team decides which channels a team gets. Pick a channel to ask them to add it to this team, with a note; they confirm or decline, and the answer shows under Requests. A channel another team holds is shared with this one: it stays filed under its team, and is in this team's inbox too.</p></div>`;
  }
  return `<div class="card"><h2>Channels</h2><div id="channelsTable"></div>
    <div class="form picker"><label class="fld grow"><span>${target === 'team' ? 'Add a channel to this team' : 'Assign a channel here by hand'}</span><input id="pick" autocomplete="off"></label><div class="picks s2-float" id="picks" hidden></div></div>
    <p class="hint">Search by channel, Teams team, customer, team or id. ${target === 'team'
    ? `A channel has one team it is filed under (its folders, knowledge base and agents) and can be shared with more, whose inboxes have it too. Adding a channel ${esc(teamLabel('admin'))} holds files it under this team whatever the rules say (a channel-id rule with priority 10); adding one another team holds shares it with this team, and it stays where it is. <b>Make primary</b> files a channel shared with this team under it instead, and the team it was filed under keeps it, shared. Click a channel's name to move it to another team.${state.view.value !== 'admin' ? ` <b>→ ${esc(teamLabel('admin'))}</b> hands a channel back to the admin team.` : ''}`
    : 'A manual assignment files one channel under this org whatever the rules say (a channel-id rule with priority 10).'}</p></div>`;
}

/**
 * Assigns a channel (as the API listed it) to the open team or org by hand, or to another
 * `value`, and updates the page: the view it was made on, if that is still open. The same
 * assignment twice at once is made once; others queue up behind it (see `serial`).
 */
const assignKey = (target, channelId, value) => `assign:${target}:${channelId}:${value}`;
function assignHere(c, value = state.view.value, { move = false } = {}) {
  const v = state.view;
  const { target } = v;
  const { channelId, source } = c;
  return once(assignKey(target, channelId, value), async () => {
    const what = `${plainName(c)} → ${target === 'team' ? teamLabel(value) : orgLabel(value)}`;
    const res = await ruleChange('POST', '/api/admin/assign', {
      target, value, channelId, source, ...(move ? { move: true } : {}),
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
    // Moved away with no thread to re-file: the API names no move, but it left all the same.
    if (move && target === 'team' && value !== v.value) {
      for (const row of v.channels.filter((x) => x.channelId === channelId && !x.left && x.team !== value)) {
        row.left = { team: value, org: row.org, kind: row.kind };
      }
    }
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
  // The admin team moves a channel from any team's page to any other team.
  const movable = target === 'team' && state.me.admin && state.teams.length > 1;
  // A channel shared with this team can be filed under it instead, its team sharing it then:
  // for the admin team, and for whoever manages both teams.
  const manages = (slug) => state.me.admin || (state.me.manages || []).includes(slug);
  const swappable = (c) => !isHolding(c.team) && manages(c.team) && manages(state.view.value);
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
    // The admin team moves a channel filed here to any team: its name opens the list of them.
    const name = movable && !sharedHere
      ? `<button class="link chan" data-move="${esc(c.channelId)}" aria-haspopup="dialog" title="Move it to another team">${channelName(c)}</button>`
      : channelName(c);
    return `<tr><td>${name}<div class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></div></td>
      <td>${other === 'org' ? esc(orgLabel(c.org)) : teamCell}${c.kind !== 'channel' ? ` <span class="tag">${esc(c.kind)}</span>` : ''}${alsoTag}</td>
      <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td>
      ${triage ? `<td class="nw">${clefTag(c.clef)}${pick ? ` <button class="link" data-give="${esc(c.channelId)}" data-source="${esc(c.source)}" data-team="${esc(pick)}"${off(assignKey(target, c.channelId, pick))} title="Assign it to ${esc(teamLabel(pick))} by hand">→ ${esc(teamLabel(pick))}</button>` : ''}</td>` : ''}
      <td class="nw">${sharedHere ? `<span class="tag manual" title="Filed under ${esc(teamLabel(c.team))}, and in this team's inbox too">shared by ${esc(teamLabel(c.team))}</span>
        ${swappable(c) ? `<button class="link" data-swap="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`swap:${c.channelId}`)} title="File it under ${esc(teamLabel(state.view.value))} (its folders, knowledge base and agents move here); ${esc(teamLabel(c.team))} keeps it in its inbox, shared">Make primary</button>` : ''}
        ${state.me.admin ? `<button class="link" data-unshare="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unshare:${state.view.value}:${c.channelId}`)} title="Take it out of this team's inbox; it stays filed under ${esc(teamLabel(c.team))}">Remove</button>` : ''}`
    : `${manual ? `<span class="tag manual" title="Assigned by hand, whatever the rules say">manual</span>
        ${state.me.admin ? `<button class="link" data-unassign="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unassign:${target}:${c.channelId}`)}>Undo</button>` : ''}` : '<span class="sub">by rule</span>'}
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
  for (const b of $('channelsTable').querySelectorAll('[data-move]')) {
    b.onclick = () => moveMenu(b, find(b.dataset.move));
  }
  for (const b of $('channelsTable').querySelectorAll('[data-give]')) {
    b.onclick = () => press(b, () => assignHere(find(b.dataset.give), b.dataset.team));
  }
  for (const b of $('channelsTable').querySelectorAll('[data-swap]')) {
    const c = find(b.dataset.swap);
    const team = v.value;
    const from = c.team;
    b.onclick = () => hold(b, `swap:${c.channelId}`, async () => {
      const res = await call('/api/admin/swap', 'POST', { team, channelId: c.channelId, source: c.source });
      if (!res.ok) { failed(`Make ${teamLabel(team)} primary for ${plainName(c)}`, res); return; }
      const { moves, rule, swapped } = res.body;
      applyMoves(moves, v);
      // Filed here now, and shared with the team it was filed under (also with no thread to move).
      for (const x of v.channels.filter((y) => y.channelId === c.channelId && !y.left)) {
        x.team = team;
        x.sharedWith = [...new Set([...(x.sharedWith || []).filter((t) => t !== team),
          ...(swapped.shared ? [from] : [])])];
      }
      setManual(c.channelId, rule, v);
      const here = state.teams.find((t) => t.slug === team);
      if (here) here.shared = Math.max(0, (here.shared || 0) - 1);
      const there = state.teams.find((t) => t.slug === from);
      if (there && swapped.shared) there.shared = (there.shared || 0) + 1;
      status('ok', `${plainName(c)} is filed under ${teamLabel(team)} now${moves.length ? ', its threads re-filed in the background' : ''}${swapped.shared ? `; ${teamLabel(from)} keeps it in its inbox, shared` : ''}.`);
      if (v === state.view) renderChannels();
      renderList();
    });
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
 * The admin team's list of teams for a channel of the table, under its name: a Popover with a
 * filter, Clef's pick first. Picking one files the channel under that team by hand (a move: its
 * folders, knowledge base and agents go there; the teams it is shared with keep it), not a
 * share. Arrow keys and Enter pick; Escape and a click elsewhere close it.
 */
const movePop = { el: null, button: null, shut: 0 };
function moveMenu(button, c) {
  if (!c) return;
  // The click that closed it, on its own name: closed it stays.
  if (movePop.button === button && Date.now() - movePop.shut < 300) return;
  let el = movePop.el;
  if (!el) {
    el = document.createElement('div');
    el.className = 'movepop';
    el.popover = 'auto';
    el.setAttribute('role', 'dialog');
    // Closed from within (Escape), the focus goes back to the name it was opened from; a click
    // elsewhere has moved it already.
    let inside = false;
    el.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'closed') return;
      movePop.shut = Date.now();
      inside = el.contains(document.activeElement);
    });
    el.addEventListener('toggle', (e) => {
      const b = movePop.button;
      if (e.newState === 'closed' && inside && b && b.isConnected) b.focus();
    });
    document.body.append(el);
    movePop.el = el;
  }
  if (el.matches(':popover-open')) el.hidePopover();
  movePop.button = button;
  const v = state.view;
  const clef = c.clef && c.clef.team !== 'none' && c.clef.team !== c.team ? c.clef : null;
  const teams = state.teams.filter((t) => t.slug !== c.team)
    .sort((a, b) => (b.slug === clef?.team) - (a.slug === clef?.team) || a.name.localeCompare(b.name));
  let list = teams;
  let at = 0;
  el.setAttribute('aria-label', `Move ${plainName(c)} to a team`);
  el.innerHTML = `<p class="what">Move ${channelName(c)} to</p>
    <label class="s2-search"><input class="search" type="search" aria-label="Find a team" autocomplete="off"></label>
    <div class="opts" role="listbox" aria-label="Teams"></div>
    <p class="hint">Filed there by hand, whatever the rules say; its threads are re-filed. The teams it is shared with keep it.</p>`;
  const input = el.querySelector('input');
  const opts = el.querySelector('.opts');
  const go = (t) => {
    if (!t) return;
    el.hidePopover();
    if (v === state.view) assignHere(c, t.slug, { move: true });
  };
  const render = () => {
    opts.innerHTML = list.map((t, i) => `<div class="row${i === at ? ' on' : ''}" role="option" aria-selected="${i === at}" data-i="${i}">
      <span class="name">${esc(t.name)} <span class="sub mono">${esc(t.slug)}</span></span>
      ${t.slug === clef?.team ? clefTag(clef, clef.p) : ''}</div>`).join('')
      || '<div class="empty pad">No team matches.</div>';
    for (const row of opts.querySelectorAll('[data-i]')) {
      // The list shown when the row is picked.
      // eslint-disable-next-line no-loop-func
      row.onclick = () => go(list[Number(row.dataset.i)]);
    }
    const on = opts.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    list = teams.filter((t) => words.every((w) => `${t.name} ${t.slug}`.toLowerCase().includes(w)));
    at = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      at = (at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(list[at]);
    } else if (e.key === 'Escape') {
      // A search field takes Escape for itself: the list closes all the same.
      e.preventDefault();
      el.hidePopover();
    }
  };
  render();
  // Under the name, or above it when there is no room below; inside the window either way.
  const r = button.getBoundingClientRect();
  el.classList.remove('up');
  el.showPopover();
  const { width, height } = el.getBoundingClientRect();
  const gap = 4;
  const up = r.bottom + gap + height > innerHeight && r.top - gap - height > 0;
  el.classList.toggle('up', up);
  el.style.left = `${Math.max(gap, Math.min(r.left, innerWidth - width - gap))}px`;
  el.style.top = `${up ? r.top - gap - height : Math.min(r.bottom + gap, Math.max(gap, innerHeight - height - gap))}px`;
  input.focus();
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
    }).join('') || '<div class="empty pad">No channel matches.</div>';
    // Placed first: it settles from the side it opens on (ui/spectrum.css, `.s2-float`).
    placePicks(input, picks);
    picks.hidden = false;
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

/**
 * The technologies the team follows (src/follows.js): the threads that show one are in its
 * inbox. Its managers and the admin team pick them; the list offers the rest of the tech stack,
 * by product.
 */
function renderFollows() {
  const v = state.view;
  const { team } = v;
  const byId = new Map(v.followable.map((t) => [t.tech, t]));
  const name = (id) => byId.get(id)?.name || id;
  $('followsTable').innerHTML = v.follows.length
    ? `<table><tr><th>Technology</th><th>Product</th><th>Added by</th><th></th></tr>${v.follows.map((f) => `<tr>
      <td>${esc(name(f.tech))} <span class="sub mono">${esc(f.tech)}</span></td><td>${esc(byId.get(f.tech)?.product || '')}</td>
      <td>${esc(f.added_by || '')}</td>
      <td><button class="link" data-unfollow="${esc(f.tech)}"${off(`follow:${team.slug}:${f.tech}`)}>Unfollow</button></td></tr>`).join('')}</table>`
    : '<div class="empty">None yet: the inbox has the team\'s channels and the channels shared with it.</div>';
  const followed = new Set(v.follows.map((f) => f.tech));
  const groups = new Map();
  for (const t of v.followable.filter((x) => !followed.has(x.tech))) {
    const g = t.product || 'Other';
    groups.set(g, [...(groups.get(g) || []), t]);
  }
  $('fTech').innerHTML = `<option value="">Pick one…</option>${[...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${esc(t.tech)}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}`;
  const change = (tech, follow, button) => hold(button, `follow:${team.slug}:${tech}`, async () => {
    const res = await call('/api/admin/follows', 'PUT', { team: team.slug, tech, follow });
    if (!res.ok) { failed(follow ? `Follow ${name(tech)}` : `Unfollow ${name(tech)}`, res); return; }
    v.follows = res.body.follows;
    status('ok', follow ? `${team.name} follows ${name(tech)}: the threads that show it are in its inbox.` : `${team.name} no longer follows ${name(tech)}.`);
    if (v === state.view) renderFollows();
  });
  for (const b of $('followsTable').querySelectorAll('[data-unfollow]')) {
    b.onclick = () => change(b.dataset.unfollow, false, b);
  }
  $('followForm').onsubmit = (e) => {
    e.preventDefault();
    const tech = $('fTech').value;
    if (tech) change(tech, true, $('fAdd'));
  };
}

function renderMembers() {
  const { members, team } = state.view;
  const role = (m) => {
    if (team.self_managed) return '<span class="tag manual" title="Every member of a self-managed team is a team manager">manager</span>';
    return m.role === 'manager'
      ? `<span class="tag manual">manager</span> <button class="link" data-role="member" data-person="${m.id}"${off(`member:${team.slug}:${m.id}`)} title="Back to member">Demote</button>`
      : `<button class="link" data-role="manager" data-person="${m.id}"${off(`member:${team.slug}:${m.id}`)} title="May add and remove members and edit the team's knowledge base">Make manager</button>`;
  };
  $('membersTable').innerHTML = members.length
    ? `<table><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr>${members.map((m) => `<tr>
      <td>${esc(m.name || '')}${m.staff ? '' : ' <span class="tag vendor" title="Not marked as Adobe staff">not staff</span>'}</td><td>${esc(m.email)}</td>
      <td>${role(m)}</td>
      <td><button class="link" data-remove="${m.id}"${off(`member:${team.slug}:${m.id}`)}>Remove</button></td></tr>`).join('')}</table>`
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
      || '<div class="empty pad">Nobody matches. Type a full email address to add someone new.</div>';
    // Placed first: it settles from the side it opens on (ui/spectrum.css, `.s2-float`).
    placePicks(input, picks);
    picks.hidden = false;
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
    <td><button class="link" data-edit="${r.id}">Edit</button><button class="link" data-del="${r.id}"${off(`rule:${r.id}`)}>Delete</button></td></tr>`;
}

function ruleForm(r = {}) {
  const prefix = r.pattern ? prefixOf(r.pattern) : '';
  const mode = prefix !== null ? 'prefix' : 'regex';
  return `<form class="form" id="ruleForm" data-id="${r.id || ''}">
    <label class="fld"><span>Field</span><select id="rField">${Object.entries(FIELD_LABEL).map(([k, v]) => `<option value="${k}"${(r.field || 'name') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="fld"><span>Match</span><select id="rMode"><option value="prefix"${mode === 'prefix' ? ' selected' : ''}>starts with</option><option value="regex"${mode === 'regex' ? ' selected' : ''}>regular expression</option></select></label>
    <label class="fld grow"><span>Pattern</span><input id="rPattern" class="mono" value="${esc(mode === 'prefix' ? prefix : r.pattern)}" required></label>
    <label class="fld"><span>Platform</span><select id="rSource"><option value="">Every platform</option><option value="slack"${r.source === 'slack' ? ' selected' : ''}>Slack only</option><option value="teams"${r.source === 'teams' ? ' selected' : ''}>Teams only</option><option value="discord"${r.source === 'discord' ? ' selected' : ''}>Discord only</option><option value="portal"${r.source === 'portal' ? ' selected' : ''}>Portal only</option></select></label>
    <label class="fld"><span>Priority</span><input id="rPriority" type="number" min="0" max="10000" value="${r.priority ?? 100}" title="The lowest matching rule wins"></label>
    <label class="fld"><span>Note (optional)</span><input id="rNote" value="${esc(r.note || '')}"></label>
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
    team, members, rules, channels, suggestions, coverage, requests = [], follows = [], followable = [],
    portal = [],
  } = r.body;
  if (r.body.portalBound !== undefined) state.portalBound = Boolean(r.body.portalBound);
  const v = {
    target: 'team', value: slug, team, members, rules, channels, suggestions, coverage, requests, follows, followable, portal,
  };
  state.view = v;
  const templates = rules.filter((x) => x.value !== slug);
  const real = slug !== UNASSIGNED;
  const admin = Boolean(state.me.admin);
  let title = '<h1>Unassigned channels</h1>';
  if (real) {
    title = admin ? `<input class="big" id="tName" value="${esc(team.name)}" aria-label="Team name">`
      : `<h1 class="fill">${esc(team.name)}</h1>`;
  }
  $('detail').innerHTML = `
    <div class="title">${backButton()}${title}
      <span class="sub mono">${esc(team.slug)}</span>
      ${real ? `<a href="/inbox/kb?team=${encodeURIComponent(team.slug)}">Knowledge base</a>` : ''}
      ${admin && real && team.slug !== 'admin' ? '<button class="danger" id="tDelete">Delete team</button>' : ''}</div>
    <div class="status" id="status"></div>
    ${real ? `<div class="card"><label class="inline">
      <input type="checkbox" id="tSelf"${team.self_managed ? ' checked' : ''}${admin ? '' : ' disabled'}>
      <span><b>Self-managed</b>: every member is a team manager and may add and remove members and edit the team's knowledge base.</span></label>
      <p class="hint">${admin ? 'Turning it on makes every member a manager, now and when they join. Turning it off keeps the roles as they are; new members join as members, and managers can be demoted.' : 'Only the admin team changes this.'}</p></div>` : ''}
    ${real ? `<div class="card"><h2>Members</h2><div id="membersTable"></div>
      <div class="form picker"><label class="fld grow"><span>Add a member</span><input id="mFind" autocomplete="off"></label><div class="picks s2-float" id="mPicks" hidden></div></div>
      <p class="hint">Type a name or an email. Members see this team's inbox. They also need to be in the Access policy of the inbox.</p></div>

    ${admin ? `<div class="card"><h2>Rules</h2><div id="rulesTable"></div>
      <div id="ruleSlot">${ruleForm()}</div>
      <p class="hint">A channel goes to the team of the matching rule with the lowest priority. Example: channel name starts with <code>aem-</code>.</p>
      ${templates.length ? `<p class="hint">${templates.length} rule${templates.length === 1 ? '' : 's'} name the team from the match ($1) and may also apply.</p>` : ''}</div>` : ''}` : ''}
    ${channelsCard('team')}
    ${real ? `<div class="card"><h2>Technologies</h2><div id="followsTable"></div>
      <form class="form" id="followForm"><label class="fld grow"><span>Follow a technology</span><select id="fTech"></select></label>
      <button class="primary" id="fAdd">Follow</button></form>
      <p class="hint">Threads that show one of these technologies are in this team's inbox, in any team's channels, and its members work them there. Clef tags each thread with what the thread itself shows, not what its channel uses. The channels stay filed where they are, and the thread's agent gets this team's knowledge base too.</p></div>` : ''}
    ${real && (!admin || v.requests.length) ? `<div class="card"><h2>Requests</h2><div id="requestsTable"></div>
      <p class="hint">${admin ? 'Channels this team\'s managers asked for. Review one to confirm or decline it.' : 'The channels this team asked the admin team for, and their answers.'}</p></div>` : ''}
    ${real && v.portal.length ? `<div class="card"><h2>Customers in the portal</h2><div id="portalTable"></div>
      <p class="hint">Customers who signed in to the customer portal and picked a technology this team follows. Opening a channel makes it in the portal, filed under this team, with your welcome message as its first thread.</p></div>` : ''}
    ${suggestions ? `<div class="card"><h2>Suggested channels</h2>
      <p class="hint lead">Channels the admin team holds (no rule files them under a team) where members of ${esc(team.name)} post, react or are members, and the ones Clef thinks are this team's. Add assigns one here by hand.</p>
      <div id="suggestTable"></div></div>` : ''}`;
  showStatus();
  renderChannels();
  if (suggestions) renderSuggestions();
  wireChannelPicker();
  if ($('requestsTable')) renderRequests();
  if ($('portalTable')) renderPortal();
  if (!real) return;
  renderMembers();
  wireMemberPicker();
  renderFollows();
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
    // Only a team without rules or threads can be deleted (the API refuses the others), and
    // only once you have said so: its members and their roles go with it.
    $('tDelete').onclick = async () => (await confirmFirst(
      `Delete ${team.name}?`,
      'The team goes, and its members are no longer on it. A team that still has rules or threads is not deleted.',
      'Delete team',
    )) && hold($('tDelete'), `delete:${slug}`, async () => {
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
  open: 'pending', confirmed: 'confirmed', declined: 'declined', withdrawn: 'withdrawn', opened: 'opened',
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
  state.portal = r.body.portal || [];
  state.conflicts = r.body.conflicts || [];
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
    ? `<button class="link" data-review="${r.id}">Review</button>`
    : `<button class="link" data-withdraw="${r.id}"${off(`request:${r.id}`)} title="Take the request back">Withdraw</button>`}</td></tr>`).join('');
  $('requestsTable').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>Asked by</th><th>Note</th><th>Answer</th><th></th></tr>${rows}</table>`
    : '<div class="empty">Nothing asked for yet. Search for a channel above to ask for it.</div>';
  for (const b of $('requestsTable').querySelectorAll('[data-review]')) {
    b.onclick = () => instantly(() => { switchTab('requests'); select(b.dataset.review); });
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
    <span class="what">Ask the admin team to add <b>${channelName(c)}</b> to ${esc(teamLabel(v.value))}
      <span class="sub">(now in ${esc(teamLabel(c.team))}${shares ? '; it would be shared with this team and stay filed there' : ''})</span></span>
    <label class="fld grow"><span>Why this team should have it (optional)</span><input id="askNote" maxlength="500"></label>
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
    <div class="title">${backButton()}<h1 class="fill">${channelName(c)} <span class="sep">→</span> ${esc(teamLabel(r.team))}</h1>${statusTag(r)}</div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label>Channel</label><span>${channelName(c)} <span class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></span></span>
      <label>Now</label><span>${c.team ? `filed under <b>${esc(teamLabel(c.team))}</b>` : 'no threads yet'}${org ? ` · customer <b>${esc(org)}</b>` : ''} · ${c.threads} thread${c.threads === 1 ? '' : 's'}</span>
      <label>For</label><span><a href="/inbox/admin?tab=teams&team=${encodeURIComponent(r.team)}">${esc(teamLabel(r.team))}</a></span>
      <label>Asks</label><span>${r.move ? `a move: filed under ${esc(teamLabel(r.team))}${c.team && c.team !== r.team ? ` instead of ${esc(teamLabel(c.team))}` : ''}` : `to be in ${esc(teamLabel(r.team))}'s inbox`}</span>
      <label>Asked by</label><span>${who(r.requestedBy)} <span class="sub">${esc(ago(r.requestedAt))}</span></span>
      ${r.thread ? `<label>Asked in</label><span>the <a href="/inbox?team=${encodeURIComponent(c.team || r.team)}&t=${encodeURIComponent(r.thread)}">sidebar of a thread</a> of this channel, through its agent</span>` : ''}
      ${r.note ? `<label>Note</label><span class="note">${esc(r.note)}</span>` : ''}
      ${open ? '' : `<label>Answer</label><span>${decisionText(r)}</span>`}
    </div></div>
    ${open ? `<div class="card"><h2>Confirming it</h2><div class="preview" id="rqPreview">${preview ? previewText(r, preview) : '<span class="sub">Trying it…</span>'}</div>
      <div class="form"><button class="primary" id="rqConfirm"${preview && preview.ok ? '' : ' disabled'}${off(`request:${r.id}`)}>Confirm</button></div></div>
      <div class="card"><h2>Declining it</h2><form class="form" id="rqDeclineForm"><label class="fld grow"><span>Reason, for the manager (optional)</span><input id="rqReason" maxlength="500"></label>
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

// ---- customers in the portal ---------------------------------------------------------------
//
// A customer who can use neither Slack nor Teams with Adobe signs in to the customer portal
// with their work mail address, says what they use of Adobe's and asks for a channel
// (src/portalrequests.js). The admin team answers under Requests: Open channel makes the
// channel in the portal, files it under a team and a customer, and posts the welcome message
// as whoever opens it; Decline takes a reason the customer reads. A team's managers see the
// customers who picked a technology the team follows on their team's page, and open a channel
// for their team.

/** What marks a portal request among the requests picked (`?request=portal:3`). */
const PORTAL = 'portal:';

const portalRow = (r) => `<div class="row${String(state.sel) === `${PORTAL}${r.id}` ? ' on' : ''}" data-sel="${PORTAL}${r.id}">
  <span class="name">${esc(r.company || r.domain)} <span class="sub">${esc(r.domain)}</span></span>
  ${r.status === 'open' ? '' : statusTag(r)}<span class="sub">${esc(ago(r.status === 'open' ? r.requestedAt : r.decidedAt))}</span></div>`;

/** The message a new channel starts with, until whoever opens it writes their own. */
const welcomeText = (r, team) => `Welcome to Adobe Enterprise Support, ${r.company || r.domain}! This is your channel with the ${teamLabel(team)} team. Start a new thread for each question, and we answer you here.`;

/** A portal request as it is now, wherever the page shows it. */
function updatePortal(r) {
  const was = state.portal.find((x) => x.id === r.id);
  if (was && was.status === 'open' && r.status !== 'open') state.openRequests = Math.max(0, state.openRequests - 1);
  if (was) Object.assign(was, r); else state.portal.unshift(r);
  const mine = state.view?.portal?.find((x) => x.id === r.id);
  if (mine) Object.assign(mine, r);
  renderCount();
}

/**
 * A customer's request: who they are, what they use, and Open channel or Decline. `forTeam`:
 * a manager came from their team's page, and opens it for that team.
 */
function drawPortalRequest(r, forTeam = null) {
  const admin = Boolean(state.me.admin);
  const open = r.status === 'open';
  const follows = new Map(r.teams.map((t) => [t.team, t]));
  // The teams it may go to: the admin team picks any; a manager, theirs that follow.
  const teams = admin ? [...state.teams].sort((a, b) => Number(follows.has(b.slug)) - Number(follows.has(a.slug)))
    : state.teams.filter((t) => follows.has(t.slug));
  const first = forTeam || (teams[0] && teams[0].slug) || '';
  const techName = new Map(r.tech.map((t) => [t.tech, t.name]));
  const why = (t) => (follows.has(t) ? ` (follows ${follows.get(t).tech.map((id) => techName.get(id) || id).join(', ')})` : '');
  const c = r.channel;
  $('detail').innerHTML = `
    <div class="title">${forTeam ? `<button class="back shown" id="pqBack" title="Back to ${esc(teamLabel(forTeam))}" aria-label="Back to ${esc(teamLabel(forTeam))}"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg></button>` : backButton()}
      ${r.logo ? `<img class="ico" src="${esc(r.logo)}" alt="" title="The logo ${esc(r.company || r.domain)} uploaded in the portal">` : ''}
      <h1 class="fill">${esc(r.company || r.domain)} <span class="sub">${esc(r.domain)}</span></h1>${statusTag(r)}</div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label>Asks for</label><span>a channel in the customer portal</span>
      <label>Uses</label><span>${r.tech.map((t) => `<span class="tag">${esc(t.name)}</span>`).join(' ') || '<span class="sub">nothing picked</span>'}</span>
      <label>Followed by</label><span>${r.teams.length ? r.teams.map((t) => `<a href="/inbox/admin?tab=teams&team=${encodeURIComponent(t.team)}">${esc(t.name)}</a> <span class="sub">${esc(t.tech.map((id) => techName.get(id) || id).join(', '))}</span>`).join(' · ') : '<span class="sub">no team follows any of these</span>'}</span>
      ${r.note ? `<label>Needs</label><span class="note">${esc(r.note)}</span>` : ''}
      <label>Asked by</label><span>${who(r.requestedBy)} <span class="sub">${esc(r.requestedBy.email || '')} · ${esc(ago(r.requestedAt))}</span></span>
      <label>People</label><span>${r.members.map((m) => `${esc(m.name || m.email)}${m.joined ? '' : ' <span class="sub">(invited)</span>'}`).join(', ')}</span>
      ${c ? `<label>Channel</label><span>filed under <a href="/inbox/admin?tab=teams&team=${encodeURIComponent(c.team)}">${esc(teamLabel(c.team))}</a> · customer <b>${esc(orgLabel(c.org))}</b> <span class="sub mono">${esc(c.channelId)}</span></span>` : ''}
      ${open ? '' : `<label>Answer</label><span>${statusTag(r)} by ${who(r.decidedBy)} ${esc(ago(r.decidedAt))}${r.reason ? `: <span class="note">${esc(r.reason)}</span>` : ''}</span>`}
    </div></div>
    ${r.status === 'declined' ? '' : `<div class="card"><h2>${c ? 'Opening another channel' : 'Opening a channel'}</h2>
      ${state.portalBound ? '' : '<p class="hint lead">The customer portal is not connected to this inbox yet (PORTAL_WORKER): no channel can be opened from here.</p>'}
      <form class="form portalopen" id="pqForm">
        <label class="fld"><span>Channel name</span><input id="pqName" maxlength="80" value="${esc(c ? '' : r.suggest.name)}" required></label>
        ${admin ? `<label class="fld"><span>Customer${r.suggest.known ? `: ${esc(r.suggest.orgName || r.suggest.org)}` : ' (new)'}</span><input id="pqOrg" class="mono" maxlength="63" value="${esc(c ? c.org : r.suggest.org)}" required></label>` : ''}
        <label class="fld"><span>Team</span><select id="pqTeam"${forTeam ? ' disabled' : ''}>${teams.map((t) => `<option value="${esc(t.slug)}"${t.slug === first ? ' selected' : ''}>${esc(t.name)}${esc(why(t.slug))}</option>`).join('')}</select></label>
        ${admin && teams.length > 1 ? `<fieldset class="what shares"><legend>Also in the inbox of</legend>${teams.map((t) => `<label class="only"><input type="checkbox" name="pqShare" value="${esc(t.slug)}"> ${esc(t.name)}</label>`).join('')}</fieldset>` : ''}
        <label class="fld what"><span>Welcome message, posted as you: the channel's first thread</span><textarea id="pqWelcome" rows="4" maxlength="8000">${esc(first ? welcomeText(r, first) : '')}</textarea></label>
        <button class="primary" id="pqOpen"${state.portalBound && teams.length ? '' : ' disabled'}${off(`portal:${r.id}`)}>Open channel</button></form>
      <p class="hint">${admin ? 'The portal makes the channel, with everyone of the customer\'s lobby in it. Here it is filed under the team and the customer by hand (a channel-id rule with priority 10 each), and is in the other teams\' inboxes too.' : 'The portal makes the channel, with everyone of the customer\'s lobby in it, and it is filed under your team.'}</p></div>`}
    ${open && admin ? `<div class="card"><h2>Declining it</h2><form class="form" id="pqDeclineForm"><label class="fld grow"><span>Reason, for the customer (optional)</span><input id="pqReason" maxlength="500"></label>
      <button class="danger" id="pqDecline"${off(`portal:${r.id}`)}>Decline</button></form></div>` : ''}`;
  showStatus();
  if ($('pqBack')) $('pqBack').onclick = () => showTeam(forTeam);
  const again = (req) => {
    updatePortal(req);
    renderList();
    drawPortalRequest(req, forTeam);
  };
  if ($('pqTeam')) {
    // The team the channel is filed under has it already: not one to share it with.
    const shares = () => {
      for (const box of document.querySelectorAll('[name="pqShare"]')) {
        box.disabled = box.value === $('pqTeam').value;
        if (box.disabled) box.checked = false;
      }
    };
    shares();
    // The welcome names the team, until it is written by hand.
    $('pqTeam').onchange = () => {
      const w = $('pqWelcome');
      if (!w.dataset.touched) w.value = welcomeText(r, $('pqTeam').value);
      shares();
    };
    $('pqWelcome').oninput = () => { $('pqWelcome').dataset.touched = '1'; };
  }
  if ($('pqForm')) {
    $('pqForm').onsubmit = (e) => {
      e.preventDefault();
      const body = {
        id: r.id,
        team: $('pqTeam').value,
        name: $('pqName').value,
        org: $('pqOrg') ? $('pqOrg').value : undefined,
        share: [...document.querySelectorAll('[name="pqShare"]:checked')].map((x) => x.value).filter((t) => t !== $('pqTeam').value),
        welcome: $('pqWelcome').value,
      };
      // Opening it twice would make two channels: not sent again by itself.
      hold($('pqOpen'), `portal:${r.id}`, () => call('/api/admin/portal/open', 'POST', body)).then((res) => {
        if (!res) return;
        if (!res.ok) {
          failed(`Open a channel for ${r.company || r.domain}`, res);
        } else {
          const { channel, shared = [], welcome } = res.body;
          const also = shared.length ? `, and in the inbox of ${shared.map(teamLabel).join(', ')}` : '';
          const said = welcome && welcome.error ? `; the welcome message was not posted (${welcome.error})` : '';
          status(said ? 'warn' : 'ok', `Opened #${channel.name} for ${r.company || r.domain}, filed under ${teamLabel(channel.team)}${also}${said}.`);
        }
        // Drawn again once the button is free: the request as it is now.
        if (res.body.request) again(res.body.request);
      });
    };
  }
  if ($('pqDeclineForm')) {
    $('pqDeclineForm').onsubmit = (e) => {
      e.preventDefault();
      const reason = $('pqReason').value.trim() || undefined;
      hold($('pqDecline'), `portal:${r.id}`, () => call('/api/admin/portal/decline', 'POST', { id: r.id, reason })).then((res) => {
        if (!res) return;
        if (!res.ok) failed(`Decline ${r.company || r.domain}`, res);
        else status('ok', `Declined ${r.company || r.domain}.`);
        if (res.body.request) again(res.body.request);
      });
    };
  }
}

function showPortalRequest(id) {
  loadingPage();
  state.view = null;
  const r = state.portal.find((x) => String(x.id) === String(id));
  if (!r) { $('detail').innerHTML = '<div class="empty">No such request.</div>'; return; }
  drawPortalRequest(r);
}

/** The team page's customers in the portal: those who picked a technology the team follows. */
function renderPortal() {
  const v = state.view;
  const rows = v.portal.map((r) => `<tr><td>${esc(r.company || r.domain)}<div class="sub">${esc(r.domain)}</div></td>
    <td>${r.tech.filter((t) => r.teams.some((x) => x.team === v.value && x.tech.includes(t.tech))).map((t) => `<span class="tag">${esc(t.name)}</span>`).join(' ')}</td>
    <td class="nw">${who(r.requestedBy)}<div class="sub">${esc(ago(r.requestedAt))}</div></td>
    <td>${statusTag(r)}</td>
    <td class="nw"><button class="link" data-portal="${r.id}">${r.status === 'open' ? 'Open a channel' : 'Show'}</button></td></tr>`).join('');
  $('portalTable').innerHTML = `<table><tr><th>Customer</th><th>Uses</th><th>Asked by</th><th>Status</th><th></th></tr>${rows}</table>`;
  for (const b of $('portalTable').querySelectorAll('[data-portal]')) {
    const r = v.portal.find((x) => String(x.id) === b.dataset.portal);
    b.onclick = () => {
      if (!state.portal.some((x) => x.id === r.id)) state.portal.push(r);
      drawPortalRequest(r, v.value);
    };
  }
}

// ---- conflicts between the teams' technologies ---------------------------------------------
//
// Computed from the tech stack every time (src/techconflicts.js): an id two teams define
// otherwise, or a name two ids share. Settling one writes the teams' catalog files as you.

const CONFLICT = 'conflict:';
const FIELD_NAMES = {
  name: 'name', description: 'what Clef is asked', layer: 'layer', product: 'product', enabled: 'on or off',
};

function conflictTitle(c) {
  return c.kind === 'diverging' ? `${c.tech}: ${c.fields.map((x) => FIELD_NAMES[x] || x).join(', ')}`
    : `"${c.name}": ${c.techs.join(', ')}`;
}

function conflictRow(c) {
  const sel = `${CONFLICT}${c.key}`;
  return `<div class="row${String(state.sel) === sel ? ' on' : ''}" data-sel="${esc(sel)}">
    <span class="name">${esc(c.kind === 'diverging' ? c.tech : `"${c.name}"`)} <span class="sub">${esc(c.kind === 'diverging' ? `${c.definitions.map((d) => teamLabel(d.team)).join(' · ')}` : c.techs.join(' · '))}</span></span>
    ${c.kept ? '<span class="tag confirmed">kept</span>' : ''}</div>`;
}

/**
 * Where a definition is asked: in its team's channels, and the shared one (the admin team's if it
 * is on, else the first team's by name that is on, as src/extract.js `techFor`) everywhere else.
 */
function askedWhere(c, d) {
  if (!d.enabled) return 'no, turned off';
  if (c.kind !== 'diverging') return 'yes';
  const shared = c.definitions.find((x) => x.enabled);
  return `in ${esc(teamLabel(d.team))}'s channels${shared === d ? ', and in every channel of a team without its own' : ''}`;
}

/** One team's definition of a technology: where it is kept, and what it says. */
function definitionCard(c, d) {
  const where = d.path ? `<a href="/inbox/kb?repo=${encodeURIComponent(`kb-team-${d.team}`)}&path=${encodeURIComponent(d.path)}">${esc(d.path)}</a>`
    : '<span class="sub">saved in D1</span>';
  const differs = (f) => (c.kind === 'diverging' && c.fields.includes(f) ? ' class="differs"' : '');
  const k = c.kind === 'name' ? c.key.slice('name:'.length) : null;
  const asAlias = k && d.aliases.some((a) => a.toLowerCase().replace(/[^a-z0-9.+#@]+/g, ' ').trim() === k);
  const acts = [];
  if (c.kind === 'diverging') acts.push(`<button class="primary" data-act="use" data-team="${esc(d.team)}">Use this one everywhere</button>`);
  if (asAlias) acts.push(`<button data-act="unalias" data-team="${esc(d.team)}" data-tech="${esc(d.tech)}">Take "${esc(c.name)}" off its aliases</button>`);
  if (c.kind === 'name' && d.path) acts.push(...c.techs.filter((t) => t !== d.tech).map((t) => `<button data-act="merge" data-from="${esc(t)}" data-into="${esc(d.tech)}">Merge ${esc(t)} into this</button>`));
  acts.push(`<button class="danger" data-act="delete" data-team="${esc(d.team)}" data-tech="${esc(d.tech)}">Delete</button>`);
  return `<div class="card conflict"><h2>${esc(d.name)} <span class="sub mono">${esc(d.tech)}</span> <span class="sub">${esc(teamLabel(d.team))}</span></h2>
    <div class="field">
      <label>Kept in</label><span>${where}</span>
      <label${differs('description')}>Clef is asked</label><span${differs('description')}>Does this thread show that the customer uses ${esc(d.description)}?</span>
      <label${differs('name')}>Name</label><span${differs('name')}>${esc(d.name)}</span>
      <label${differs('product')}>Product</label><span${differs('product')}>${esc(d.product || '–')}</span>
      <label${differs('layer')}>Layer</label><span${differs('layer')}>${esc(d.layer || '–')}</span>
      <label${differs('enabled')}>Asked</label><span${differs('enabled')}>${askedWhere(c, d)}</span>
      <label>Also called</label><span>${d.aliases.length ? d.aliases.map((a) => esc(a)).join(', ') : '–'}</span>
    </div>
    <div class="acts">${acts.join('')}</div></div>`;
}

function drawConflict(c) {
  const what = c.kind === 'diverging'
    ? `${c.definitions.length} teams define <span class="mono">${esc(c.tech)}</span> otherwise (${esc(c.fields.map((x) => FIELD_NAMES[x] || x).join(', '))}). Each team's is what Clef asks in its channels. Keep it if that is meant, or use one of them everywhere.`
    : `"${esc(c.name)}" is a name or alias of ${c.techs.map((t) => `<span class="mono">${esc(t)}</span>`).join(' and ')}: a thread that names it matches either. Take it off the aliases of one, merge them into one technology, or keep it.`;
  $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(c.kind === 'diverging' ? c.tech : `"${c.name}"`)}</h1>${c.kept ? '<span class="tag confirmed">kept</span>' : ''}</div>
    <div class="status" id="status"></div>
    <div class="card"><p class="lead">${what}</p>
      ${c.kept ? `<p class="hint">Kept by ${esc(c.kept.by)} ${esc(ago(c.kept.at))}${c.kept.note ? `: <span class="note">${esc(c.kept.note)}</span>` : ''}. It shows again once a definition changes.</p>`
    : '<form class="form" id="cfKeep"><label class="fld grow"><span>Why it is meant (optional)</span><input id="cfNote" maxlength="300"></label><button id="cfKeepBtn">Keep as it is</button></form>'}
      <p class="hint">Settling it writes the teams' catalog files as you (or the rows saved in D1). A merge also rewrites the labels, follows, rules and lobbies that name the technology that goes: that cannot be undone by reverting the file.</p></div>
    ${c.definitions.map((d) => definitionCard(c, d)).join('')}`;
  showStatus();
  const settle = (btn, body, done) => hold(btn, `conflict:${c.key}`, () => call('/api/admin/conflicts', 'POST', { key: c.key, ...body })).then((res) => {
    if (!res) return;
    if (!res.ok) { failed(`Settle ${conflictTitle(c)}`, res); return; }
    state.conflicts = res.body.conflicts || [];
    refreshRequests();
    status('ok', done);
    const now = state.conflicts.find((x) => x.key === c.key);
    if (now) drawConflict(now);
    else $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(conflictTitle(c))}</h1></div><div class="status" id="status"></div><div class="empty">Settled: ${esc(done)}</div>`;
    showStatus();
    renderList();
  });
  if ($('cfKeep')) {
    $('cfKeep').onsubmit = (e) => {
      e.preventDefault();
      settle($('cfKeepBtn'), { action: 'keep', note: $('cfNote').value.trim() || undefined }, 'Kept as it is.');
    };
  }
  for (const b of $('detail').querySelectorAll('[data-act]')) {
    b.onclick = async () => {
      const { act } = b.dataset;
      const body = {
        action: act, team: b.dataset.team, tech: b.dataset.tech, from: b.dataset.from, into: b.dataset.into,
      };
      const ask = {
        use: [`Use ${teamLabel(b.dataset.team)}'s ${c.tech} everywhere?`, 'The other teams\' files and rows of it are deleted.', 'Use it'],
        delete: [`Delete ${teamLabel(b.dataset.team)}'s ${b.dataset.tech}?`, 'Its file (or row) goes; Clef asks the others\' where they are.', 'Delete'],
        merge: [`Merge ${b.dataset.from} into ${b.dataset.into}?`, `Every file of ${b.dataset.from} goes, and what was labeled, followed or detected as ${b.dataset.from} becomes ${b.dataset.into}, for good.`, 'Merge'],
      }[act];
      if (ask && !(await confirmFirst(...ask))) return;
      const done = {
        use: `${c.tech} is ${teamLabel(b.dataset.team)}'s everywhere.`,
        delete: `Deleted ${teamLabel(b.dataset.team)}'s ${b.dataset.tech}.`,
        unalias: `"${c.name}" is not an alias of ${b.dataset.tech} any more.`,
        merge: `Merged ${b.dataset.from} into ${b.dataset.into}.`,
      }[act];
      settle(b, body, done);
    };
  }
}

function showConflict(key) {
  loadingPage();
  state.view = null;
  const c = (state.conflicts || []).find((x) => x.key === key);
  if (!c) { $('detail').innerHTML = '<div class="empty">No such conflict: it may be settled already.</div>'; return; }
  drawConflict(c);
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
    <div class="title">${backButton()}<span id="oIco">${ico(org.icon, domain)}</span><h1 class="fill" id="oTitle">${esc(org.name || org.slug)}</h1>
      <span class="sub mono">${esc(org.slug)}</span><button class="danger" id="oDelete" title="Forget the name, icon and type"${org.updated_at ? '' : ' hidden'}>Reset</button></div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label for="oName">Display name</label><span class="inline"><input id="oName" class="fill" value="${esc(org.name || '')}"></span>
      <label>Type</label><span class="seg" id="oType">${types.map((t) => `<button type="button" data-type="${t}" aria-pressed="${org.type === t}">${t}</button>`).join('')}</span>
      <label for="oIcon">Icon</label><span class="inline"><input id="oIcon" class="mono fill" value="${esc(org.icon || '')}"></span>
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
    $('oTitle').textContent = o.name || slug;
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
    // Clef does not read SVGs: they are offered without its verdict.
    const verdict = c.svg ? ': an SVG, which Clef does not check' : share && `: ${share} the org's, says Clef`;
    return `<button type="button" class="iconpick${c.p !== null && c.p < FITS ? ' weak' : ''}" data-icon="${esc(c.icon)}"
      title="${esc(`${what}${c.title ? ` (“${c.title}”)` : ''}${verdict}`)}"><img src="${esc(c.via === 'favicon' ? favicon(c.icon) : c.src)}" alt="">
      <span class="host">${esc(c.host)}${c.via === 'site' ? ' <span class="sub">site</span>' : ''}</span><span class="sub">${c.svg ? 'SVG' : share}</span></button>`;
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

// ---- bots -------------------------------------------------------------------------------
//
// The bots in the threads (src/ourbots.js): Adobe's own count as staff, so the inbox shows them
// on Adobe's side, as a colleague; the others on the customer's. Bots have no mail address,
// which is how the inbox tells people apart, so an admin says which are Adobe's.

/** A bot's name as the inbox shows it: an admin's, else the platform's. */
const botName = (b) => b.displayName || b.name || b.handle || b.id;
/** A bot's picture: an admin's, else the platform's (Slack, Discord), else an empty square. */
const botIco = (b) => {
  const url = b.displayAvatar || b.avatar || '';
  return /^(https:\/\/|\/)/.test(url) ? `<img class="ico" src="${esc(url)}" alt="">` : '<span class="ico none"></span>';
};
const oursTag = (b) => (b.ours ? '<span class="tag ours" title="Adobe\'s: on Adobe\'s side in the inbox">Adobe</span>' : '');
const botPosts = (b) => (b.messages ? `${b.messages} ${b.messages === 1 ? 'message' : 'messages'}` : 'mentioned only');

function drawBots(f) {
  const match = (b) => !f || `${b.displayName || ''} ${b.name || ''} ${b.handle || ''} ${b.id} ${platform(b)} ${b.channel || ''}`.toLowerCase().includes(f);
  const shown = state.bots.filter((b) => match(b) && (!state.onlyOurs || b.ours));
  const ours = state.bots.filter((b) => b.ours).length;
  const rows = shown.map((b) => `
      <div class="row${state.sel === b.key ? ' on' : ''}" data-sel="${esc(b.key)}" title="${esc(botName(b))} (${esc(platform(b))})">
        ${botIco(b)}<span class="name">${esc(botName(b))} <span class="sub">${esc(platform(b))}</span></span>
        ${oursTag(b)}<span class="sub">${esc(botPosts(b))}</span></div>`).join('');
  $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter bots" value="${esc(state.filter)}"></label>
    <label class="only"><input type="checkbox" id="onlyOurs"${state.onlyOurs ? ' checked' : ''}> ${ours === 1 ? 'Only the one that is Adobe\'s' : `Only the ${ours} that are Adobe's`}</label>
    ${rows || `<div class="empty">${state.bots.length ? 'Nothing matches.' : 'No bot has posted or been mentioned yet.'}</div>`}
    <p class="hint">The bots that posted in a thread, or were mentioned, latest first. Adobe's show on Adobe's side in the inbox, as your colleagues do.</p>`;
  $('onlyOurs').onchange = (e) => {
    state.onlyOurs = e.target.checked;
    renderList();
  };
}

function showBot(key) {
  const b = state.bots.find((x) => x.key === key);
  if (!b) { $('detail').innerHTML = `<div class="empty">${backButton()} No such bot.</div>`; return; }
  note = { kind: '', text: '' };
  state.view = { target: 'bot', value: key, bot: b, recent: null };
  const v = state.view;
  // Its latest messages (GET /api/admin/bot), each a link to its thread in the inbox: what the
  // bot says tells whose it is.
  const recentCard = () => {
    if (!b.messages) return '';
    const items = v.recent === null ? '<div class="empty pad">Loading…</div>'
      : v.recent.error ? `<div class="empty pad">${esc(v.recent.error)}</div>`
        : v.recent.map((m) => {
          const ch = m.channel && (b.source === 'teams' ? [m.group, m.channel].filter(Boolean).join(' › ') : `#${m.channel}`);
          return `<li><div class="said">${esc(m.preview) || '<i>No text</i>'}</div>
            <div class="sub"><time datetime="${esc(m.at)}">${esc(new Date(m.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</time>${ch ? ` · ${esc(ch)}` : ''}${m.org ? ` · ${esc(orgLabel(m.org))}` : ''} · <a href="/inbox?team=${encodeURIComponent(m.team)}&t=${encodeURIComponent(m.thread)}">Open the thread</a>${m.permalink ? ` · <a href="${esc(m.permalink)}" target="_blank" rel="noopener">on ${esc(platform(b))}</a>` : ''}</div></li>`;
        }).join('');
    return `<div class="card"><h2>Latest messages</h2>${v.recent && !v.recent.error && !v.recent.length ? '<div class="empty pad">Its messages were deleted.</div>' : `<ul class="recent">${items}</ul>`}</div>`;
  };
  let saves = 0;
  const draw = () => {
    const channel = b.channel && (b.source === 'teams' ? [b.group, b.channel].filter(Boolean).join(' › ') : `#${b.channel}`);
    const where = [b.latest ? `latest ${ago(b.latest)}` : '', channel ? `in ${channel}` : '', b.org ? `(${orgLabel(b.org)})` : ''].filter(Boolean).join(' ');
    $('detail').innerHTML = `
      <div class="title">${backButton()}<span id="bIco">${botIco(b)}</span><h1 class="fill" id="bTitle">${esc(botName(b))}</h1><span class="sub">${esc(platform(b))} bot</span></div>
      <div class="status" id="status"></div>
      <div class="card"><div class="field">
        <label>Whose</label><span class="seg" id="bOurs">
          <button type="button" data-ours="1" aria-pressed="${b.ours === true}"${off(`bot:${key}`)}>Adobe's</button>
          <button type="button" data-ours="0" aria-pressed="${b.ours !== true}"${off(`bot:${key}`)}>Not Adobe's</button></span>
        <label>Posted</label><span>${b.messages ? `${esc(botPosts(b))} in ${b.threads} ${b.threads === 1 ? 'thread' : 'threads'}${where ? `, ${esc(where)}` : ''}` : 'Nothing yet: it was mentioned'}</span>
        ${b.handle && b.handle !== b.name ? `<label>Mentioned as</label><span>@${esc(b.handle)}</span>` : ''}
        <label>Id</label><span class="mono">${esc(b.id)}</span>
        ${b.oursBy ? `<label>Said by</label><span class="sub">${esc(b.oursBy)}, ${esc(ago(b.oursAt))}</span>` : ''}
      </div><p class="hint">Bots have no mail address, which is how the inbox tells Adobe people from customers, so an admin says which bots are Adobe's. An Adobe bot's messages show on Adobe's side, as your colleagues' do, the ones it wrote before too${b.staff && !b.ours ? '; this one is there already, by its Discord role' : ''}. They stay a bot's: they are not an answer to the customer, and the thread agents read them as they read every bot's.</p></div>
      <div class="card"><h2>How the inbox shows it</h2><div class="field">
        <label>On ${esc(platform(b))}</label><span class="inline">${botIco({ avatar: b.avatar })}<span>${esc(b.name || b.handle || b.id)}</span>${b.avatar ? '' : '<span class="sub">no picture</span>'}</span>
        <label for="bName">Name</label><span class="inline"><input id="bName" class="fill" maxlength="80" value="${esc(b.displayName || '')}"></span>
        <label for="bAvatar">Picture</label><span class="inline"><input id="bAvatar" class="mono fill" maxlength="500" value="${esc(b.displayAvatar || '')}"></span>
      </div><p class="hint">The inbox shows this name and picture instead of the ones from ${esc(platform(b))}, on the messages it wrote before too; left empty, the ones from ${esc(platform(b))}.${b.source === 'teams' ? ' Teams gives a bot\'s messages no picture, so its picture there is its app\'s icon, and names it by its registration, not by its app.' : ''} The picture is the https URL of an image.</p></div>
      ${recentCard()}`;
    showStatus();
    // Each save sends both fields as the page shows them; only the answer to the last one is
    // shown, so an earlier answer does not take back what was changed after it.
    const look = async () => {
      const now = { name: $('bName').value.trim() || null, avatar: $('bAvatar').value.trim() || null };
      if (now.name === (b.displayName || null) && now.avatar === (b.displayAvatar || null)) return;
      const mine = ++saves;
      const res = await call('/api/admin/bots', 'PUT', { key, ...now });
      if (mine !== saves) return;
      if (!res.ok) { failed('Save', res); return; }
      Object.assign(b, res.body.bot);
      status('ok', 'Saved.');
      renderList();
      if (v !== state.view) return;
      $('bTitle').textContent = botName(b);
      $('bIco').innerHTML = botIco(b);
    };
    $('bName').onchange = look;
    $('bAvatar').onchange = look;
    for (const btn of $('bOurs').querySelectorAll('[data-ours]')) {
      btn.onclick = () => hold(btn, `bot:${key}`, async () => {
        const ours = btn.dataset.ours === '1';
        if (ours === (b.ours === true)) return;
        const res = await call('/api/admin/bots', 'PUT', { key, ours });
        if (!res.ok) { failed('Save', res); return; }
        Object.assign(b, res.body.bot);
        status('ok', ours ? `${botName(b)} is Adobe's now.` : `${botName(b)} is not Adobe's now.`);
        renderList();
        if (v === state.view) draw();
      });
    }
  };
  draw();
  if (!b.messages) return;
  call(`/api/admin/bot?key=${encodeURIComponent(key)}`).then((r) => {
    v.recent = r.ok ? r.body.recent : { error: r.body.error || `Could not load its messages (${r.status}).` };
    if (v === state.view) draw();
  });
}

// ---- start ------------------------------------------------------------------------------

(async () => {
  // Another team, org or request fades in (ui/app.js).
  Swap.watch($('detail'), () => `${state.tab}|${state.sel ?? ''}`);
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
    go: (id, url) => (['teams', 'orgs', 'bots', 'requests'].includes(id) ? openUrl(url) : location.assign(url)),
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
  // Back or Forward that the browser has already animated (the iPhone's edge swipe) does not slide again.
  window.addEventListener('popstate', (e) => openUrl(location.href, { push: false, instant: Boolean(e.hasUAVisualTransition) }));
  // A link to a team lands on it.
  openUrl(location.href, { push: false, instant: true });
})();
