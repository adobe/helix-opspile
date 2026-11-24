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
 * remove members and promote or demote them (and add the ones the page suggests, see "suggested
 * members"), and ask the admin team for channels (a request:
 * they pick one in the same search the admin team adds channels with). The admin team confirms
 * or declines the requests under Requests; the rest is for the admin team. Customers ask too,
 * from the customer portal, for a channel: the admin team opens one under Requests, and a team's
 * managers on their team's page, when the team follows a technology the customer picked.
 *
 * Teams: create, rename and delete teams; add members (found by name or email) and remove
 * them; the rules that file channels under the team (a channel-name prefix like `aem-`, a
 * Teams team name, a Slack Connect team id); and manual assignments of single channels, one of
 * which moves a channel to the team picked under its name (`moveMenu`). Orgs: display name, icon and
 * type (customer, partner, vendor), and manual assignments. The bots, under Requests: which of
 * the bots in the threads are Adobe's, and so on Adobe's side in the inbox, which are external,
 * and which only post alerts (src/ourbots.js); one nobody said whose it is waits there as a
 * request. Changes apply at once, without
 * asking (the status line names the channels a rule change moved), and go to the API one
 * after the other, so many can be made in a row (see `serial`). Text fields save when they
 * change. A change updates the open page in place (see "view state"); nothing reloads.
 *
 * A team's or a customer's page has its agent too, a section each (see "sections"): its thread
 * agents, its tools and MCP servers, a team's extraction rules, and the knowledge base with its
 * agent instructions, which ui/agent.js shows. Every member of an ops team sees those, of every
 * team and of the customers their teams own (src/kbaccess.js says who changes them); a team's
 * own section is its managers' and the admin team's, a customer's the admin team's.
 */
const state = {
  me: null, tab: 'teams', listError: '', teams: [], unassigned: null, orgs: [], types: [], sel: null, filter: '', view: null,
  // The knowledge bases you see (GET /api/kb), and which section of the team or the org picked
  // is open (`own`, or one of its agent's, SECTIONS), with the file open in its knowledge base.
  bases: [], section: null, path: null,
  requests: [], openRequests: 0, names: {}, noIcon: false,
  // The people thread agents asked to be added to a team (src/memberrequests.js), under Requests.
  memberRequests: [],
  // The bots the inbox knows (GET /api/admin/bots), under Requests.
  bots: [],
  // The host tenant's admin accounts, and whose each is (GET /api/admin/accounts), under Requests.
  accounts: [],
  // The customers waiting in the customer portal, and whether it is connected to this inbox.
  portal: [], portalBound: false,
  // The team wizard's groups of the admin team's channels (GET /api/admin/team-groups): the
  // ones offered, the dismissed ones, and how much of the admin team's channels it saw.
  groups: [], dismissedGroups: [], groupCoverage: null,
  // The pairs of orgs that may be one (GET /api/admin/org-duplicates), whether the list shows the
  // less likely ones too, and the merges asked for (the admin team's, under Requests).
  dups: null, dupsMore: false, orgMerges: [],
  // The channels no rule files under an org (GET /api/admin/orgs `unassigned`): how many.
  orgsUnassigned: null,
  // The customers you follow yourself (GET /api/follows `by.org`): in your personal view.
  myOrgs: new Set(),
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
/** The customer a follow rule follows (field `org`, src/rules.js `followedOrg`), or null. */
const followedOrg = (r) => (r.target === 'follow' && r.field === 'org'
  ? (/^\^([a-z0-9_][a-z0-9-]*)\$$/.exec(r.pattern || '') || [])[1] || null : null);

/** How many channels, in words: "1 channel", "48 channels". */
const channelCount = (n) => `${n} ${n === 1 ? 'channel' : 'channels'}`;

const orgLabel = (slug) => {
  const o = state.orgs.find((x) => x.slug === slug);
  return o && o.name ? o.name : slug;
};
// The admin team holds the channels no other team has (yet); adding a team to one of those
// moves it, adding a team to any other channel shares it (src/shares.js).
const isHolding = (slug) => !slug || slug === UNASSIGNED || slug === 'admin';
const teamLabel = (slug) => (slug === UNASSIGNED ? 'Unassigned' : (state.teams.find((t) => t.slug === slug)?.name || state.names[slug]
  || state.bases.find((b) => b.kind === 'team' && b.slug === slug)?.name || slug));

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
  teams: 'team', orgs: 'org', requests: 'request',
};
const PICK = {
  teams: 'a team', orgs: 'a customer', requests: 'a request',
};
/** The tabs whose rows have an agent: a team's, a customer's. */
const AGENTED = ['teams', 'orgs'];
/** A suggested team of the team wizard, picked in Teams (see "the team wizard"). */
const isGroup = (sel) => String(sel ?? '').startsWith(GROUP);
/** Two orgs that may be one, picked in Customers (see "duplicate customers"). */
const isPair = (sel) => String(sel ?? '').startsWith(PAIR);
/** Whether `sel` on `tab` is a team or a customer, whose page has an agent's sections. */
const agented = (tab, sel) => AGENTED.includes(tab) && !isGroup(sel) && !isPair(sel);

/**
 * The address of what is picked (`sel` on `tab`), at a section of its page (`view`, none for its
 * own) and the file open there (`path`).
 */
function address({
  tab = state.tab, sel = state.sel, section = state.section, path = state.path,
} = {}) {
  const q = new URLSearchParams({ tab });
  if (sel) q.set(PARAM[tab], sel);
  if (sel && agented(tab, sel) && section && section !== 'own') {
    q.set('view', section);
    if (section === 'kb' && path) q.set('path', path);
  }
  return `/inbox/admin?${q}`;
}
function toUrl(mode = 'replace') {
  const url = address();
  if (url !== `${location.pathname}${location.search}`) history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  // Phones show the list or what is picked in it (see the styles).
  document.body.classList.toggle('picked', Boolean(state.sel));
}

/**
 * What an address asks for: a tab, what is picked on it, a section of its page and a file.
 * Links made before the agents were in these pages (/inbox/kb, which the Worker sends here)
 * name a knowledge base instead (`repo`), or the customer and the team on screen in the inbox
 * (`org`, `team`): the customer's, where it has a knowledge base, else the team's.
 */
function wanted(url) {
  const q = new URL(url, location.origin).searchParams;
  let tab = q.get('tab');
  let sel = null;
  if (!tab) {
    const named = state.bases.find((b) => b.repo === q.get('repo'))
      || (q.get('org') && state.bases.find((b) => b.kind === 'org' && b.slug === q.get('org')));
    if (named) {
      tab = named.kind === 'org' ? 'orgs' : 'teams';
      sel = named.slug;
    } else if (q.get('org') && !q.get('team') && state.orgs.some((o) => o.slug === q.get('org'))) tab = 'orgs';
  }
  if (!['orgs', 'requests'].includes(tab) || (tab !== 'orgs' && !state.me.admin)) tab = 'teams';
  sel = sel || q.get(PARAM[tab]);
  const view = q.get('view');
  const legacy = Boolean(q.get('repo') || q.get('path'));
  let section = SECTIONS.includes(view) ? view : null;
  if (view === 'file' || (!section && legacy)) section = 'kb';
  // Back from an MCP server's sign-in (src/mcpadmin.js): said once, on the servers' section.
  let flash = null;
  if (q.get('mcp_error')) flash = { error: q.get('mcp_error') };
  else if (q.get('mcp_global_connected')) flash = { global: q.get('mcp_global_connected') };
  else if (q.get('mcp_connected')) flash = { connected: q.get('mcp_connected') };
  return {
    tab, sel, section, path: q.get('path'), channel: q.get('channel'), flash,
  };
}

/**
 * Teams, Customers and Requests are pages of the header (ui/header.js), each opening as it
 * was left: one of them, from its address, without loading the page again. Going to another is a
 * new history entry (`push`), so Back returns to the one before. What the agent has open is
 * saved first; where it cannot be and you stay, so does the address.
 */
async function openUrl(url, { push = true, instant = false } = {}) {
  if (!(await Agent.leave())) {
    if (!push) toUrl('push');
    return;
  }
  const {
    tab, sel, section, path, channel, flash,
  } = wanted(url);
  if (push) history.pushState(null, '', url);
  // Another section of the page open, or another file in its knowledge base.
  if (sel && tab === state.tab && String(sel) === String(state.sel) && agented(tab, sel)) {
    openSection(section, { path, channel, flash });
    return;
  }
  const open = () => {
    switchTab(tab);
    if (sel) {
      select(sel, {
        section, path, channel, flash,
      });
    }
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
  // Team managers see their teams only, and no orgs; the other members of a team only the
  // knowledge bases (their agents), as everyone does.
  const none = Promise.resolve({ ok: true, body: {} });
  // Everyone on a team sees every customer, to follow it, and the channels of it.
  const onTeam = state.me.admin || (state.me.teams || []).length > 0;
  const [teams, orgs, requests, bots, accounts, bases, follows] = await Promise.all([
    state.me.admin || state.me.manages?.length ? call('/api/admin/teams') : none,
    onTeam ? call('/api/admin/orgs') : none,
    state.me.admin ? call('/api/admin/requests') : none,
    state.me.admin ? call('/api/admin/bots') : none,
    state.me.admin ? call('/api/admin/accounts') : none,
    call('/api/kb'),
    call('/api/follows')]);
  if (!teams.ok) { $('list').innerHTML = `<div class="empty">${esc(teams.body.error || 'Could not load.')}</div>`; return false; }
  // In place: the agent (ui/agent.js) counts on the same list.
  state.bases.splice(0, state.bases.length, ...(bases.ok ? bases.body.bases : []));
  state.teams = teams.body.teams || [];
  state.names = teams.body.names || {};
  state.requests = requests.body.requests || [];
  state.memberRequests = requests.body.memberRequests || [];
  state.portal = requests.body.portal || [];
  state.conflicts = requests.body.conflicts || [];
  state.ruleConflicts = requests.body.ruleConflicts || [];
  state.orgMerges = requests.body.orgMerges || [];
  state.portalBound = Boolean(requests.body.portalBound);
  state.openRequests = requests.body.open ?? teams.body.requests ?? 0;
  renderCount();
  state.unassigned = teams.body.unassigned;
  state.orgs = orgs.body.orgs || [];
  state.orgsUnassigned = state.me.admin ? orgs.body.unassigned || null : null;
  state.myOrgs = new Set((follows.ok && follows.body.by?.org) || []);
  state.types = orgs.body.types || ['customer', 'partner', 'vendor'];
  state.bots = bots.body.bots || [];
  state.accounts = accounts.body.accounts || [];
  if (state.me.admin) loadGroups();
  loadDups();
  return true;
}

/**
 * The team wizard's groups, after the rest: they take a while to find, and the list shows them
 * once they are there.
 */
async function loadGroups() {
  const r = await call('/api/admin/team-groups');
  if (!r.ok) return;
  state.groups = r.body.groups || [];
  state.dismissedGroups = r.body.dismissed || [];
  state.groupCoverage = r.body.coverage || null;
  if (state.tab === 'teams') {
    renderList();
    // A link to a group, opened before the groups were there.
    if (String(state.sel || '').startsWith(GROUP) && state.view?.target === 'group-pending') showGroup(state.sel.slice(GROUP.length));
  }
}

function wireFilter() {
  $('filter').oninput = (e) => {
    state.filter = e.target.value;
    renderList();
  };
  for (const el of $('list').querySelectorAll('[data-sel]')) el.onclick = () => pickRow(el.dataset.sel);
}

/** A row of the list picked: what the agent has open is saved first, or you stay. */
async function pickRow(sel) {
  if (await Agent.leave()) select(sel);
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

/** An org's row in the Customers list: its icon, name, type and channels, and whether you follow it. */
const orgRow = (o) => `
      <div class="row${state.sel === o.slug ? ' on' : ''}" data-sel="${esc(o.slug)}">
        ${ico(o.icon, o.domain)}<span class="name">${esc(o.name || o.slug)}${o.name ? ` <span class="sub">${esc(o.slug)}</span>` : ''}</span>
        ${o.type !== 'customer' ? `<span class="tag ${o.type}">${esc(o.type)}</span>` : ''}
        ${state.me.admin && state.myOrgs.has(o.slug) ? '<span class="tag" title="You follow it: its conversations are in your personal view">following</span>' : ''}
        <span class="sub">${channelCount(o.channels)}</span></div>`;

/** A knowledge base's row (a team's or a customer's you do not manage): its agent, its entries. */
function baseRow(b) {
  const agents = b.agents ? `agent in ${channelCount(b.agents)}` : '';
  // A customer by the name the admin team gave it.
  const name = (b.kind === 'org' && state.orgs.find((o) => o.slug === b.slug)?.name) || b.name;
  return `<div class="row two${state.sel === b.slug ? ' on' : ''}" data-sel="${esc(b.slug)}" title="${esc(name)} (${esc(b.slug)})">
        <span class="name">${esc(name)}</span>
        <span class="sub">${esc([agents, Agent.activity(b), name !== b.slug && b.slug].filter(Boolean).join(' · '))}</span></div>`;
}

function drawList() {
  const f = state.filter.toLowerCase();
  const matches = (b) => !f || `${b.name} ${b.slug}`.toLowerCase().includes(f);
  if (state.tab === 'teams') {
    // The teams you do not manage: their agents, read-only.
    const managed = new Set(state.teams.map((t) => t.slug));
    const others = state.me.admin ? [] : state.bases.filter((b) => b.kind === 'team' && !managed.has(b.slug) && matches(b));
    const rows = state.teams.filter((t) => !f || `${t.name} ${t.slug}`.toLowerCase().includes(f)).map((t) => `
      <div class="row two${state.sel === t.slug ? ' on' : ''}" data-sel="${esc(t.slug)}" title="${esc(t.name)} (${esc(t.slug)})">
        <span class="name">${esc(t.name)}</span>
        <span class="sub">${t.self_managed ? '<span title="Every member is a team manager">Self-managed</span> · ' : ''}${t.members} ${t.members === 1 ? 'person' : 'people'} · ${channelCount(t.channels)}${t.shared ? ` + ${t.shared} shared` : ''} · ${esc(t.slug)}</span></div>`).join('');
    const un = state.unassigned && state.unassigned.channels ? `<div class="row two${state.sel === UNASSIGNED ? ' on' : ''}" data-sel="${UNASSIGNED}">
        <span class="name"><i>Unassigned</i></span><span class="sub">${channelCount(state.unassigned.channels)}</span></div>` : '';
    const yours = state.me.admin || state.me.manages?.length
      ? `<h2>${state.me.admin ? 'Ops teams' : 'Teams you manage'}</h2>${rows || '<div class="empty">No teams.</div>'}${un}` : '';
    const theirs = others.length || !yours ? `<h2>${yours ? 'Other teams' : 'Ops teams'}</h2>${others.map(baseRow).join('') || '<div class="empty">No teams.</div>'}` : '';
    const groups = state.me.admin ? groupList(f) : '';
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter teams" value="${esc(state.filter)}"></label>
      ${yours}${groups}${theirs}
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
  } else if (state.tab === 'requests') {
    const match = (r) => !f || `${plainName(r.channel)} ${r.channel.channelId} ${teamLabel(r.team)} ${r.requestedBy.name || ''} ${r.requestedBy.email}`
      .toLowerCase().includes(f);
    const row = (r) => `<div class="row${String(state.sel) === String(r.id) ? ' on' : ''}" data-sel="${r.id}">
        <span class="name">${channelName(r.channel)} <span class="sub">${r.move && r.channel.team ? `${esc(teamLabel(r.channel.team))} ` : ''}→ ${esc(teamLabel(r.team))}</span></span>
        ${r.status === 'open' ? '' : statusTag(r)}<span class="sub">${esc(ago(r.status === 'open' ? r.requestedAt : r.decidedAt))}</span></div>`;
    const open = state.requests.filter((r) => r.status === 'open' && match(r));
    const decided = state.requests.filter((r) => r.status !== 'open' && match(r));
    // The people asked to be added to a team (src/memberrequests.js).
    const people = state.memberRequests.filter((r) => !f || `${memberName(r)} ${r.person.email} ${teamLabel(r.team)} ${r.requestedBy.name || ''} ${r.requestedBy.email}`.toLowerCase().includes(f));
    const peopleOpen = people.filter((r) => r.status === 'open');
    const peopleDone = people.filter((r) => r.status !== 'open');
    // The customers in the portal: each asks for a channel of its own.
    const asks = state.portal.filter((r) => !f || `${r.company || ''} ${r.domain} ${r.requestedBy.name || ''} ${r.requestedBy.email || ''}`.toLowerCase().includes(f));
    const waiting = asks.filter((r) => r.status === 'open');
    const answered = asks.filter((r) => r.status !== 'open');
    // The conflicts between the teams' technologies (src/techconflicts.js).
    const clash = (state.conflicts || []).filter((c) => !f || conflictTitle(c).toLowerCase().includes(f));
    const unsettled = clash.filter((c) => !c.kept);
    // The conflicts between team rules (src/ruleconflicts.js): the ones a change of a pattern
    // settles, and the others (rules that read different things of a channel), kept or by hand.
    const ruleClash = (state.ruleConflicts || []).filter((c) => !f || ruleConflictTitle(c).toLowerCase().includes(f));
    const ruleOpen = ruleClash.filter((c) => !c.kept && c.section === 'rules');
    const ruleOther = ruleClash.filter((c) => !c.kept && c.section !== 'rules');
    const kept = [...clash.filter((c) => c.kept).map(conflictRow), ...ruleClash.filter((c) => c.kept).map(ruleConflictRow)];
    // The merges of customers asked for (src/orgmerge.js).
    const merges = (state.orgMerges || []).filter((r) => !f || `${r.from} ${r.into} ${r.requestedBy.name || ''} ${r.requestedBy.email}`.toLowerCase().includes(f));
    const mergesOpen = merges.filter((r) => r.status === 'open');
    const mergesDone = merges.filter((r) => r.status !== 'open');
    // The bots (src/ourbots.js): those nobody said whose they are wait for it, the others follow.
    const bots = state.bots.filter((b) => botMatch(b, f));
    const review = bots.filter(unreviewed);
    // The host tenant's admin accounts (src/accountlinks.js): those nobody said whose they are
    // first, the others with the bots.
    const accounts = state.accounts.filter((a) => accountMatch(a, f));
    const unlinked = accounts.filter((a) => !a.person);
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter requests" value="${esc(state.filter)}"></label>
      ${waiting.length ? `<h2>Customers waiting in the portal</h2>${waiting.map(portalRow).join('')}` : ''}
      <h2>Waiting for a decision</h2>${open.map(row).join('') || `<div class="empty">${f ? 'Nothing matches.' : 'No request is waiting.'}</div>`}
      ${peopleOpen.length ? `<h2>People to add to teams</h2>${peopleOpen.map(memberRow).join('')}` : ''}
      ${review.length ? `<h2>Bots to review</h2>${review.map(botRow).join('')}` : ''}
      ${unlinked.length ? `<h2>Admin accounts to link</h2>${unlinked.map(accountRow).join('')}` : ''}
      ${unsettled.length ? `<h2>Conflicts between technologies</h2>${unsettled.map(conflictRow).join('')}` : ''}
      ${ruleOpen.length ? `<h2>Conflicts between team rules</h2>${ruleOpen.map(ruleConflictRow).join('')}` : ''}
      ${ruleOther.length ? `<h2>Other rule conflicts</h2>${ruleOther.map(ruleConflictRow).join('')}` : ''}
      ${mergesOpen.length ? `<h2>Customers to merge</h2>${mergesOpen.map(mergeRow).join('')}` : ''}
      ${decided.length || answered.length || kept.length || mergesDone.length || peopleDone.length ? `<h2>Decided</h2>${answered.map(portalRow).join('')}${decided.map(row).join('')}${peopleDone.map(memberRow).join('')}${mergesDone.map(mergeRow).join('')}${kept.join('')}` : ''}
      ${bots.length > review.length ? `<h2>Bots</h2>${bots.filter((b) => !unreviewed(b)).map(botRow).join('')}` : ''}
      ${accounts.length > unlinked.length ? `<h2>Admin accounts</h2>${accounts.filter((a) => a.person).map(accountRow).join('')}` : ''}
      <p class="hint">Team managers ask for channels on their team's page, and thread agents for whoever asks them in a thread's sidebar. Confirming one assigns the channel to the team, as adding it on the team's page does; one that asks for a move moves it, also from another team. Thread agents also ask for people to be added to a team, for whoever asked them; the team's managers decide those too, on its page. A bot that posted waits here until you say whether it is Adobe's or external, and an admin account of the Teams tenant until you say whose it is.</p>`;
  } else if (!state.me.admin) {
    // The customers you follow, then those your teams own (their agents, which their managers
    // change), then every other one: to follow it, or ask for its channels.
    const orgMatch = (o) => !f || `${o.name || ''} ${o.slug}`.toLowerCase().includes(f);
    const followed = state.orgs.filter((o) => state.myOrgs.has(o.slug) && orgMatch(o));
    const kb = state.bases.filter((b) => b.kind === 'org' && matches(b) && !state.myOrgs.has(b.slug))
      .sort((x, y) => x.name.localeCompare(y.name));
    const ours = new Set(kb.map((b) => b.slug));
    const rest = state.orgs.filter((o) => orgMatch(o) && !ours.has(o.slug) && !state.myOrgs.has(o.slug));
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter customers" value="${esc(state.filter)}"></label>
      ${dupSection(f)}${followed.length ? `<h2>Customers you follow</h2>${followed.map(orgRow).join('')}` : ''}
      <h2>Customers of your teams</h2>${kb.map(baseRow).join('') || `<div class="empty">${f ? 'Nothing matches.' : 'No customer of your teams has a knowledge base yet.'}</div>`}
      <p class="hint">The customers with a channel filed under or shared with one of your teams, once their thread agents started a knowledge base.</p>
      ${rest.length ? `<h2>Every other customer</h2>${rest.map(orgRow).join('')}` : ''}`;
    wireDups();
  } else {
    const rows = state.orgs.filter((o) => (!f || `${o.name || ''} ${o.slug}`.toLowerCase().includes(f))
      && (!state.noIcon || iconless(o))).map(orgRow).join('');
    // The channels without an org, to be given one (see "unassigned channels").
    const un = state.orgsUnassigned && state.orgsUnassigned.channels && (!f || 'unassigned'.includes(f))
      ? `<div class="row${state.sel === UNASSIGNED ? ' on' : ''}" data-sel="${UNASSIGNED}"><span class="ico none"></span>
        <span class="name"><i>Unassigned</i></span><span class="sub">${channelCount(state.orgsUnassigned.channels)}</span></div>` : '';
    $('list').innerHTML = `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter orgs" value="${esc(state.filter)}"></label>
      ${dupSection(f)}${state.dups && state.dups.pairs.length ? '<h2>Every org</h2>' : ''}
      <label class="only"><input type="checkbox" id="noIcon"${state.noIcon ? ' checked' : ''}> Only the ${state.orgs.filter(iconless).length} without an icon</label>
      ${un}${rows || (un ? '' : '<div class="empty">Nothing matches.</div>')}
      <h2>New org</h2><form class="form" id="newOrg"><label class="fld grow"><span>Display name</span><input id="noName" required></label>
        <select id="noType">${state.types.map((t) => `<option>${t}</option>`).join('')}</select><button class="primary">Create</button></form>
      <p class="hint">Channels are filed under an org by the rules (<code>aem-&lt;slug&gt;</code>) or a manual assignment.</p>
      <div class="status err" id="listStatus">${esc(state.listError)}</div>`;
    wireDups();
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

/**
 * Picks `sel` on the open tab; a team or a customer at a `section` of its page (its own, else
 * the first it has), the knowledge base at `path`, the thread agents at a `channel`, the
 * servers with what a sign-in said (`flash`).
 */
function select(sel, {
  section = null, path = null, channel = null, flash = null,
} = {}) {
  state.sel = sel;
  if (agented(state.tab, sel)) {
    const shown = sectionsOf(state.tab, sel);
    state.section = shown.includes(section) ? section : shown[0] || 'own';
    state.path = state.section === 'kb' ? path : null;
  }
  toUrl();
  renderList();
  if (state.tab === 'teams' && isGroup(sel)) showGroup(String(sel).slice(GROUP.length));
  else if (state.tab === 'orgs' && isPair(sel)) showPair(...String(sel).slice(PAIR.length).split(':'));
  else if (state.tab === 'requests' && String(sel).startsWith(MERGE_REQUEST)) showMergeRequest(String(sel).slice(MERGE_REQUEST.length));
  else if (agented(state.tab, sel)) showPicked({ channel, flash, fresh: true });
  else if (state.tab === 'requests' && String(sel).startsWith(MEMBER)) showMemberRequest(String(sel).slice(MEMBER.length));
  else if (state.tab === 'requests' && String(sel).startsWith(PORTAL)) showPortalRequest(String(sel).slice(PORTAL.length));
  else if (state.tab === 'requests' && String(sel).startsWith(CONFLICT)) showConflict(String(sel).slice(CONFLICT.length));
  else if (state.tab === 'requests' && String(sel).startsWith(RULE_CONFLICT)) showRuleConflict(String(sel).slice(RULE_CONFLICT.length));
  else if (state.tab === 'requests' && String(sel).startsWith(BOT)) showBot(String(sel).slice(BOT.length));
  else if (state.tab === 'requests' && String(sel).startsWith(ACCOUNT)) showAccount(String(sel).slice(ACCOUNT.length));
  else if (state.tab === 'requests') showRequest(sel);
}

/** Back to the list (phones), its filter as it was. */
function unselect() {
  state.sel = null;
  state.section = null;
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
  state.section = null;
  state.filter = '';
  toUrl();
  renderList();
  $('detail').innerHTML = `<div class="empty pick">Pick ${PICK[tab]}.</div>`;
}

// ---- sections ---------------------------------------------------------------------------
//
// A team's page and a customer's have a section of their own (the admin API's: a team's
// members, rules, channels and technologies; a customer's name, icon, type and channels) and
// their agent's, which ui/agent.js shows in the `#files` and `#editor` made for it here. The
// sections are tabs under the title, each a link to its address, with what the agent counts.

/** The agent's sections, as the address names them (history is the knowledge base's). */
const SECTIONS = ['agents', 'mcp', 'extraction', 'kb', 'history'];
const SECTION_LABEL = {
  agents: 'Thread agents', mcp: 'Tools and MCP servers', extraction: 'Extraction rules', kb: 'Knowledge base',
};
const SECTION_TITLE = {
  agents: 'Which of its channels have thread agents, and whether your inbox shows their thinking',
  mcp: 'Tools its agents get where they are turned on, and MCP servers they call from code mode',
  extraction: 'What labeling finds in the threads of its channels: facts and the tech stack',
  kb: 'Its knowledge base: the agent instructions, the files the agents keep, and their history',
};
const inKb = (section) => section === 'kb' || section === 'history';

/** The knowledge base of a team (`teams`) or a customer (`orgs`), where you see one. */
const baseOf = (tab, slug) => state.bases.find((b) => b.kind === (tab === 'orgs' ? 'org' : 'team') && b.slug === slug) || null;

/**
 * The sections of a team's or a customer's page that you see, the one it opens at first: its
 * own where it is yours (a team you manage, Unassigned, any for the admin team), then its
 * agent's where it has a knowledge base.
 */
function sectionsOf(tab, slug) {
  // A customer's own section is everyone's: who follows it, and its channels; the admin team
  // edits its name, icon and type there too.
  const own = tab === 'teams' ? state.teams.some((t) => t.slug === slug) || (slug === UNASSIGNED && state.me.admin)
    : Boolean(state.me.admin) || (slug !== UNASSIGNED && state.orgs.some((o) => o.slug === slug));
  const b = baseOf(tab, slug);
  return [
    ...(own ? ['own'] : []),
    ...(b ? ['agents', 'mcp', ...(b.kind === 'team' ? ['extraction'] : []), 'kb', 'history'] : []),
  ];
}

/** The tabs of the sections, the open one current, the agent's badges once they are read. */
function sectionTabs() {
  const b = baseOf(state.tab, state.sel);
  const tags = b ? Agent.tags(b.repo) : {};
  const type = state.orgs.find((o) => o.slug === state.sel)?.type || 'customer';
  const own = state.tab === 'teams' ? 'Team' : `${type[0].toUpperCase()}${type.slice(1)}`;
  const label = { own, ...SECTION_LABEL };
  const orgTitle = state.me.admin ? 'Its name, icon, type, channels and who follows it' : 'Its channels and who follows it';
  const title = { own: state.tab === 'teams' ? 'Its members, rules, channels and technologies' : orgTitle, ...SECTION_TITLE };
  const open = state.section === 'history' ? 'kb' : state.section;
  return sectionsOf(state.tab, state.sel).filter((x) => x !== 'history').map((x) => `<a href="${esc(address({ section: x, path: null }))}"
    data-section="${x}"${open === x ? ' aria-current="page"' : ''} title="${esc(title[x])}"><span>${esc(label[x])}</span>${tags[x] || ''}</a>`).join('');
}
/** The tabs under the title, where there is more than one. */
const sectionsNav = () => (sectionsOf(state.tab, state.sel).length > 1
  ? `<nav class="sections" id="sections" aria-label="Sections">${sectionTabs()}</nav>` : '');
/** The open tab in view, where the tabs scroll sideways (on a phone). */
function tabInView() {
  const nav = $('sections');
  const open = nav && nav.querySelector('[aria-current]');
  if (!open) return;
  const at = open.getBoundingClientRect().left - nav.getBoundingClientRect().left;
  nav.scrollLeft += at - (nav.clientWidth - open.offsetWidth) / 2;
}
/** The tabs again: another one is open, or the agent's counts changed. */
function drawSections() {
  if (!$('sections')) return;
  $('sections').innerHTML = sectionTabs();
  tabInView();
}

/** The title of an agent's section: the team's or the customer's name, which its own section edits. */
function agentTitle(b) {
  const team = state.tab === 'teams' && state.teams.find((t) => t.slug === state.sel);
  const org = state.tab === 'orgs' && state.orgs.find((o) => o.slug === state.sel);
  const name = (team && team.name) || (org && org.name) || b.name;
  return `<div class="title">${backButton()}${org ? ico(org.icon, org.domain) : ''}<h1 class="fill">${esc(name)}</h1>
    <span class="sub mono">${esc(state.sel)}</span></div>`;
}

/**
 * What is picked, at its section (`state.section`): its own, or its agent's, which then shows
 * the thread agents at a `channel`, or the servers with what a sign-in said (`flash`). `fresh`
 * reads the agent again (another team or customer was picked, or another section).
 */
function showPicked({ channel = null, flash = null, fresh = false } = {}) {
  const { tab, sel, section } = state;
  const b = baseOf(tab, sel);
  if (!sectionsOf(tab, sel).length) {
    // Neither yours to manage nor with a knowledge base you see.
    loadingPage();
    state.view = null;
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(tab === 'teams' ? teamLabel(sel) : orgLabel(sel))}</h1></div>
      <div class="empty">${tab === 'teams' ? 'This team has no knowledge base yet.' : 'None of your teams works with this customer, or its agents have not started a knowledge base yet.'}</div>`;
    return;
  }
  if (section === 'own') {
    if (tab === 'teams') showTeam(sel);
    else showOrg(sel);
    // The agent's badges, on its tabs.
    if (b) Agent.load(b.repo, { fresh });
    return;
  }
  loadingPage();
  state.view = { target: 'agent', value: sel };
  const kb = inKb(section);
  $('detail').innerHTML = `${agentTitle(b)}${sectionsNav()}
    <div class="agent${kb ? ' kb' : ''}" id="agent">${kb ? '<section id="files" aria-label="Files"></section>' : ''}<section id="editor"></section></div>`;
  tabInView();
  Agent.show(b.repo, {
    view: section === 'kb' ? 'file' : section, path: state.path, channel, flash, fresh, nav: 'replace',
  });
}

/**
 * Another section of the page open (its address, Back or Forward): the knowledge base's files
 * stay while another of them, or its history, opens.
 */
function openSection(section, { path = null, channel = null, flash = null } = {}) {
  const shown = sectionsOf(state.tab, state.sel);
  const next = shown.includes(section) ? section : shown[0] || 'own';
  const was = state.section;
  state.section = next;
  state.path = next === 'kb' ? path : null;
  toUrl();
  if (inKb(next) && inKb(was) && $('files')) {
    drawSections();
    Agent.show(baseOf(state.tab, state.sel).repo, { view: next === 'kb' ? 'file' : 'history', path, nav: 'replace' });
    return;
  }
  showPicked({ channel, flash, fresh: true });
}

// ---- view state ---------------------------------------------------------------------------
//
// The open team or org is kept in `state.view` (what the API said, then every change the
// page made). A change updates it and redraws only the part it touches (a table, the list
// on the left), so scroll position and focus stay where they are.

/** Adds `n` channels and `threads` threads to a team's or an org's counts in the list. */
function count(kind, slug, n, threads) {
  if (slug === UNASSIGNED) {
    const un = kind === 'team' ? state.unassigned : state.orgsUnassigned;
    if (un) {
      un.channels = Math.max(0, un.channels + n);
      un.threads = Math.max(0, un.threads + threads);
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
function assignHere(c, value = state.view.value, { move = false, target = state.view.target } = {}) {
  const v = state.view;
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
    if (move && target === 'team' && v.target === 'team' && value !== v.value) {
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
    // A customer's page moved one of its channels to a team: filed there by hand, it stays here.
    if (target === 'team' && v.target === 'org') {
      for (const row of v.channels.filter((x) => x.channelId === channelId && !x.left)) {
        row.team = value;
        row.sharedWith = (row.sharedWith || []).filter((t) => t !== value);
        row.manual = { ...row.manual, team: res.rule ? { id: res.rule.id, value } : row.manual?.team };
      }
    }
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
  // A customer's page has a table of its own (`renderOrgChannels`).
  if (state.view.target === 'org' && $('orgChannels')) {
    renderOrgChannels();
    return;
  }
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
        ${(c.followedByRule || []).includes(state.view.value) ? '<span class="sub" title="A follow rule of this team shares it: change the rule to take it out">by a follow rule</span>'
    : `${state.me.admin ? `<button class="link" data-unshare="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unshare:${state.view.value}:${c.channelId}`)} title="Take it out of this team's inbox; it stays filed under ${esc(teamLabel(c.team))}">Remove</button>` : ''}`}`
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
  const el = openPop(button);
  if (!el) return;
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
    if (v === state.view) assignHere(c, t.slug, { move: true, target: 'team' });
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
  placePop(el, button);
  input.focus();
}

/**
 * The page's one popover of choices under a button (a channel's teams, a channel's orgs), made
 * the first time: null when the click is the one that closed it, on the same button.
 */
function openPop(button) {
  // The click that closed it, on its own name: closed it stays.
  if (movePop.button === button && Date.now() - movePop.shut < 300) return null;
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
  return el;
}

/** Shows the popover under `button`, or above it when there is no room below; in the window. */
function placePop(el, button) {
  const r = button.getBoundingClientRect();
  el.classList.remove('up');
  el.showPopover();
  const { width, height } = el.getBoundingClientRect();
  const gap = 4;
  const up = r.bottom + gap + height > innerHeight && r.top - gap - height > 0;
  el.classList.toggle('up', up);
  el.style.left = `${Math.max(gap, Math.min(r.left, innerWidth - width - gap))}px`;
  el.style.top = `${up ? r.top - gap - height : Math.min(r.bottom + gap, Math.max(gap, innerHeight - height - gap))}px`;
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
      if (v === state.view) { renderMembers(); memberChanged(m.email, false, m.name); }
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
      // Its open requests are answered with it (src/admin.js).
      for (const x of v.memberRequests || []) {
        if (x.status === 'open' && x.person.email === person.email) {
          updateMemberRequest({
            ...x, status: 'confirmed', outcome: 'member', decidedBy: { email: state.me.email, name: state.me.name }, decidedAt: new Date().toISOString(),
          });
        }
      }
      if (v === state.view) { renderMembers(); memberChanged(person.email, true); }
      if (v === state.view && $('memberRequestsTable')) renderMemberRequests();
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

// ---- suggested members --------------------------------------------------------------------

/**
 * Suggested members (src/membersuggest.js): the Adobe people who work the team's threads, are in
 * its channels or work its topics, and are not on it. Loaded after the page: they take a while.
 * Add makes one a member, as the field above does; Dismiss stops suggesting them, and so does
 * taking someone off the team, until Suggest again.
 */
async function loadMemberSuggestions(v) {
  const r = await call(`/api/admin/member-suggestions?team=${encodeURIComponent(v.team.slug)}`, 'GET', undefined, { parallel: true });
  if (v !== state.view || !$('memberSuggest')) return;
  if (!r.ok) { $('memberSuggest').innerHTML = `<div class="empty">${esc(r.body.error || 'Could not load the suggestions.')}</div>`; return; }
  v.memberSuggest = { ...r.body, showDismissed: false };
  renderMemberSuggestions();
}

/** Why someone is suggested, in words: what they did in the team's threads, channels and topics. */
function suggestedWhy(p) {
  return [
    p.posted ? `posted in ${p.posted} of its threads` : '',
    p.reacted ? `reacted in ${p.reacted} ${p.reacted === 1 ? 'thread' : 'threads'}` : '',
    p.channels ? `in ${p.channels} of its channels` : '',
    p.topics.length ? `works on ${p.topics.map((t) => t.label).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

function renderMemberSuggestions() {
  const v = state.view;
  const s = v.memberSuggest;
  const el = $('memberSuggest');
  if (!s || !el) return;
  const slug = v.team.slug;
  const key = (email) => `msug:${slug}:${email}`;
  const rows = s.suggestions.map((p) => `<tr>
      <td>${esc(p.name || p.email)}<div class="sub">${esc(p.email)}${p.teams.length ? ` · on ${esc(p.teams.map(teamLabel).join(', '))}` : ''}</div></td>
      <td class="sub">${esc(suggestedWhy(p))}${p.last ? ` · last ${esc(ago(p.last))}` : ''}</td>
      <td class="nw">${p.added ? '<span class="tag manual">added</span>' : `<button data-sadd="${esc(p.email)}"${off(key(p.email))}>Add</button>
        <button class="link" data-sdismiss="${esc(p.email)}"${off(key(p.email))} title="Not suggested for this team again">Dismiss</button>`}</td></tr>`).join('');
  const { coverage: c } = s;
  const covered = [
    'Threads of the last six months',
    `the members of ${c.membersListed} of its ${channelCount(c.channels)} are listed`,
    c.topicMap ? (c.topics.length ? `its topics: ${c.topics.join(', ')}` : 'no topic of the topic map is mostly this team\'s') : 'there is no topic map yet',
  ].join('; ');
  const dismissed = s.dismissed.length ? `<p class="hint">${s.showDismissed
    ? `Not suggested: ${s.dismissed.map((d) => `${esc(d.name || d.email)} <span class="sub">(${d.why === 'removed' ? 'taken off the team' : 'dismissed'}${d.by ? ` by ${esc(d.by)}` : ''} ${esc(ago(d.at))})</span> <button class="link" data-sagain="${esc(d.email)}"${off(key(d.email))}>Suggest again</button>`).join(' · ')}`
    : `<button class="link" id="sDismissed">${peopleCount(s.dismissed.length)} not suggested any more</button>`}</p>` : '';
  el.innerHTML = `${rows ? `<table><tr><th>Name</th><th>Why</th><th></th></tr>${rows}</table>`
    : '<div class="empty">Nobody: everyone who works this team\'s threads, is in its channels or works its topics is on it.</div>'}
    <p class="hint">${esc(covered)}.</p>${dismissed}`;
  for (const b of el.querySelectorAll('[data-sadd]')) {
    const p = s.suggestions.find((x) => x.email === b.dataset.sadd);
    b.onclick = () => hold(b, key(p.email), async () => {
      // Adding someone twice keeps one membership: safe to send again.
      const res = await call('/api/admin/members', 'POST', { team: slug, email: p.email, name: p.name || undefined }, { idempotent: true });
      if (!res.ok) { failed(`Add ${p.name || p.email}`, res); return; }
      const { person } = res.body;
      // Taken, it stays in its row, marked, so the rows do not jump under the pointer.
      p.added = true;
      if (!v.members.some((m) => m.id === person.id)) {
        v.members.push(person);
        v.members.sort((a, b2) => String(a.name || a.email).localeCompare(String(b2.name || b2.email)));
        const row = state.teams.find((t) => t.slug === slug);
        if (row) row.members += 1;
      }
      status('ok', `Added ${person.name || person.email}.`);
      if (v === state.view) { renderMembers(); renderMemberSuggestions(); }
      renderList();
    });
  }
  for (const b of el.querySelectorAll('[data-sdismiss]')) {
    const p = s.suggestions.find((x) => x.email === b.dataset.sdismiss);
    b.onclick = () => hold(b, key(p.email), async () => {
      const res = await call('/api/admin/member-suggestions/dismiss', 'POST', { team: slug, email: p.email });
      if (!res.ok) { failed(`Dismiss ${p.name || p.email}`, res); return; }
      s.suggestions = s.suggestions.filter((x) => x !== p);
      s.dismissed.unshift({
        email: p.email, name: p.name, why: 'dismissed', by: state.me.email || null, at: new Date().toISOString(),
      });
      status('ok', `${p.name || p.email} is not suggested for ${v.team.name} any more.`);
      if (v === state.view) renderMemberSuggestions();
    });
  }
  for (const b of el.querySelectorAll('[data-sagain]')) {
    const d = s.dismissed.find((x) => x.email === b.dataset.sagain);
    b.onclick = () => hold(b, key(d.email), async () => {
      const res = await call('/api/admin/member-suggestions/dismiss', 'DELETE', { team: slug, email: d.email });
      if (!res.ok) { failed(`Suggest ${d.name || d.email} again`, res); return; }
      status('ok', `${d.name || d.email} may be suggested again.`);
      // Where they come in the list, and whether, the server says.
      if (v === state.view) loadMemberSuggestions(v);
    });
  }
  if ($('sDismissed')) $('sDismissed').onclick = () => { s.showDismissed = true; renderMemberSuggestions(); };
}

/** Someone added or taken off the team elsewhere on the page: the suggestions follow. */
function memberChanged(email, joined, name = null) {
  const s = state.view.memberSuggest;
  if (!s || !email) return;
  const k = String(email).toLowerCase();
  if (joined) {
    for (const p of s.suggestions) if (p.email === k) p.added = true;
    s.dismissed = s.dismissed.filter((d) => d.email !== k);
  } else {
    s.suggestions = s.suggestions.filter((p) => p.email !== k);
    s.dismissed = [{
      email: k, name, why: 'removed', by: state.me.email || null, at: new Date().toISOString(),
    }, ...s.dismissed.filter((d) => d.email !== k)];
  }
  renderMemberSuggestions();
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
  const does = r.target === 'follow' ? '<span class="tag" title="Shares the channels it matches with the team; files none">follows</span>' : '<span class="tag manual" title="Files the channels it matches under the team">files</span>';
  // A customer the team follows (PUT /api/admin/org-follows): changed on the customer's page.
  const org = followedOrg(r);
  if (org) {
    return `<tr data-rule="${r.id}"><td>${does}</td><td>Customer</td><td><a href="${esc(address({ tab: 'orgs', sel: org, section: 'own' }))}">${esc(orgLabel(org))}</a></td>
    <td>${r.source ? `<span class="tag">${esc(r.source)} only</span>` : ''}</td>
    <td class="n">${r.priority}</td><td class="sub">${esc(r.note || '')}</td>
    <td><button class="link" data-del="${r.id}"${off(`rule:${r.id}`)}>Delete</button></td></tr>`;
  }
  return `<tr data-rule="${r.id}"><td>${does}</td><td>${esc(FIELD_LABEL[r.field] || r.field)}</td><td>${describe(r)}</td>
    <td>${r.source ? `<span class="tag">${esc(r.source)} only</span>` : ''}</td>
    <td class="n">${r.priority}</td><td class="sub">${esc(r.note || '')}</td>
    <td><button class="link" data-edit="${r.id}">Edit</button><button class="link" data-del="${r.id}"${off(`rule:${r.id}`)}>Delete</button></td></tr>`;
}

function ruleForm(r = {}) {
  const prefix = r.pattern ? prefixOf(r.pattern) : '';
  const mode = prefix !== null ? 'prefix' : 'regex';
  return `<form class="form" id="ruleForm" data-id="${r.id || ''}">
    <label class="fld"><span>Does</span><select id="rTarget" title="A follow rule shares the channels it matches with the team, filed wherever the other rules say"><option value="team">files channels</option><option value="follow"${r.target === 'follow' ? ' selected' : ''}>follows channels</option></select></label>
    <label class="fld"><span>Field</span><select id="rField">${Object.entries(FIELD_LABEL).map(([k, v]) => `<option value="${k}"${(r.field || 'name') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="fld"><span>Match</span><select id="rMode"><option value="prefix"${mode === 'prefix' ? ' selected' : ''}>starts with</option><option value="regex"${mode === 'regex' ? ' selected' : ''}>regular expression</option></select></label>
    <label class="fld grow"><span>Pattern</span><input id="rPattern" class="mono" value="${esc(mode === 'prefix' ? prefix : r.pattern)}" required></label>
    <label class="fld"><span>Platform</span><select id="rSource"><option value="">Every platform</option><option value="slack"${r.source === 'slack' ? ' selected' : ''}>Slack only</option><option value="teams"${r.source === 'teams' ? ' selected' : ''}>Teams only</option><option value="discord"${r.source === 'discord' ? ' selected' : ''}>Discord only</option><option value="portal"${r.source === 'portal' ? ' selected' : ''}>Portal only</option></select></label>
    <label class="fld"><span>Priority</span><input id="rPriority" type="number" min="0" max="10000" value="${r.priority ?? 100}" title="The lowest matching rule wins"></label>
    <label class="fld"><span>Note (optional)</span><input id="rNote" value="${esc(r.note || '')}"></label>
    <button class="primary">${r.id ? 'Save rule' : 'Add rule'}</button>${r.id ? '<button type="button" id="rCancel">Cancel</button>' : ''}
  </form>`;
}

/** The team's own rules, follow rules too (not manual assignments, which the channels card shows). */
const ownRules = () => state.view.rules.filter((x) => x.value === state.view.team.slug && x.field !== 'channel_id');

function renderRules() {
  const own = ownRules();
  $('rulesTable').innerHTML = own.length
    ? `<table><tr><th></th><th>Field</th><th>Pattern</th><th></th><th>Priority</th><th>Note</th><th></th></tr>${own.map(ruleRow).join('')}</table>`
    : '<div class="empty">No rule files or follows channels for this team yet.</div>';
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
      target: $('rTarget').value,
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
    portal = [], memberRequests = [],
  } = r.body;
  if (r.body.portalBound !== undefined) state.portalBound = Boolean(r.body.portalBound);
  const v = {
    target: 'team', value: slug, team, members, rules, channels, suggestions, coverage, requests, follows, followable, portal,
    memberRequests,
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
      ${admin && real && team.slug !== 'admin' ? '<button class="danger" id="tDelete">Delete team</button>' : ''}</div>
    ${sectionsNav()}
    <div class="status" id="status"></div>
    ${real ? `<div class="card"><label class="inline">
      <input type="checkbox" id="tSelf"${team.self_managed ? ' checked' : ''}${admin ? '' : ' disabled'}>
      <span><b>Self-managed</b>: every member is a team manager and may add and remove members and edit the team's knowledge base.</span></label>
      <p class="hint">${admin ? 'Turning it on makes every member a manager, now and when they join. Turning it off keeps the roles as they are; new members join as members, and managers can be demoted.' : 'Only the admin team changes this.'}</p></div>` : ''}
    ${real ? `<div class="card"><h2>Members</h2><div id="membersTable"></div>
      <div class="form picker"><label class="fld grow"><span>Add a member</span><input id="mFind" autocomplete="off"></label><div class="picks s2-float" id="mPicks" hidden></div></div>
      <p class="hint">Type a name or an email. Members see this team's inbox. They also need to be in the Access policy of the inbox.</p></div>
    ${real && v.memberRequests.length ? `<div class="card"><h2>People asked for</h2><div id="memberRequestsTable"></div><div id="mrSlot"></div>
      <p class="hint">People asked to be added to this team, in a thread's sidebar, through its agent. Confirming one adds them as a member, as adding them above does; declining takes a reason, for whoever asked.</p></div>` : ''}
    ${slug !== 'admin' ? `<div class="card"><h2>Suggested members</h2>
      <p class="hint lead">Adobe people who are not on ${esc(team.name)} but work its threads, are members of its channels on Slack or Teams, or work the topics its threads are about elsewhere, the likeliest first. Add makes one a member.</p>
      <div id="memberSuggest"><div class="empty">Looking for people…</div></div></div>` : ''}

    ${admin ? `<div class="card"><h2>Rules</h2><div id="rulesTable"></div>
      <div id="ruleSlot">${ruleForm()}</div>
      <p class="hint">A channel goes to the team of the matching rule with the lowest priority. Example: channel name starts with <code>aem-</code>. A follow rule files nothing: the channels it matches are shared with the team, wherever they are filed. Conflicts between the teams' rules are under Requests.</p>
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
  tabInView();
  renderChannels();
  if (suggestions) renderSuggestions();
  wireChannelPicker();
  if ($('requestsTable')) renderRequests();
  if ($('portalTable')) renderPortal();
  if (!real) return;
  renderMembers();
  if ($('memberRequestsTable')) renderMemberRequests();
  wireMemberPicker();
  if ($('memberSuggest')) loadMemberSuggestions(v);
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

// ---- the team wizard ----------------------------------------------------------------------
//
// The admin team's channels, grouped by the prefix of their names (src/teamwizard.js), each a
// team it might make: listed under the teams as they come up. A group's page makes it a team
// (or gives an existing one its rules) with the people checked as members, in one go; or
// dismisses it, until it has more channels.

const GROUP = 'group:';
const peopleCount = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** The groups in the list of teams: the ones offered, then the dismissed ones folded away. */
function groupList(f) {
  const match = (g) => !f || `${g.prefix} ${g.name}`.toLowerCase().includes(f);
  const row = (g) => {
    const checked = g.people.filter((p) => p.suggested).length;
    const fits = g.team ? ` · likely ${esc(teamLabel(g.team.slug))}` : '';
    return `<div class="row two${state.sel === `${GROUP}${g.prefix}` ? ' on' : ''}" data-sel="${esc(GROUP + g.prefix)}" title="Channels starting with ${esc(g.prefix)}">
      <span class="name"><span class="mono">${esc(g.prefix)}</span>…</span>
      <span class="sub">${channelCount(g.size)} · ${checked ? peopleCount(checked) : 'nobody in most of them'}${fits}</span></div>`;
  };
  const offered = state.groups.filter(match);
  const dismissed = state.dismissedGroups.filter(match);
  if (!offered.length && !dismissed.length) return '';
  return `<h2>Suggested teams</h2>${offered.map(row).join('') || '<div class="empty">None now.</div>'}
    ${dismissed.length ? `<details class="dismissed"${dismissed.some((g) => state.sel === `${GROUP}${g.prefix}`) ? ' open' : ''}><summary class="sub">${dismissed.length} dismissed</summary>${dismissed.map(row).join('')}</details>` : ''}`;
}

const slugFrom = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function renderGroupPeople() {
  const v = state.view;
  const { group: g } = v;
  const total = state.groupCoverage && state.groupCoverage.channels;
  const did = (p) => [p.posted ? `${p.posted} post${p.posted === 1 ? '' : 's'}` : '', p.reacted ? `${p.reacted} reaction${p.reacted === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(', ');
  $('gPeople').innerHTML = g.people.length
    ? `<table><tr><th></th><th>Name</th><th>In these channels</th><th>In the admin team's</th><th>Teams</th></tr>${g.people.map((p, i) => `<tr>
      <td><input type="checkbox" id="gp${i}" data-email="${esc(p.email)}"${v.checked.has(p.email) ? ' checked' : ''}></td>
      <td><label for="gp${i}">${esc(p.name || p.email)}</label><div class="sub">${esc(p.email)}${did(p) ? ` · ${esc(did(p))}` : ''}</div></td>
      <td class="nw">${p.channels} of ${g.size}</td>
      <td class="nw">${p.everywhere}${total ? ` of ${total}` : ''}</td>
      <td>${esc(p.teams.map(teamLabel).join(', '))}</td></tr>`).join('')}</table>`
    : '<div class="empty">Nobody from Adobe is known in these channels yet.</div>';
  for (const box of $('gPeople').querySelectorAll('[data-email]')) {
    box.onchange = () => {
      if (box.checked) v.checked.add(box.dataset.email); else v.checked.delete(box.dataset.email);
      renderGroupApply();
    };
  }
}

/** What the rules would move, from their dry run: the group's channels, and any others. */
function renderGroupMoves() {
  const v = state.view;
  const el = $('gMoves');
  if (!el) return;
  if (!v.moves) { el.innerHTML = `<span class="sub">${v.movesError ? esc(v.movesError) : 'Looking at what the rules would move…'}</span>`; return; }
  const mine = new Set(v.group.channels.map((c) => `${c.source}:${c.channelId}`));
  // What changes team: a rule change also re-files what the rules say otherwise already.
  const moved = v.moves.filter((m) => m.from.some((f) => f.team !== m.to.team));
  const others = moved.filter((m) => !mine.has(`${m.channel.source}:${m.channel.channelId}`));
  el.innerHTML = `<div class="status ${others.length ? 'warn' : 'ok'}">The rules re-file ${channelCount(moved.length)} under the team.</div>
    ${others.length ? `<p class="hint">Not only these channels: they also take ${others.map((m) => `<b>${esc(plainName(m.channel))}</b> from ${esc(m.from.map((x) => teamLabel(x.team)).join(', '))}`).join(', ')}.</p>` : ''}`;
}

function renderGroupApply() {
  const v = state.view;
  const n = v.checked.size;
  const b = $('gCreate');
  if (!b) return;
  b.textContent = v.mode === 'new'
    ? `Create the team${n ? ` with ${peopleCount(n)}` : ''}`
    : `Give ${teamLabel($('gTeam').value)} these channels${n ? ` and ${peopleCount(n)}` : ''}`;
  b.disabled = busy.has(`wizard:${v.group.prefix}`)
    || (v.mode === 'new' ? !$('gName').value.trim() || !$('gSlug').value.trim() : !$('gTeam').value);
}

/** Takes a group made a team out of the list: it, its narrower groups, and its channels from the wider ones. */
function dropGroup(g) {
  const gone = new Set(g.channels.map((c) => `${c.source}:${c.channelId}`));
  const trim = (list) => list.filter((x) => !x.prefix.startsWith(g.prefix)).map((x) => {
    if (!g.prefix.startsWith(x.prefix)) return x;
    const channels = x.channels.filter((c) => !gone.has(`${c.source}:${c.channelId}`));
    return { ...x, channels, size: x.size - (x.channels.length - channels.length) };
  });
  state.groups = trim(state.groups);
  state.dismissedGroups = trim(state.dismissedGroups);
}

function showGroup(prefix) {
  const current = loadingPage();
  const g = [...state.groups, ...state.dismissedGroups].find((x) => x.prefix === prefix);
  if (!g) {
    // A link to a group, opened before the groups are there (loadGroups opens it then).
    if (!state.groupCoverage) { state.view = { target: 'group-pending' }; return; }
    $('detail').innerHTML = `<div class="title">${backButton()}</div><div class="empty">No channel of the admin team starts with <code>${esc(prefix)}</code> now: a team has them, or they were renamed.</div>`;
    return;
  }
  const teams = state.teams.filter((t) => t.slug !== 'admin');
  const preferred = g.team ? g.team.slug : (g.slugTaken ? g.slug : '');
  const v = {
    target: 'group', group: g, mode: preferred ? 'existing' : 'new', moves: null, checked: new Set(g.people.filter((p) => p.suggested).map((p) => p.email)),
  };
  state.view = v;
  const checked = v.checked.size;
  const listed = g.membersListed < g.size ? ` The members of ${g.membersListed} of them are listed; in the others, only who posted or reacted is known.` : '';
  $('detail').innerHTML = `
    <div class="title">${backButton()}<h1 class="fill">Channels starting with <code>${esc(g.prefix)}</code></h1>
      ${g.dismissed ? '<button id="gAgain">Suggest again</button>' : '<button id="gDismiss" title="Not a team: hidden until more channels start with it">Dismiss</button>'}</div>
    <div class="status" id="status"></div>
    <p class="hint lead">${channelCount(g.size)} the admin team holds start with <code>${esc(g.prefix)}</code>: no rule files them under an ops team.${listed}
      ${g.dismissed ? ` Dismissed by ${esc(g.dismissed.by || 'someone')} ${esc(ago(g.dismissed.at))}, at ${channelCount(g.dismissed.channels)}: suggested again once more start with it.` : ''}</p>
    <div class="card wizteam"><h2>Team</h2>
      <label class="inline"><input type="radio" name="gMode" value="new"${v.mode === 'new' ? ' checked' : ''}><span>A new team</span></label>
      <div class="form"><label class="fld grow"><span>Name</span><input id="gName" value="${esc(g.slugTaken ? '' : g.name)}"></label>
        <label class="fld"><span>Slug</span><input id="gSlug" pattern="[a-z0-9][a-z0-9-]*" value="${esc(g.slugTaken ? '' : g.slug)}"></label></div>
      <label class="inline"><input type="radio" name="gMode" value="existing"${v.mode === 'existing' ? ' checked' : ''}><span>An ops team that exists</span>
        <select id="gTeam" aria-label="Ops team">${teams.map((t) => `<option value="${esc(t.slug)}"${t.slug === preferred ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      ${g.team ? `<p class="hint">${g.team.people} of the ${peopleCount(checked)} checked below ${g.team.people === 1 ? 'is' : 'are'} on ${esc(teamLabel(g.team.slug))} already: these channels may be its.</p>` : ''}
      ${g.slugTaken && !g.team ? `<p class="hint">There is a team <span class="mono">${esc(g.slug)}</span> already.</p>` : ''}</div>
    <div class="card"><h2>Members</h2><div id="gPeople"></div>
      <p class="hint">The Adobe people who are members of these channels, post or react in them, those in the most first. Checked: in at least half of them, and in them more than twice as often as in the admin team's channels at large, so that someone who is in all of those does not count. They join the team as members; make one a manager on its page.</p></div>
    <div class="card"><h2>Rules</h2><table><tr><th>Field</th><th>Rule</th><th>Platform</th></tr>${g.rules.map((r) => `<tr><td>${esc(FIELD_LABEL[r.field] || r.field)}</td><td>${describe(r)}</td><td>${r.source ? esc(platform({ source: r.source })) : 'All'}</td></tr>`).join('')}</table>
      <div class="preview" id="gMoves"></div>
      <p class="hint">The rules file every channel that starts with <code>${esc(g.prefix)}</code> under the team, now and when one is made, at priority 100 as the other prefix rules.</p></div>
    <div class="card"><h2>Channels</h2><table><tr><th>Channel</th><th>Platform</th><th>Threads</th><th>Latest</th></tr>${g.channels.map((c) => `<tr>
      <td>${channelName(c)}${c.membersListed ? '' : '<div class="sub">members not listed</div>'}</td><td>${esc(platform(c))}</td><td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td></tr>`).join('')}</table>
      ${g.size > g.channels.length ? `<p class="hint">And ${g.size - g.channels.length} more.</p>` : ''}</div>
    <div class="card"><button class="primary" id="gCreate"></button></div>`;
  showStatus();
  renderGroupPeople();
  renderGroupMoves();
  for (const r of $('detail').querySelectorAll('[name="gMode"]')) {
    r.onchange = () => { v.mode = r.value; renderGroupApply(); };
  }
  $('gName').oninput = () => {
    if (!$('gSlug').dataset.touched) $('gSlug').value = slugFrom($('gName').value);
    $('detail').querySelector('[name="gMode"][value="new"]').checked = true;
    v.mode = 'new';
    renderGroupApply();
  };
  $('gSlug').oninput = () => { $('gSlug').dataset.touched = '1'; v.mode = 'new'; $('detail').querySelector('[name="gMode"][value="new"]').checked = true; renderGroupApply(); };
  $('gTeam').onchange = () => { v.mode = 'existing'; $('detail').querySelector('[name="gMode"][value="existing"]').checked = true; renderGroupApply(); };
  renderGroupApply();
  // What the rules would move: a dry run, as any rule change's.
  call('/api/admin/team-wizard', 'POST', {
    prefix: g.prefix, slug: g.slug, name: g.name, dryRun: true,
  }, { parallel: true, idempotent: true }).then((r) => {
    if (!current() || v !== state.view) return;
    if (r.ok) v.moves = r.body.moves; else v.movesError = r.body.error || `could not try the rules (${r.status})`;
    renderGroupMoves();
  });
  $('gCreate').onclick = () => once(`wizard:${g.prefix}`, async () => {
    renderGroupApply();
    const body = v.mode === 'new'
      ? { prefix: g.prefix, slug: $('gSlug').value.trim(), name: $('gName').value.trim() }
      : { prefix: g.prefix, team: $('gTeam').value };
    body.people = g.people.filter((p) => v.checked.has(p.email)).map((p) => ({ email: p.email, name: p.name || undefined }));
    status('', v.mode === 'new' ? `Creating ${body.name}…` : `Giving ${teamLabel(body.team)} the channels…`);
    const r = await call('/api/admin/team-wizard', 'POST', body);
    if (!r.ok) { failed(v.mode === 'new' ? `Create ${body.name}` : `Give ${teamLabel(body.team)} the channels`, r); if (v === state.view) renderGroupApply(); return; }
    const slug = r.body.team.slug;
    const { moves = [], members = [], refused = [] } = r.body;
    dropGroup(g);
    const teamsNow = await call('/api/admin/teams');
    if (teamsNow.ok) {
      state.teams = teamsNow.body.teams;
      state.names = teamsNow.body.names || state.names;
      state.unassigned = teamsNow.body.unassigned;
    }
    const said = `${r.body.team.existing ? teamLabel(slug) : body.name}: ${peopleCount(members.length)} added, re-filing ${channelCount(moves.filter((m) => m.from.some((x) => x.team !== m.to.team)).length)}${refused.length ? `; not added: ${refused.map((x) => x.email).join(', ')}` : ''}.`;
    if (state.tab !== 'teams' || state.sel !== `${GROUP}${g.prefix}`) { renderList(); return; }
    state.sel = slug;
    state.section = 'own';
    toUrl();
    renderList();
    await showTeam(slug);
    status(refused.length ? 'warn' : 'ok', said);
  });
  const toggle = (dismiss) => async () => {
    const b = $(dismiss ? 'gDismiss' : 'gAgain');
    await hold(b, `dismiss:${g.prefix}`, async () => {
      const r = await call('/api/admin/team-wizard/dismiss', dismiss ? 'POST' : 'DELETE', { prefix: g.prefix });
      if (!r.ok) { failed(dismiss ? 'Dismiss' : 'Suggest again', r); return; }
      state.groups = state.groups.filter((x) => x !== g);
      state.dismissedGroups = state.dismissedGroups.filter((x) => x !== g);
      if (dismiss) {
        g.dismissed = { by: state.me.email || state.me.name, at: new Date().toISOString(), channels: g.size };
        state.dismissedGroups.push(g);
      } else {
        g.dismissed = null;
        state.groups.push(g);
      }
      const order = (a, b2) => (b2.size - a.size) || a.prefix.localeCompare(b2.prefix);
      state.groups.sort(order);
      state.dismissedGroups.sort(order);
      if (dismiss && state.sel === `${GROUP}${g.prefix}`) unselect();
      else if (state.sel === `${GROUP}${g.prefix}`) {
        renderList();
        showGroup(g.prefix);
      } else renderList();
    });
  };
  if ($('gDismiss')) $('gDismiss').onclick = toggle(true);
  if ($('gAgain')) $('gAgain').onclick = toggle(false);
}

// ---- channel assignment requests ----------------------------------------------------------
//
// A team manager asks for a channel on their team's page (`askFor`); the admin team decides
// under Requests (`showRequest`): Confirm runs the assignment the team's page makes, after its
// dry run said what it moves; Decline takes a reason. Both pages show what came of each.

const who = (p) => esc((p && (p.name || p.email)) || 'someone');
const STATUS = {
  open: 'pending', confirmed: 'confirmed', declined: 'declined', withdrawn: 'withdrawn', opened: 'opened', merged: 'merged',
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
  state.memberRequests = r.body.memberRequests || [];
  state.portal = r.body.portal || [];
  state.conflicts = r.body.conflicts || [];
  state.ruleConflicts = r.body.ruleConflicts || [];
  state.openRequests = r.body.open;
  renderCount();
  const v = state.view;
  if (v && v.requests) {
    for (const x of v.requests) Object.assign(x, state.requests.find((y) => y.id === x.id) || {});
    if ($('requestsTable')) renderRequests();
  }
  if (v && v.memberRequests) {
    for (const x of v.memberRequests) Object.assign(x, state.memberRequests.find((y) => y.id === x.id) || {});
    if ($('memberRequestsTable')) renderMemberRequests();
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

// ---- membership requests --------------------------------------------------------------------
//
// A thread's agent asks, for whoever asked it in the sidebar, that someone be added to an ops team
// (src/memberrequests.js). An admin decides under Requests (`showMemberRequest`), a team's
// managers on its page (`renderMemberRequests`): Confirm adds the person as a member, as adding
// them on the team's page does; Decline takes a reason.

/** What marks a membership request among the requests picked (`?request=member:3`). */
const MEMBER = 'member:';
const memberName = (r) => r.person.name || r.person.email;

/** A membership request in Requests' list. */
const memberRow = (r) => `<div class="row${String(state.sel) === `${MEMBER}${r.id}` ? ' on' : ''}" data-sel="${MEMBER}${r.id}">
  <span class="name">${esc(memberName(r))} <span class="sub">→ ${esc(teamLabel(r.team))}</span></span>
  ${r.status === 'open' ? '' : statusTag(r)}<span class="sub">${esc(ago(r.status === 'open' ? r.requestedAt : r.decidedAt))}</span></div>`;

/** What came of a membership request, in a few words. */
function memberDecisionText(r) {
  const when = r.decidedAt ? ` ${esc(ago(r.decidedAt))}` : '';
  if (r.status === 'open') return `${statusTag(r)} waiting for an admin or a manager of ${esc(teamLabel(r.team))}`;
  if (r.status === 'declined') {
    return `${statusTag(r)} by ${who(r.decidedBy)}${when}${r.reason ? `: <span class="note">${esc(r.reason)}</span>` : ''}`;
  }
  const did = { added: `added to ${esc(teamLabel(r.team))}`, member: `on ${esc(teamLabel(r.team))} already` }[r.outcome] || '';
  return `${statusTag(r)} by ${who(r.decidedBy)}${when}${did ? `: ${did}` : ''}`;
}

/** A membership request as it is now, everywhere the page shows it. */
function updateMemberRequest(r) {
  const was = state.memberRequests.find((x) => x.id === r.id);
  if (was && was.status === 'open' && r.status !== 'open') state.openRequests = Math.max(0, state.openRequests - 1);
  if (was) Object.assign(was, r); else if (state.me.admin) state.memberRequests.unshift(r);
  const mine = state.view?.memberRequests?.find((x) => x.id === r.id);
  if (mine) Object.assign(mine, r);
  renderCount();
}

/**
 * Confirms or declines membership request `r` (`reason`: declines it); `after` redraws where it
 * was decided. A person added joins the open team page's members.
 */
function decideMember(b, r, reason, after) {
  return hold(b, `mrequest:${r.id}`, async () => {
    const confirm = reason === undefined;
    const res = await call(`/api/admin/member-requests/${confirm ? 'confirm' : 'decline'}`, 'POST', { id: r.id, ...(confirm ? {} : { reason: reason || undefined }) });
    if (res.body.request) updateMemberRequest(res.body.request);
    if (!res.ok) {
      failed(`${confirm ? 'Confirm' : 'Decline'} ${memberName(r)}`, res);
    } else if (confirm) {
      const v = state.view;
      const { person } = res.body;
      if (v && v.value === r.team && v.members && person && !v.members.some((m) => m.id === person.id)) {
        v.members.push(person);
        v.members.sort((x, y) => String(x.name || x.email).localeCompare(String(y.name || y.email)));
        const row = state.teams.find((t) => t.slug === r.team);
        if (row) row.members += 1;
        if ($('membersTable')) { renderMembers(); memberChanged(person.email, true); }
      }
      status('ok', `Confirmed: ${memberName(r)} is on ${teamLabel(r.team)}${res.body.request?.outcome === 'member' ? ' (already was)' : ''}.`);
    } else {
      status('ok', `Declined ${memberName(r)} for ${teamLabel(r.team)}.`);
    }
    after();
  });
}

/** The team page's people asked for: who, by whom, why, and Confirm or Decline. */
function renderMemberRequests() {
  const v = state.view;
  const rows = v.memberRequests.map((r) => `<tr><td>${esc(memberName(r))}<div class="sub">${esc(r.person.email)}${r.person.teams.length ? ` · on ${esc(r.person.teams.map(teamLabel).join(', '))}` : ''}</div></td>
    <td class="nw">${who(r.requestedBy)}<div class="sub">${esc(ago(r.requestedAt))}</div></td>
    <td class="note">${esc(r.note || '')}</td>
    <td>${r.status === 'open' ? '' : memberDecisionText(r)}</td>
    <td class="nw">${r.status !== 'open' ? '' : `<button class="link" data-mconfirm="${r.id}"${off(`mrequest:${r.id}`)}>Confirm</button>
      <button class="link" data-mdecline="${r.id}"${off(`mrequest:${r.id}`)}>Decline</button>`}</td></tr>`).join('');
  $('memberRequestsTable').innerHTML = `<table><tr><th>Person</th><th>Asked by</th><th>Why</th><th>Answer</th><th></th></tr>${rows}</table>`;
  const redraw = () => { if (v === state.view && $('memberRequestsTable')) renderMemberRequests(); renderList(); };
  for (const b of $('memberRequestsTable').querySelectorAll('[data-mconfirm]')) {
    const r = v.memberRequests.find((x) => String(x.id) === b.dataset.mconfirm);
    b.onclick = () => decideMember(b, r, undefined, redraw);
  }
  for (const b of $('memberRequestsTable').querySelectorAll('[data-mdecline]')) {
    const r = v.memberRequests.find((x) => String(x.id) === b.dataset.mdecline);
    b.onclick = () => {
      $('mrSlot').innerHTML = `<form class="form" id="mrForm"><span class="what">Decline <b>${esc(memberName(r))}</b> for ${esc(teamLabel(r.team))}</span>
        <label class="fld grow"><span>Reason, for whoever asked (optional)</span><input id="mrReason" maxlength="500"></label>
        <button class="danger" id="mrDecline">Decline</button><button type="button" id="mrCancel">Cancel</button></form>`;
      $('mrReason').focus();
      $('mrCancel').onclick = () => { $('mrSlot').innerHTML = ''; };
      $('mrForm').onsubmit = (e) => {
        e.preventDefault();
        const reason = $('mrReason').value.trim();
        $('mrSlot').innerHTML = '';
        decideMember(b, r, reason, redraw);
      };
    };
  }
}

/** A membership request, for the admin team: who, for which team, by whom, and Confirm or Decline. */
function drawMemberRequest(r) {
  const open = r.status === 'open';
  const p = r.person;
  $('detail').innerHTML = `
    <div class="title">${backButton()}<h1 class="fill">${esc(memberName(r))} <span class="sep">→</span> ${esc(teamLabel(r.team))}</h1>${statusTag(r)}</div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label>Person</label><span>${esc(memberName(r))} <span class="sub mono">${esc(p.email)}</span>${p.id ? '' : ' <span class="tag">new person</span>'}</span>
      <label>Now</label><span>${p.teams.length ? `on ${esc(p.teams.map(teamLabel).join(', '))}` : 'on no team'}</span>
      <label>For</label><span><a href="/inbox/admin?tab=teams&team=${encodeURIComponent(r.team)}">${esc(teamLabel(r.team))}</a></span>
      <label>Asked by</label><span>${who(r.requestedBy)} <span class="sub">${esc(ago(r.requestedAt))}</span></span>
      ${r.thread ? `<label>Asked in</label><span>the <a href="/inbox?t=${encodeURIComponent(r.thread)}">sidebar of a thread</a>, through its agent</span>` : ''}
      ${r.note ? `<label>Why</label><span class="note">${esc(r.note)}</span>` : ''}
      ${open ? '' : `<label>Answer</label><span>${memberDecisionText(r)}</span>`}
    </div></div>
    ${open ? `<div class="card"><h2>Confirming it</h2><p class="hint lead">Adds ${esc(memberName(r))} to ${esc(teamLabel(r.team))} as a member (a manager, when the team is self-managed), as adding them on the team's page does: they see its inbox.</p>
      <div class="form"><button class="primary" id="mqConfirm"${off(`mrequest:${r.id}`)}>Confirm</button></div></div>
      <div class="card"><h2>Declining it</h2><form class="form" id="mqDeclineForm"><label class="fld grow"><span>Reason, for whoever asked (optional)</span><input id="mqReason" maxlength="500"></label>
      <button class="danger" id="mqDecline"${off(`mrequest:${r.id}`)}>Decline</button></form></div>` : ''}`;
  showStatus();
  if (!open) return;
  const redraw = () => {
    renderList();
    if (state.tab === 'requests' && String(state.sel) === `${MEMBER}${r.id}`) drawMemberRequest(r);
  };
  $('mqConfirm').onclick = () => decideMember($('mqConfirm'), r, undefined, redraw);
  $('mqDeclineForm').onsubmit = (e) => {
    e.preventDefault();
    decideMember($('mqDecline'), r, $('mqReason').value.trim(), redraw);
  };
}

function showMemberRequest(id) {
  loadingPage();
  state.view = null;
  const r = state.memberRequests.find((x) => String(x.id) === String(id));
  if (!r) { $('detail').innerHTML = `<div class="empty">${backButton()} No such request.</div>`; return; }
  drawMemberRequest(r);
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
  const where = d.path ? `<a href="${esc(address({
    tab: 'teams', sel: d.team, section: 'kb', path: d.path,
  }))}">${esc(d.path)}</a>`
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

// ---- conflicts between team rules ------------------------------------------------------------
//
// Computed from the rules and the channels every time (src/ruleconflicts.js): two teams' rules that
// both match a channel no manual assignment decides. Side a is the broader, b the narrower. Either
// side can win: the other rule leaves the winner's out, and the other team may follow the channels
// both match (a follow rule). Or it is kept as it is. Each way is tried first (a dry run), so the
// page says what would move before anything does.

const RULE_CONFLICT = 'ruleconflict:';
/** A team's, in words: "Edge's", "Platform ops'". */
const poss = (slug) => { const n = teamLabel(slug); return /s$/i.test(n) ? `${n}'` : `${n}'s`; };
const sideRule = (x) => x.rules[0];

/** One side of a rule conflict, in a few words: "Platform ops' aem-…". */
function sideText(x) {
  const prefix = prefixOf(sideRule(x).pattern);
  return `${poss(x.team)} ${prefix !== null ? `${prefix}…` : sideRule(x).pattern}`;
}
/** The same as HTML, the pattern as code. */
function sideHtml(x) {
  const r = sideRule(x);
  return `${esc(poss(x.team))} rule (${esc((FIELD_LABEL[r.field] || r.field).toLowerCase())} ${describe(r)})`;
}

function ruleConflictTitle(c) {
  return `${sideText(c.a)} · ${sideText(c.b)}`;
}

function ruleConflictRow(c) {
  const sel = `${RULE_CONFLICT}${c.key}`;
  return `<div class="row${String(state.sel) === sel ? ' on' : ''}" data-sel="${esc(sel)}">
    <span class="name">${esc(teamLabel(c.a.team))} <span class="sub">and</span> ${esc(teamLabel(c.b.team))} <span class="sub">${esc(sideRule(c.b).pattern)} inside ${esc(sideRule(c.a).pattern)}</span></span>
    ${c.kept ? '<span class="tag confirmed">kept</span>' : ''}<span class="sub">${esc(channelCount(c.channels.length))}</span></div>`;
}

/** Who files the channels both sides match now: "Edge files all 15", "Edge 12, Platform ops 3". */
function winnersText(c) {
  const n = c.channels.length;
  const rest = n - c.a.wins - c.b.wins;
  const parts = [[c.b, c.b.wins], [c.a, c.a.wins]].filter(([, k]) => k)
    .map(([x, k]) => `${teamLabel(x.team)} ${k === n ? ({ 1: 'files it', 2: 'files both' }[n] || `files all ${n}`) : k}`);
  if (rest) parts.push(`another rule ${rest}`);
  return parts.join(', ');
}

const MAX_RC_ROWS = 25;
const ruleCells = (r) => `<td>${esc(FIELD_LABEL[r.field] || r.field)}</td><td>${describe(r)}</td>
  <td>${r.source ? `<span class="tag">${esc(r.source)} only</span>` : ''}</td><td class="n">${r.priority}</td>
  <td class="sub">${esc(r.note || '')}${r.updatedBy ? `<div>${esc(r.updatedBy)} ${esc(ago(r.updatedAt))}</div>` : ''}</td>`;

/** Both rules: what they read, how much they match, how many of these they file now. */
function rulesCard(c) {
  const row = (x, which) => `<tr><td>${esc(teamLabel(x.team))}<div class="sub">${which} · matches ${esc(channelCount(x.matches))}, files ${x.wins} of these</div></td>${ruleCells(sideRule(x))}</tr>`;
  return `<div class="card"><h2>The rules</h2>
    <table><tr><th>Team</th><th>Field</th><th>Pattern</th><th></th><th>Priority</th><th>Note</th></tr>${row(c.a, 'the broader')}${row(c.b, 'the narrower')}</table></div>`;
}

/** The channels both rules match, and who files each now. */
function overlapCard(c) {
  const rows = c.channels.slice(0, MAX_RC_ROWS).map((ch) => `<tr><td>${channelName(ch)}<div class="sub">${esc(platform(ch))} · <span class="mono">${esc(ch.channelId)}</span></div></td>
    <td>${esc(teamLabel(ch.winner))}</td></tr>`).join('');
  const more = c.channels.length > MAX_RC_ROWS ? `<tr><td colspan="2" class="sub">and ${c.channels.length - MAX_RC_ROWS} more</td></tr>` : '';
  return `<div class="card"><h2>The channels both match <span class="sub">${esc(channelCount(c.channels.length))}</span></h2>
    <table><tr><th>Channel</th><th>Filed under now</th></tr>${rows}${more}</table>
    <p class="hint">Channels assigned by hand are not in a conflict: the assignment decides them.</p></div>`;
}

/** What a dry run of a side winning says: the moves, and, when it follows, what the other team follows. */
function settlePreview(loser, p, follows) {
  if (!p) return '<p class="hint">Trying it…</p>';
  if (!p.ok) return `<p class="hint">Could not try it: ${esc(p.body.error || `failed (${p.status})`)}</p>`;
  const { moves = [], follows: list = [] } = p.body;
  const moved = moves.length ? `Moves ${esc(channelCount(moves.length))}: ${esc(movesText(moves))}.` : 'No channel moves.';
  const followed = follows && list.length ? ` ${esc(teamLabel(loser.team))} follows ${esc(channelCount(list.length))}: ${esc(list.slice(0, 5).map(plainName).join(', '))}${list.length > 5 ? ` and ${list.length - 5} more` : ''}.` : '';
  return `<p class="hint">${moved}${followed}</p>`;
}

/** One side winning: what happens to the other rule, whether the other team follows, and the button. */
function winCard(c, side, previews, follows) {
  const winner = c[side];
  const loser = c[side === 'a' ? 'b' : 'a'];
  const w = c.win[side];
  const name = esc(teamLabel(winner.team));
  const other = esc(teamLabel(loser.team));
  if (!w.ok) return `<div class="card conflict"><h2>${name} wins</h2><p class="hint">Not possible: ${esc(w.why)}.</p></div>`;
  const rule = w.empty
    ? `${esc(poss(loser.team))} rule matches no other channel: it goes${w.follow ? ', or becomes the follow rule' : ''}.`
    : `${esc(poss(loser.team))} rule leaves ${esc(poss(winner.team))} out: its pattern becomes <code>${esc(w.pattern)}</code>.`;
  const follow = w.follow
    ? `<label class="only"><input type="checkbox" data-follow="${side}"${follows[side] ? ' checked' : ''}> ${other} follows them: they are in ${esc(poss(loser.team))} inbox too${w.empty ? '' : ` (a follow rule, <code>${esc(w.follow.pattern)}</code>)`}</label>`
    : '';
  return `<div class="card conflict"><h2>${name} wins</h2>
    <p class="lead">${name} files the channels both match. ${rule}</p>${follow}
    ${settlePreview(loser, previews[side], w.follow && follows[side])}
    <div class="acts"><button class="primary" data-win="${side}"${previews[side] && previews[side].ok ? '' : ' disabled'}>${name} wins${w.follow && follows[side] ? `, ${other} follows` : ''}</button></div></div>`;
}

function drawRuleConflict(c, previews = {}, follows = { a: true, b: true }) {
  const neither = !c.win.a.ok && !c.win.b.ok;
  $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(teamLabel(c.a.team))} and ${esc(teamLabel(c.b.team))}</h1>${c.kept ? '<span class="tag confirmed">kept</span>' : ''}</div>
    <div class="status" id="status"></div>
    <div class="card"><p class="lead">${sideHtml(c.a)} and ${sideHtml(c.b)} both match ${esc(channelCount(c.channels.length))}. The lowest priority decides: now ${esc(winnersText(c))}.</p>
      ${neither ? `<p class="hint">Neither can win by a change of its pattern: ${esc(c.win.a.why)}. Change the rules on the teams' pages, or keep it as it is.</p>` : ''}
      ${c.kept ? `<p class="hint">Kept by ${esc(c.kept.by)} ${esc(ago(c.kept.at))}${c.kept.note ? `: <span class="note">${esc(c.kept.note)}</span>` : ''}. It shows again once its rules or channels change.</p>`
    : '<form class="form" id="rcKeep"><label class="fld grow"><span>Why it is meant (optional)</span><input id="rcNote" maxlength="300"></label><button id="rcKeepBtn">Keep as it is</button></form>'}
      <p class="hint">Settling it changes the rules as you, and re-files the channels it moves, as a change on a team's page does.</p></div>
    ${neither ? '' : `${winCard(c, 'a', previews, follows)}${winCard(c, 'b', previews, follows)}`}
    ${rulesCard(c)}${overlapCard(c)}`;
  showStatus();
  const settle = (btn, body, done) => hold(btn, `ruleconflict:${c.key}`, () => call('/api/admin/rule-conflicts', 'POST', {
    key: c.key, fingerprint: c.fingerprint, ...body,
  })).then((res) => {
    if (!res) return;
    if (!res.ok) {
      failed(`Settle ${ruleConflictTitle(c)}`, res);
      if (res.status === 409 && res.body.conflict) showRuleConflict(c.key, res.body.conflict);
      return;
    }
    state.ruleConflicts = res.body.ruleConflicts || [];
    refreshRequests();
    const now = state.ruleConflicts.find((x) => x.key === c.key);
    if (now) showRuleConflict(now.key);
    else $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(teamLabel(c.a.team))} and ${esc(teamLabel(c.b.team))}</h1></div><div class="status" id="status"></div><div class="empty">Settled: ${esc(done)}</div>`;
    const moves = res.body.moves || [];
    status('ok', `${done}${moves.length ? ` Re-filing ${channelCount(moves.length)} (${movesText(moves)}).` : ''}`);
    renderList();
  });
  if ($('rcKeep')) {
    $('rcKeep').onsubmit = (e) => {
      e.preventDefault();
      settle($('rcKeepBtn'), { action: 'keep', note: $('rcNote').value.trim() || undefined }, 'Kept as it is.');
    };
  }
  for (const box of $('detail').querySelectorAll('[data-follow]')) {
    box.onchange = () => {
      follows[box.dataset.follow] = box.checked;
      drawRuleConflict(c, previews, follows);
    };
  }
  for (const btn of $('detail').querySelectorAll('[data-win]')) {
    btn.onclick = async () => {
      const side = btn.dataset.win;
      const w = c.win[side];
      const winner = teamLabel(c[side].team);
      const loser = c[side === 'a' ? 'b' : 'a'];
      const follow = Boolean(w.follow && follows[side]);
      const p = previews[side] && previews[side].body;
      const n = (p && p.moves && p.moves.length) || 0;
      const rule = w.empty ? `${poss(loser.team)} rule ${follow ? 'becomes a follow rule' : 'goes'}` : `${poss(loser.team)} rule gets a new pattern${follow ? `, and ${teamLabel(loser.team)} a follow rule` : ''}`;
      if (!(await confirmFirst(`${winner} wins${follow ? `, ${teamLabel(loser.team)} follows` : ''}?`, `${rule}; ${n ? `${channelCount(n)} move` : 'no channel moves'}.`, 'Settle it'))) return;
      settle(btn, { action: 'win', side, follow }, `${winner} files them${follow ? `, ${teamLabel(loser.team)} follows them` : ''}.`);
    };
  }
}

/**
 * A rule conflict, and a dry run of each side winning (`/api/admin/rule-conflicts` with `dryRun`),
 * shown as they come. `c` is the conflict as an answer gave it, when it is newer.
 */
function showRuleConflict(key, c = null) {
  loadingPage();
  state.view = null;
  const found = c || (state.ruleConflicts || []).find((x) => x.key === key);
  if (!found) { $('detail').innerHTML = '<div class="empty">No such conflict: it may be settled already.</div>'; return; }
  const previews = {};
  const follows = { a: true, b: true };
  drawRuleConflict(found, previews, follows);
  const shownNow = () => state.sel === `${RULE_CONFLICT}${key}`;
  for (const side of ['a', 'b'].filter((x) => found.win[x].ok)) {
    call('/api/admin/rule-conflicts', 'POST', {
      key, fingerprint: found.fingerprint, action: 'win', side, follow: Boolean(found.win[side].follow), dryRun: true,
    }, { parallel: true, idempotent: true }).then((p) => {
      previews[side] = p;
      if (shownNow()) {
        const el = document.activeElement && document.activeElement.id;
        const typed = $('rcNote') ? $('rcNote').value : '';
        drawRuleConflict(found, previews, follows);
        if ($('rcNote')) $('rcNote').value = typed;
        if (el && $(el)) $(el).focus();
      }
    });
  }
}

// ---- orgs ---------------------------------------------------------------------------------

async function showOrg(slug) {
  const current = loadingPage();
  const r = await call(`/api/admin/org?slug=${encodeURIComponent(slug)}`);
  if (!current()) return;
  if (!r.ok && r.body.mergedInto) {
    // Merged (src/orgmerge.js): it is the org it went into now.
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(slug)}</h1></div>
      <div class="empty">Merged into <a href="${esc(address({ tab: 'orgs', sel: r.body.mergedInto, section: 'own' }))}">${esc(orgLabel(r.body.mergedInto))}</a>.</div>`;
    return;
  }
  if (!r.ok) { $('detail').innerHTML = `<div class="empty">${esc(r.body.error)}</div>`; return; }
  if (r.body.unassigned) { showUnassigned(r.body); return; }
  const {
    org, rules, channels, types, domains = [], merged = [], follows = [], requests = [],
  } = r.body;
  Object.assign(state.names, r.body.names || {});
  const v = {
    target: 'org', value: slug, org, rules, channels, follows, requests,
  };
  const domain = domains[0] || null;
  state.view = v;
  if (!state.me.admin) {
    // Everyone else: who follows it (you, your teams), and its channels, with what you may do
    // there for your teams.
    $('detail').innerHTML = `
      <div class="title">${backButton()}${ico(org.icon, domain)}<h1 class="fill">${esc(org.name || org.slug)}</h1>
        <span class="sub mono">${esc(org.slug)}</span></div>
      ${sectionsNav()}
      <div class="status" id="status"></div>
      ${followCard()}
      ${orgChannelsCard()}`;
    showStatus();
    tabInView();
    renderOrgFollows();
    renderChannels();
    return;
  }
  $('detail').innerHTML = `
    <div class="title">${backButton()}<span id="oIco">${ico(org.icon, domain)}</span><h1 class="fill" id="oTitle">${esc(org.name || org.slug)}</h1>
      <span class="sub mono">${esc(org.slug)}</span><button class="danger" id="oDelete" title="Forget the name, icon and type"${org.updated_at ? '' : ' hidden'}>Reset</button></div>
    ${sectionsNav()}
    <div class="status" id="status"></div>
    ${followCard()}
    <div class="card"><div class="field">
      <label for="oName">Display name</label><span class="inline"><input id="oName" class="fill" value="${esc(org.name || '')}"></span>
      <label>Type</label><span class="seg" id="oType">${types.map((t) => `<button type="button" data-type="${t}" aria-pressed="${org.type === t}">${t}</button>`).join('')}</span>
      <label for="oIcon">Icon</label><span class="inline"><input id="oIcon" class="mono fill" value="${esc(org.icon || '')}"></span>
      <label>Suggestions</label><div class="icons" id="oIcons"><span class="sub">Looking for icons…</span></div>
    </div><p class="hint">The inbox shows the display name and icon instead of the slug and the favicon of the customer's mail domain${domain ? ` (here ${esc(domain)})` : ''}. A domain shows its favicon; an https URL is used as the image. The suggestions are the favicons of the websites its name and its people's mail domains suggest, and the icons those sites name, most likely first as Clef sees them; pick one to use it.</p></div>
    ${orgChannelsCard()}
    ${orgMergeCard(slug, merged)}
    ${rules.length ? `<div class="card"><h2>Rules naming this org</h2><table><tr><th>Field</th><th>Pattern</th><th>Value</th><th>Priority</th><th>Note</th></tr>
      ${rules.filter((x) => x.field !== 'channel_id' || x.note !== 'manual assignment').map((x) => `<tr><td>${esc(FIELD_LABEL[x.field] || x.field)}</td><td>${describe(x)}</td><td><code>${esc(x.value)}</code></td><td class="n">${x.priority}</td><td class="sub">${esc(x.note || '')}</td></tr>`).join('')}</table></div>` : ''}`;
  showStatus();
  tabInView();
  renderOrgFollows();
  renderChannels();
  wireChannelPicker();
  wireOrgMerge(slug);
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
    const was = state.orgs.find((x) => x.slug === slug);
    const retyped = (was?.type || 'customer') !== res.body.org.type;
    v.org = res.body.org;
    status('ok', 'Saved.');
    if (v === state.view) show(res.body.org);
    // A partner and a customer are candidates only by their names.
    if (retyped) loadDups({ fresh: true });
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
    loadDups({ fresh: true });
    if (v !== state.view) return;
    $('oName').value = '';
    $('oIcon').value = '';
    show(v.org);
  });
}

// ---- a customer's followers and channels ----------------------------------------------------
//
// Everyone on a team sees a customer's page: who follows it, and its channels, each under the
// team it is filed under and the teams it is shared with. You follow it yourself (PUT
// /api/follows: its conversations are in your personal view); your teams do, which you manage
// (PUT /api/admin/org-follows: a follow rule shares its channels with the team, now and later).
// A channel of a team you manage you give back to the admin team (POST /api/admin/release) or
// take out of its inbox where it is shared by hand (DELETE /api/admin/share); one of another
// team's you ask the admin team to move to yours (a request, `move`). The admin team moves any
// channel to any team (its name, as on a team's page) and assigns one here by hand.

/** Whether you may change what team `slug` has: the admin team, or its manager. */
const managesHere = (slug) => Boolean(state.me.admin || (state.me.manages || []).includes(slug));

/** The teams whose following you see on a customer's page: those that follow it, and yours. */
function followRows(v) {
  const following = new Set(v.follows.map((f) => f.team));
  const yours = state.me.admin ? [] : (state.me.manages || []);
  return [...new Set([...yours, ...following])].map((team) => ({ team, on: following.has(team) }))
    .sort((a, b) => teamLabel(a.team).localeCompare(teamLabel(b.team)));
}

function followCard() {
  return `<div class="card"><h2>Following</h2><div id="orgFollows"></div>
    <p class="hint">You following it puts its conversations in your personal view. A team that follows it has every channel of it in its inbox, shared, now and later (a follow rule on the team's page); the channels stay filed under their teams.</p></div>`;
}

function renderOrgFollows() {
  const v = state.view;
  const slug = v.value;
  const name = v.org.name || slug;
  const me = state.myOrgs.has(slug);
  const button = (data, on, label, key) => `<button type="button" class="ofollow" ${data} aria-pressed="${on}"
    aria-label="${esc(`${on ? 'Following' : 'Follow'}: ${label}`)}"${off(key)}>${on ? 'Following' : 'Follow'}</button>`;
  const rows = followRows(v).map(({ team, on }) => `<li><span class="name">${esc(teamLabel(team))}</span>
      ${managesHere(team) ? button(`data-team="${esc(team)}"`, on, teamLabel(team), `orgfollow:${team}:${slug}`) : '<span class="sub">follows it</span>'}</li>`).join('');
  const others = state.me.admin ? state.teams.filter((t) => !isHolding(t.slug) && !v.follows.some((f) => f.team === t.slug)) : [];
  $('orgFollows').innerHTML = `<ul class="followers">
      <li><span class="name">You</span>${button('data-me="1"', me, 'you', `orgfollow:me:${slug}`)}</li>${rows}</ul>
    ${others.length ? `<form class="form" id="ofAdd"><label class="fld"><span>Follow it with a team</span><select id="ofTeam"><option value="">Pick one…</option>
      ${others.map((t) => `<option value="${esc(t.slug)}">${esc(t.name)}</option>`).join('')}</select></label><button>Follow</button></form>` : ''}`;
  // The card is drawn again once the change is done and its button no longer busy (`off`): drawn
  // while it is, the new button would be disabled for good.
  const redraw = () => { if (v === state.view) renderOrgFollows(); };
  const team = (t, follow, b) => hold(b, `orgfollow:${t}:${slug}`, async () => {
    const res = await call('/api/admin/org-follows', 'PUT', { team: t, org: slug, follow });
    if (!res.ok) { failed(follow ? `${teamLabel(t)}: follow ${name}` : `${teamLabel(t)}: unfollow ${name}`, res); return; }
    v.follows = res.body.followers;
    // The shares are the rule's: its channels as they are now.
    const now = await call(`/api/admin/org?slug=${encodeURIComponent(slug)}`);
    if (now.ok && now.body.channels) v.channels = now.body.channels;
    if (v === state.view) renderChannels();
    status('ok', follow ? `${teamLabel(t)} follows ${name}: its channels are in ${teamLabel(t)}'s inbox, shared.` : `${teamLabel(t)} no longer follows ${name}.`);
  }).then(redraw);
  for (const b of $('orgFollows').querySelectorAll('[data-team]')) {
    b.onclick = () => team(b.dataset.team, b.getAttribute('aria-pressed') !== 'true', b);
  }
  $('orgFollows').querySelector('[data-me]').onclick = (e) => hold(e.currentTarget, `orgfollow:me:${slug}`, async () => {
    const follow = !state.myOrgs.has(slug);
    const res = await call('/api/follows', 'PUT', { kind: 'org', target: slug, follow });
    if (!res.ok) { failed(follow ? `Follow ${name}` : `Unfollow ${name}`, res); return; }
    state.myOrgs = new Set(res.body.by?.org || []);
    status('ok', follow ? `You follow ${name}: its conversations are in your personal view.` : `You no longer follow ${name}.`);
    renderList();
  }).then(redraw);
  if ($('ofAdd')) {
    $('ofAdd').onsubmit = (e) => {
      e.preventDefault();
      if ($('ofTeam').value) team($('ofTeam').value, true, e.submitter || $('ofAdd').querySelector('button'));
    };
  }
}

/** A customer's channels card: the table, and for the admin team the picker that assigns one here. */
function orgChannelsCard() {
  return `<div class="card"><h2>Channels</h2><div id="orgChannels"></div>
    ${state.me.admin ? '<div class="form picker"><label class="fld grow"><span>Assign a channel here by hand</span><input id="pick" autocomplete="off"></label><div class="picks s2-float" id="picks" hidden></div></div>' : ''}
    <p class="hint">Each channel is filed under one team (its folders, knowledge base and agents) and can be shared with more, whose inboxes have it too. ${state.me.admin
    ? 'Click a channel\'s name to move it to another team. <b>Remove</b> hands one back to the admin team, or takes it out of a team\'s inbox it is shared with. A manual assignment files one channel under this org whatever the rules say (a channel-id rule with priority 10).'
    : `${(state.me.manages || []).length ? '<b>Remove</b> hands a channel of your team back to the admin team, or takes it out of your team\'s inbox where it is shared with it. <b>Ask for</b> asks the admin team to move one to your team; the answer shows on your team\'s page.' : 'Your team managers change which channels your teams have.'}`}</p></div>`;
}

function renderOrgChannels() {
  const v = state.view;
  const asked = (c, team) => v.requests.some((r) => r.team === team && r.channel.channelId === c.channelId && r.channel.source === c.source);
  const movable = state.me.admin && state.teams.length > 1;
  const rows = v.channels.map((c) => {
    const where = `<div class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></div>`;
    if (c.left) {
      return `<tr class="left"><td>${channelName(c)}${where}</td><td colspan="4" class="sub">${c.left.unshared ? `Out of ${esc(teamLabel(c.left.team))}'s inbox.`
        : `Filed under ${esc(teamLabel(c.left.team))} / ${esc(orgLabel(c.left.org))} now; its threads are re-filed in the background.`}</td></tr>`;
    }
    const byRule = c.followedByRule || [];
    const shares = (c.sharedWith || []).map((t) => `<li>${esc(teamLabel(t))} <span class="sub">${byRule.includes(t) ? (v.follows.some((f) => f.team === t) ? 'follows the customer' : 'by a follow rule') : 'shared'}</span>
      ${managesHere(t) && !byRule.includes(t) ? `<button class="link" data-unshare="${esc(c.channelId)}" data-team="${esc(t)}"${off(`unshare:${t}:${c.channelId}`)} title="Take it out of ${esc(teamLabel(t))}'s inbox; it stays filed under ${esc(teamLabel(c.team))}">Remove</button>` : ''}</li>`).join('');
    const split = (c.split || []).filter((x) => x.threads);
    const home = `<li><b>${esc(teamLabel(c.team))}</b> <span class="sub">filed${c.manual?.team ? ' by hand' : ''}</span>
      ${!isHolding(c.team) && managesHere(c.team) ? `<button class="link" data-release="${esc(c.channelId)}"${off(`release:${c.channelId}`)} title="Hand it back to ${esc(teamLabel('admin'))}: filed there by hand, its threads re-filed">Remove</button>` : ''}</li>`;
    // A manager asks for it for their teams that do not have it filed.
    const ask = state.me.admin ? '' : (state.me.manages || []).filter((t) => t !== c.team).map((t) => (asked(c, t)
      ? `<span class="tag manual" title="Waiting for the admin team">asked for ${esc(teamLabel(t))}</span>`
      : `<button class="link" data-ask="${esc(c.channelId)}" data-team="${esc(t)}"${off(`ask:${t}:${c.channelId}`)} title="Ask the admin team to file it under ${esc(teamLabel(t))} (a move: its folders, knowledge base and agents go there)">Ask for ${esc(teamLabel(t))}</button>`)).join(' ');
    const manualOrg = state.me.admin && c.manual?.org
      ? `<span class="tag manual" title="Assigned to this org by hand, whatever the rules say">manual</span> <button class="link" data-unassign="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unassign:org:${c.channelId}`)}>Undo</button>` : '';
    const name = movable
      ? `<button class="link chan" data-move="${esc(c.channelId)}" aria-haspopup="dialog" title="Move it to another team">${channelName(c)}</button>` : channelName(c);
    return `<tr><td>${name}${where}</td>
      <td><ul class="teams">${home}${shares}</ul>${split.length ? `<div class="sub" title="Its threads are being re-filed under ${esc(teamLabel(c.team))}">${split.map((x) => `${x.threads} ${x.threads === 1 ? 'thread' : 'threads'} still under ${esc(teamLabel(x.team))}`).join(', ')}</div>` : ''}
        ${c.kind !== 'channel' ? ` <span class="tag">${esc(c.kind)}</span>` : ''}</td>
      <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td><td class="nw">${manualOrg}${ask}</td></tr>`;
  }).join('');
  $('orgChannels').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>Teams</th><th>Threads</th><th>Latest</th><th></th></tr>${rows}</table>`
    : '<div class="empty">No channel is filed here.</div>';
  const find = (id) => v.channels.find((c) => c.channelId === id && !c.left);
  const redraw = () => { if (v === state.view) renderOrgChannels(); renderList(); };
  for (const b of $('orgChannels').querySelectorAll('[data-move]')) {
    b.onclick = () => moveMenu(b, find(b.dataset.move));
  }
  for (const b of $('orgChannels').querySelectorAll('[data-release]')) {
    const c = find(b.dataset.release);
    const from = c.team;
    b.onclick = async () => {
      if (!(await confirmFirst(`Remove ${plainName(c)} from ${teamLabel(from)}?`, `It goes back to ${teamLabel('admin')}, filed there by hand, and its threads are re-filed. ${teamLabel(from)} gets it again only from ${teamLabel('admin')}.`, 'Remove'))) return;
      hold(b, `release:${c.channelId}`, async () => {
        const res = await ruleChange('POST', '/api/admin/release', { team: from, source: c.source, channelId: c.channelId }, `${plainName(c)} → ${teamLabel('admin')}`);
        if (!res) return;
        applyMoves(res.moves, v);
        // Filed under the admin team now, also with no thread to move.
        for (const x of v.channels.filter((y) => y.channelId === c.channelId && !y.left)) {
          x.team = 'admin';
          x.manual = { ...x.manual, team: res.rule ? { id: res.rule.id, value: res.rule.value } : x.manual?.team };
        }
        redraw();
      });
    };
  }
  for (const b of $('orgChannels').querySelectorAll('[data-unshare]')) {
    const c = find(b.dataset.unshare);
    const { team } = b.dataset;
    b.onclick = () => hold(b, `unshare:${team}:${c.channelId}`, async () => {
      const res = await call('/api/admin/share', 'DELETE', { team, channelId: c.channelId, source: c.source });
      if (!res.ok) { failed(`Remove ${plainName(c)} from ${teamLabel(team)}`, res); return; }
      c.sharedWith = (c.sharedWith || []).filter((t) => t !== team);
      const row = state.teams.find((t) => t.slug === team);
      if (row) row.shared = Math.max(0, (row.shared || 0) - 1);
      status('ok', `${plainName(c)} is out of ${teamLabel(team)}'s inbox; it stays filed under ${teamLabel(c.team)}.`);
      redraw();
    });
  }
  for (const b of $('orgChannels').querySelectorAll('[data-ask]')) {
    const c = find(b.dataset.ask);
    const { team } = b.dataset;
    b.onclick = () => hold(b, `ask:${team}:${c.channelId}`, async () => {
      // The same request twice is refused as a duplicate: safe to send again.
      const res = await call('/api/admin/requests', 'POST', {
        team, source: c.source, channelId: c.channelId, move: true,
      }, { idempotent: true });
      if (res.body.request) v.requests = [...v.requests.filter((r) => r.id !== res.body.request.id), res.body.request];
      if (!res.ok) failed(`Ask for ${plainName(c)}`, res);
      else status('ok', `Asked the admin team to move ${plainName(c)} to ${teamLabel(team)}; the answer shows on ${teamLabel(team)}'s page.`);
      redraw();
    });
  }
  for (const b of $('orgChannels').querySelectorAll('[data-unassign]')) {
    const id = b.dataset.unassign;
    b.onclick = () => hold(b, `unassign:org:${id}`, async () => {
      const res = await ruleChange('DELETE', '/api/admin/assign', { target: 'org', channelId: id, source: b.dataset.source }, `Undo ${plainName(find(id) || { channelId: id })}`);
      if (!res) return;
      setManual(id, null, v);
      applyMoves(res.moves, v);
      redraw();
    });
  }
}

// ---- unassigned channels ---------------------------------------------------------------------
//
// A channel no rule files under an org (its name is not `<product>-<org>`, nor is it assigned by
// hand) is in the org `_unassigned`. Customers lists them under Unassigned, each with the orgs it
// may belong to (src/orgassign.js: a Slack Connect or Teams team, its people's mail domain, a
// word of its name) or the new org it may be. Picking one assigns the channel there by hand, as
// the channel picker of an org's page does; a new org is made first, with the name and type given.

function showUnassigned(body) {
  const v = {
    target: 'org', value: UNASSIGNED, org: body.org, channels: body.channels, suggestions: body.suggestions || {},
  };
  state.view = v;
  $('detail').innerHTML = `<div class="title">${backButton()}<span class="ico none"></span><h1 class="fill">Unassigned</h1></div>
    <div class="status" id="status"></div>
    <div class="card"><h2>Channels without an org</h2><div id="unassignedTable"></div>
    <p class="hint">No rule files these channels under an org: their names are not <code>&lt;product&gt;-&lt;org&gt;</code>, and nobody assigned them. Give each one an org: one the inbox suggests (its Slack Connect or Teams team, its people's mail domain, a word of its name), any other, or a new one. It is assigned there by hand (a channel-id rule with priority 10), and its threads are re-filed. Ignored channels are not listed.</p></div>`;
  showStatus();
  renderUnassigned(v);
}

function renderUnassigned(v) {
  if (v !== state.view || !$('unassignedTable')) return;
  const rows = v.channels.map((c) => {
    const where = `<div class="sub">${esc(platform(c))} · <span class="mono">${esc(c.channelId)}</span></div>`;
    if (c.left) {
      return `<tr class="left"><td>${channelName(c)}${where}</td><td colspan="4" class="sub">Filed under ${esc(orgLabel(c.left.org))} now; its threads are re-filed in the background.</td></tr>`;
    }
    const sug = v.suggestions[c.channelId] || { orgs: [], fresh: null };
    const key = (slug) => `assign:org:${c.channelId}:${slug}`;
    const picks = [
      ...sug.orgs.map((o) => `<button class="link" data-org="${esc(o.org)}" data-ch="${esc(c.channelId)}" title="${esc(o.why)}"${off(key(o.org))}>→ ${esc(orgLabel(o.org))}</button>`),
      ...(sug.fresh ? [`<button class="link" data-new="${esc(sug.fresh.name)}" data-ch="${esc(c.channelId)}" title="${esc(`A new org: ${sug.fresh.why}`)}"${off(key(sug.fresh.slug))}>+ ${esc(sug.fresh.name)}</button>`] : []),
      `<button class="link" data-pick="${esc(c.channelId)}" aria-haspopup="dialog">${sug.orgs.length || sug.fresh ? 'Another…' : 'Pick an org…'}</button>`,
    ];
    return `<tr><td>${channelName(c)}${where}</td><td>${esc(teamLabel(c.team))}${c.kind !== 'channel' ? ` <span class="tag">${esc(c.kind)}</span>` : ''}</td>
      <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td><td class="picks-cell">${picks.join(' ')}</td></tr>`;
  }).join('');
  $('unassignedTable').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>Team</th><th>Threads</th><th>Latest</th><th>Org</th></tr>${rows}</table>`
    : '<div class="empty">Every channel has an org.</div>';
  const find = (id) => v.channels.find((c) => c.channelId === id && !c.left);
  for (const b of $('unassignedTable').querySelectorAll('[data-org]')) {
    b.onclick = () => press(b, () => assignOrg(v, find(b.dataset.ch), b.dataset.org));
  }
  for (const b of $('unassignedTable').querySelectorAll('[data-new]')) {
    b.onclick = () => press(b, () => newOrgFor(v, find(b.dataset.ch), b.dataset.new, 'customer'));
  }
  for (const b of $('unassignedTable').querySelectorAll('[data-pick]')) {
    b.onclick = () => orgMenu(b, v, find(b.dataset.pick));
  }
}

/** Assigns channel `c` of the unassigned ones to org `slug` by hand. */
function assignOrg(v, c, slug) {
  if (!c) return null;
  return once(`assign:org:${c.channelId}:${slug}`, async () => {
    const res = await ruleChange('POST', '/api/admin/assign', {
      target: 'org', value: slug, channelId: c.channelId, source: c.source,
    }, `${plainName(c)} → ${orgLabel(slug)}`);
    if (!res) return null;
    applyMoves(res.moves, v);
    // Nothing to re-file (no thread yet): it is that org's all the same.
    for (const row of v.channels.filter((x) => x.channelId === c.channelId && !x.left)) {
      row.left = { team: row.team, org: slug, kind: row.kind };
    }
    renderUnassigned(v);
    renderList();
    return res;
  });
}

/** Makes a new org called `name` (of `type`) and assigns channel `c` to it. */
async function newOrgFor(v, c, name, type) {
  if (!c || !name.trim()) return;
  const slug = slugFrom(name);
  if (!state.orgs.some((o) => o.slug === slug)) {
    const r = await call('/api/admin/orgs', 'POST', { name: name.trim(), type });
    // There is one of that slug already (known to the Worker, not to the page): it is the one.
    if (!r.ok && r.status !== 409) { failed(`New org ${name}`, r); return; }
    if (r.ok) {
      state.orgs.push({ ...r.body.org, channels: 0, threads: 0 });
      state.orgs.sort((x, y) => (x.name || x.slug).localeCompare(y.name || y.slug));
    }
  }
  await assignOrg(v, c, slug);
}

/**
 * The orgs for an unassigned channel, in the page's popover: the suggested ones first, then
 * every org, filtered as you type, and a new org of the name typed, with its type.
 */
function orgMenu(button, v, c) {
  if (!c) return;
  const el = openPop(button);
  if (!el) return;
  const sug = (v.suggestions[c.channelId] || {}).orgs || [];
  const why = new Map(sug.map((o) => [o.org, o.why]));
  const all = [...state.orgs].sort((a, b) => (why.has(b.slug) - why.has(a.slug))
    || (a.name || a.slug).localeCompare(b.name || b.slug));
  let list = all;
  let at = 0;
  el.setAttribute('aria-label', `An org for ${plainName(c)}`);
  el.innerHTML = `<p class="what">File ${channelName(c)} under</p>
    <label class="s2-search"><input class="search" type="search" aria-label="Find an org, or name a new one" autocomplete="off"></label>
    <div class="opts" role="listbox" aria-label="Orgs"></div>
    <div class="newtype" hidden><span class="sub">A new org, a</span><select aria-label="Its type">${state.types.map((t) => `<option>${t}</option>`).join('')}</select></div>
    <p class="hint">Assigned there by hand, whatever the rules say; its threads are re-filed.</p>`;
  const input = el.querySelector('input');
  const opts = el.querySelector('.opts');
  const typeOf = el.querySelector('select');
  const go = (o) => {
    if (!o) return;
    el.hidePopover();
    if (v !== state.view) return;
    if (o.create) newOrgFor(v, c, o.name, typeOf.value);
    else assignOrg(v, c, o.slug);
  };
  const render = () => {
    const typed = input.value.trim();
    const fresh = typed && slugFrom(typed) && !state.orgs.some((o) => o.slug === slugFrom(typed))
      ? [{ create: true, name: typed, slug: slugFrom(typed) }] : [];
    list = [...list.filter((o) => !o.create), ...fresh];
    el.querySelector('.newtype').hidden = !fresh.length;
    opts.innerHTML = list.map((o, i) => `<div class="row${i === at ? ' on' : ''}" role="option" aria-selected="${i === at}" data-i="${i}">
      ${o.create ? `<span class="name">New org “${esc(o.name)}” <span class="sub mono">${esc(o.slug)}</span></span>`
    : `${ico(o.icon, o.domain)}<span class="name">${esc(o.name || o.slug)} <span class="sub mono">${esc(o.slug)}</span></span>${why.has(o.slug) ? `<span class="tag clef yes" title="${esc(why.get(o.slug))}">suggested</span>` : ''}`}</div>`).join('')
      || '<div class="empty pad">Type a name to make a new org.</div>';
    for (const row of opts.querySelectorAll('[data-i]')) {
      // eslint-disable-next-line no-loop-func
      row.onclick = () => go(list[Number(row.dataset.i)]);
    }
    const on = opts.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    list = all.filter((o) => words.every((w) => `${o.name || ''} ${o.slug}`.toLowerCase().includes(w)));
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
      e.preventDefault();
      el.hidePopover();
    }
  };
  render();
  placePop(el, button);
  input.focus();
}

// ---- duplicate customers ---------------------------------------------------------------------
//
// One company can end up under two slugs (a channel named workfront-acmeco and one named
// aem-acme). The Worker lists the pairs of orgs that may be one, from their names, icons, mail
// domains, Slack Connect teams and people, each with Clef's verdict (src/orgmerge.js); the list
// on the left shows the likely ones first. A pair's page puts the two side by side: the admin
// team merges one into the other (tried first: what would be re-filed) or says they are not the
// same; anyone else who sees one of them asks the admin team for the merge, which waits under
// Requests. A merge can be undone on the page of the org kept.

const PAIR = 'pair:';
const MERGE_REQUEST = 'orgmerge:';
const pairSel = (a, b) => `${PAIR}${a < b ? `${a}:${b}` : `${b}:${a}`}`;
/** An org's name in a pair: its display name, else its slug. */
const dupName = (slug, orgs = state.dups?.orgs) => (orgs && orgs[slug] && orgs[slug].name) || orgLabel(slug);
/** An org's name on a pair's page: with its slug, where both are called the same. */
const nameIn = (v, slug) => {
  const other = slug === v.pair.a ? v.pair.b : v.pair.a;
  const name = dupName(slug, v.orgs);
  return name === dupName(other, v.orgs) ? `${name} (${slug})` : name;
};
const openAsks = (p) => (p.requests || []).filter((r) => r.status === 'open');
/** Whether a pair is listed among the likely ones: Clef says so, or somebody asked. */
const likelyPair = (p) => openAsks(p).length > 0 || (!p.dismissed && p.p !== null && p.p >= (state.dups?.likely ?? 0.5));

/**
 * The pairs, from the Worker. Clef is asked about some of them at a time, so while it has not
 * answered for all, the list asks again, as long as it gets further.
 */
async function loadDups({ fresh = false, round = 0 } = {}) {
  const r = await call(`/api/admin/org-duplicates${fresh ? '?fresh=1' : ''}`);
  if (!r.ok) {
    state.dups = {
      error: r.body.error || `failed (${r.status})`, pairs: [], orgs: {}, unchecked: 0,
    };
    return;
  }
  const was = state.dups && !state.dups.error ? state.dups.unchecked : null;
  state.dups = r.body;
  if (state.tab === 'orgs') renderList();
  if (r.body.unchecked && round < 10 && (was === null || round === 0 || r.body.unchecked < was)) {
    loadDups({ round: round + 1 });
  }
}

function dupRow(p) {
  const { orgs } = state.dups;
  const asked = openAsks(p).length;
  const said = p.p === null ? 'Clef has not said yet' : `${pct(p.p)} one, says Clef`;
  const why = [`${p.a}, ${p.b}`, said, asked ? 'merge asked for' : '', p.dismissed ? 'not the same' : ''].filter(Boolean).join(' · ');
  return `<div class="row two dup${state.sel === pairSel(p.a, p.b) ? ' on' : ''}" data-sel="${esc(pairSel(p.a, p.b))}"
      title="${esc(`${dupName(p.a)} (${p.a}) and ${dupName(p.b)} (${p.b})`)}">
    <span class="name">${ico(orgs[p.a].icon, orgs[p.a].domain)}${ico(orgs[p.b].icon, orgs[p.b].domain)}<span>${esc(dupName(p.a))} <span class="sep">and</span> ${esc(dupName(p.b))}</span></span>
    <span class="sub">${esc(why)}</span></div>`;
}

/** The pairs at the top of the list (filtered as the list is), the less likely ones folded. */
function dupSection(f) {
  const d = state.dups;
  if (!d || d.error) return '';
  const match = (p) => !f || `${dupName(p.a)} ${p.a} ${dupName(p.b)} ${p.b}`.toLowerCase().includes(f);
  const top = d.pairs.filter((p) => likelyPair(p) && match(p));
  const rest = d.pairs.filter((p) => !likelyPair(p) && match(p));
  if (!top.length && !rest.length && !d.unchecked) return '';
  const checking = d.unchecked ? `<div class="sub pad">Clef is looking at ${d.unchecked} more…</div>` : '';
  const open = state.dupsMore || rest.some((p) => state.sel === pairSel(p.a, p.b));
  return `<h2>Likely duplicates</h2>${top.map(dupRow).join('') || `<div class="empty pad">${f ? 'Nothing matches.' : 'None for now.'}</div>`}
    ${checking}${rest.length ? `<details class="dismissed" id="dupMore"${open ? ' open' : ''}><summary class="sub">${rest.length} less likely</summary>${rest.map(dupRow).join('')}</details>` : ''}`;
}

function wireDups() {
  if ($('dupMore')) $('dupMore').ontoggle = (e) => { state.dupsMore = e.target.open; };
}

/** The org a pair keeps when nobody said: the one asked for, else the busier, else the named. */
function keptOf(pair, orgs) {
  const asked = openAsks(pair)[0];
  if (asked) return asked.into;
  const [a, b] = [orgs[pair.a], orgs[pair.b]];
  if (a.threads !== b.threads) return a.threads > b.threads ? a.slug : b.slug;
  if (Boolean(a.name) !== Boolean(b.name)) return a.name ? a.slug : b.slug;
  return a.slug.length <= b.slug.length ? a.slug : b.slug;
}

/** The pair as it is now, in the list on the left too. */
function updatePair(pair, orgs) {
  if (!state.dups || state.dups.error) return;
  const i = state.dups.pairs.findIndex((x) => x.a === pair.a && x.b === pair.b);
  if (i >= 0) state.dups.pairs[i] = pair;
  else if (likelyPair(pair)) state.dups.pairs.unshift(pair);
  Object.assign(state.dups.orgs, orgs);
}

/** A merge request as the page says it. */
const askText = (r, v = null) => `${who(r.requestedBy)} asked to merge <b>${esc(v ? nameIn(v, r.from) : dupName(r.from))}</b> into <b>${esc(v ? nameIn(v, r.into) : dupName(r.into))}</b> ${esc(ago(r.requestedAt))}${r.note ? `: <span class="note">${esc(r.note)}</span>` : ''}`;

/** One side of a pair: what the inbox knows of the org. */
function pairSide(o, kept) {
  const page = address({ tab: 'orgs', sel: o.slug, section: 'own' });
  const chans = o.channelNames.map((c) => `<li>${esc(c.label)} <span class="sub">${esc(platform(c))} · ${c.threads} ${c.threads === 1 ? 'thread' : 'threads'}</span>${c.topic ? `<div class="sub">${esc(c.topic)}</div>` : ''}</li>`).join('');
  return `<div class="side${kept ? ' kept' : ''}">
    <div class="inline">${ico(o.icon, o.domain)}<a href="${esc(page)}"><b>${esc(o.name || o.slug)}</b></a>${kept ? '<span class="tag confirmed">kept</span>' : ''}</div>
    <div class="sub mono">${esc(o.slug)}</div>
    <div class="field">
      <label>Type</label><span>${esc(o.type)}</span>
      <label>Channels</label><span>${channelCount(o.channels)}, ${o.threads} ${o.threads === 1 ? 'thread' : 'threads'}${o.latest ? `, latest ${esc(ago(o.latest))}` : ''}</span>
      ${o.domains.length ? `<label>Mail</label><span>${esc(o.domains.join(', '))}</span>` : ''}
    </div>
    ${chans ? `<ul class="chans">${chans}</ul>` : ''}${o.channels > o.channelNames.length ? `<div class="sub">and ${o.channels - o.channelNames.length} more</div>` : ''}
  </div>`;
}

/** What merging would do, from its dry run. */
function mergePreviewText(v) {
  const pr = v.preview;
  if (!pr) return '<span class="sub">Trying it…</span>';
  if (!pr.ok) return `<span class="err">${esc(pr.body.error || `failed (${pr.status})`)}</span>`;
  const { moves, moved = {}, kb = {} } = pr.body;
  const from = nameIn(v, v.from);
  const into = nameIn(v, v.keep);
  const what = {
    mcp_servers: ['MCP server', 'MCP servers'],
    agent_secrets: ['secret', 'secrets'],
    agent_repos: ['repository', 'repositories'],
    person_follows_by: ['person who follows it', 'people who follow it'],
    org_stacks: ['stack drawing', 'stack drawings'],
    portal_requests: ['portal lobby', 'portal lobbies'],
  };
  const along = Object.entries(moved).map(([k, n]) => `${n} ${(what[k] || [k, k])[n === 1 ? 0 : 1]}`);
  return `<ul>
    <li>${moves.length ? `Re-files ${moves.length} ${moves.length === 1 ? 'channel' : 'channels'} under ${esc(into)}: ${moves.slice(0, 6).map((m) => esc(plainName(m.channel))).join(', ')}${moves.length > 6 ? ` and ${moves.length - 6} more` : ''}.` : 'Re-files no channel: it has none with threads.'} What the rules file under ${esc(v.from)} later goes there too.</li>
    ${along.length ? `<li>Gives ${esc(into)} its ${esc(along.join(', '))}.</li>` : ''}
    ${kb.entries ? `<li>Copies the ${kb.entries} entries of its knowledge base that ${esc(into)}'s has not; a file both have stays as ${esc(into)}'s.</li>` : ''}
    <li>${esc(into)} keeps its name, icon and type; ${esc(from)}'s fill in where it has none.</li>
  </ul>`;
}

async function showPair(x, y) {
  const current = loadingPage();
  state.view = null;
  const r = await call(`/api/admin/org-duplicates?pair=${encodeURIComponent(`${x}:${y}`)}`);
  if (!current()) return;
  if (!r.ok) {
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">Duplicates</h1></div><div class="empty">${esc(r.body.error || `Could not load (${r.status}).`)}</div>`;
    return;
  }
  const [pair] = r.body.pairs;
  const { orgs } = r.body;
  updatePair(pair, orgs);
  renderList();
  const keep = keptOf(pair, orgs);
  state.view = {
    target: 'pair', value: `${pair.a}:${pair.b}`, pair, orgs, keep, from: keep === pair.a ? pair.b : pair.a, preview: null, done: null,
  };
  drawPair(state.view);
  if (state.me.admin) previewMerge(state.view);
}

/** The merge's dry run, for the way round picked. */
async function previewMerge(v) {
  v.preview = null;
  const asked = { from: v.from, into: v.keep };
  const pr = await call('/api/admin/org-merge', 'POST', { ...asked, dryRun: true }, { parallel: true, idempotent: true });
  if (v !== state.view || v.from !== asked.from) return;
  v.preview = pr;
  if ($('pPreview')) $('pPreview').innerHTML = mergePreviewText(v);
  if ($('pMerge')) $('pMerge').disabled = !pr.ok;
}

function drawPair(v) {
  const { pair, orgs } = v;
  const admin = Boolean(state.me.admin);
  const asks = pair.requests || [];
  const open = openAsks(pair);
  const mine = open.find((q) => q.requestedBy.email === state.me.email);
  const clef = pair.p === null ? 'Clef has not been asked yet; it is, the next time the list loads.'
    : `Clef says ${pct(pair.p)} that they are one company${pair.stale ? ' (from before their channels changed: it is asked again)' : ''}${pair.checked ? `, asked ${esc(ago(pair.checked))}` : ''}.`;
  const seg = `<span class="seg" id="pKeep">${[pair.a, pair.b].map((s) => `<button type="button" data-keep="${esc(s)}" aria-pressed="${v.keep === s}">${esc(nameIn(v, s))}</button>`).join('')}</span>`;
  let act = '';
  if (v.done) {
    act = `<div class="card"><h2>Merged</h2><p>${esc(nameIn(v, v.done.from))} is part of <a href="${esc(address({ tab: 'orgs', sel: v.done.into, section: 'own' }))}">${esc(nameIn(v, v.done.into))}</a> now${v.done.moves ? `; ${v.done.moves} ${v.done.moves === 1 ? 'channel is' : 'channels are'} re-filed` : ''}${v.done.kb ? `; ${v.done.kb}` : ''}.</p>
      <div class="form"><button id="pUndo"${off(`unmerge:${v.done.from}`)}>Undo the merge</button></div></div>`;
  } else if (admin) {
    act = `<div class="card"><h2>Merge them</h2><div class="field"><label>Keep</label>${seg}</div>
      <div class="preview" id="pPreview">${mergePreviewText(v)}</div>
      <div class="form"><button class="primary" id="pMerge"${v.preview && v.preview.ok ? '' : ' disabled'}${off(`merge:${v.value}`)}>Merge ${esc(nameIn(v, v.from))} into ${esc(nameIn(v, v.keep))}</button>
        ${pair.dismissed ? `<button id="pDismiss" data-undo="1"${off(`dismiss:${v.value}`)}>They may be one after all</button>` : `<button id="pDismiss"${off(`dismiss:${v.value}`)}>Not the same</button>`}</div>
      <p class="hint">${pair.dismissed ? `Said not to be the same by ${who({ email: pair.dismissed.by })} ${esc(ago(pair.dismissed.at))}: the list shows them last, and nobody else sees them unless they ask for a merge.` : 'Not the same takes them off the list, until somebody asks for their merge.'} A merge is undone on the page of the org kept: its channels go back; what moved with it stays.</p></div>`;
  } else if (mine) {
    act = `<div class="card"><h2>Your request</h2><p>${askText(mine, v)}</p><div class="form"><button id="pWithdraw"${off(`ask:${mine.id}`)}>Take it back</button></div></div>`;
  } else if (!open.length) {
    act = `<div class="card"><h2>Ask for a merge</h2><form class="form" id="pAskForm"><div class="fld"><span class="sub">Keep</span>${seg}</div>
      <label class="fld grow"><span>Why they are one (optional)</span><input id="pNote" maxlength="500"></label>
      <button class="primary" id="pAsk"${off(`ask:${v.value}`)}>Ask the admin team</button></form>
      <p class="hint">The admin team merges customers: the one is filed under the other from then on, its channels, knowledge and agents' set-up too. They answer under Requests.</p></div>`;
  }
  // Your own open request is the card that takes it back.
  const listed = asks.filter((q) => q !== mine);
  const asked = listed.length ? `<div class="card"><h2>Asked for</h2><ul class="asks">${listed.map((q) => `<li>${askText(q, v)}${q.status === 'open' ? '' : ` · ${decisionText(q)}`}
      ${admin && q.status === 'open' ? `<form class="form" data-decline="${q.id}"><label class="fld grow"><span>Reason, for ${who(q.requestedBy)} (optional)</span><input maxlength="500"></label><button class="danger"${off(`ask:${q.id}`)}>Decline</button></form>` : ''}</li>`).join('')}</ul></div>` : '';
  $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(dupName(pair.a, orgs))} <span class="sub">and</span> ${esc(dupName(pair.b, orgs))}</h1></div>
    <div class="status" id="status"></div>
    <div class="card"><div class="pair">${pairSide(orgs[pair.a], !v.done && v.keep === pair.a)}${pairSide(orgs[pair.b], !v.done && v.keep === pair.b)}</div></div>
    <div class="card"><h2>Why they may be one</h2><p>${clef}</p>${pair.signals.length ? `<ul>${pair.signals.map((x) => `<li>${esc(x.text[0].toUpperCase() + x.text.slice(1))}.</li>`).join('')}</ul>` : '<p class="sub">Nothing they share says so.</p>'}</div>
    ${asked}${act}`;
  showStatus();
  wirePair(v);
}

/** Closes a pair's open requests in the page's lists, as the Worker did. */
function settleAsks(v, outcome) {
  const now = new Date().toISOString();
  for (const q of openAsks(v.pair)) {
    Object.assign(q, { status: outcome, decidedAt: now, decidedBy: { email: state.me.email, name: state.me.name } });
    const listed = state.orgMerges.find((x) => x.id === q.id);
    if (listed) Object.assign(listed, q);
    if (state.me.admin) state.openRequests = Math.max(0, state.openRequests - 1);
  }
  renderCount();
}

function wirePair(v) {
  const { pair } = v;
  for (const b of $('detail').querySelectorAll('[data-keep]')) {
    b.onclick = () => {
      if (v.keep === b.dataset.keep) return;
      v.keep = b.dataset.keep;
      v.from = v.keep === pair.a ? pair.b : pair.a;
      v.preview = null;
      drawPair(v);
      if (state.me.admin) previewMerge(v);
    };
  }
  if ($('pMerge')) {
    $('pMerge').onclick = () => hold($('pMerge'), `merge:${v.value}`, async () => {
      const [from, into] = [v.from, v.keep];
      const ok = await confirmFirst(`Merge ${nameIn(v, from)} into ${nameIn(v, into)}?`, `${from} is filed under ${into} from now on: its channels, the ones the rules name it later, its agents' set-up and its knowledge. Undo moves its channels back.`, 'Merge');
      if (!ok) return;
      const res = await call('/api/admin/org-merge', 'POST', { from, into });
      if (!res.ok) { failed('Merge', res); return; }
      const { moves, kb = {} } = res.body;
      applyMoves(moves, null);
      settleAsks(v, 'merged');
      state.orgs = state.orgs.filter((o) => o.slug !== from);
      if (state.dups && !state.dups.error) state.dups.pairs = state.dups.pairs.filter((p) => p.a !== from && p.b !== from);
      const copied = kb.copied ? `${kb.copied} knowledge-base ${kb.copied === 1 ? 'entry' : 'entries'} copied` : '';
      const left = kb.kept && kb.kept.length ? `${kb.kept.length} kept in ${from}'s, as ${into}'s has them too` : '';
      v.done = {
        from, into, moves: moves.length, kb: [copied, left, kb.error ? `its knowledge base was not copied: ${kb.error}` : ''].filter(Boolean).join(', '),
      };
      status(kb.error || (kb.failed && kb.failed.length) ? 'warn' : 'ok', `Merged ${nameIn(v, from)} into ${nameIn(v, into)}.`);
      renderList();
      if (v === state.view) drawPair(v);
      // The org kept has the merged one's channels now: the pairs it makes with others come up.
      loadDups({ fresh: true });
    });
  }
  if ($('pUndo')) {
    $('pUndo').onclick = () => hold($('pUndo'), `unmerge:${v.done.from}`, async () => {
      const res = await unmerge(v.done.from);
      if (!res) return;
      v.done = null;
      v.preview = null;
      if (v === state.view) {
        drawPair(v);
        previewMerge(v);
      }
    });
  }
  if ($('pDismiss')) {
    $('pDismiss').onclick = () => hold($('pDismiss'), `dismiss:${v.value}`, async () => {
      const undo = Boolean($('pDismiss').dataset.undo);
      const res = await call('/api/admin/org-duplicates/dismiss', 'POST', { a: pair.a, b: pair.b, undo });
      if (!res.ok) { failed('Save', res); return; }
      pair.dismissed = res.body.dismissed;
      status('ok', undo ? 'Back on the list.' : 'Not the same: off the list.');
      updatePair(pair, v.orgs);
      renderList();
      if (v === state.view) drawPair(v);
    });
  }
  if ($('pAskForm')) {
    $('pAskForm').onsubmit = (e) => {
      e.preventDefault();
      hold($('pAsk'), `ask:${v.value}`, async () => {
        const res = await call('/api/admin/org-merge-requests', 'POST', { from: v.from, into: v.keep, note: $('pNote').value.trim() || undefined });
        if (!res.ok) {
          failed('Ask', res);
          if (res.body.request) pair.requests = [res.body.request, ...(pair.requests || [])];
        } else {
          pair.requests = [res.body.request, ...(pair.requests || [])];
          status('ok', 'Asked: the admin team answers under Requests.');
        }
        updatePair(pair, v.orgs);
        renderList();
        if (v === state.view) drawPair(v);
      });
    };
  }
  if ($('pWithdraw')) {
    const mine = openAsks(pair).find((q) => q.requestedBy.email === state.me.email);
    $('pWithdraw').onclick = () => hold($('pWithdraw'), `ask:${mine.id}`, async () => {
      const res = await call('/api/admin/org-merge-requests', 'DELETE', { id: mine.id });
      if (!res.ok) failed('Take back', res);
      else status('ok', 'Taken back.');
      if (res.body.request) Object.assign(mine, res.body.request);
      updatePair(pair, v.orgs);
      renderList();
      if (v === state.view) drawPair(v);
    });
  }
  for (const form of $('detail').querySelectorAll('[data-decline]')) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const id = Number(form.dataset.decline);
      hold(form.querySelector('button'), `ask:${id}`, async () => {
        const res = await call('/api/admin/org-merge-requests/decline', 'POST', { id, reason: form.querySelector('input').value.trim() || undefined });
        if (!res.ok) { failed('Decline', res); return; }
        const q = (pair.requests || []).find((x) => x.id === id);
        if (q && q.status === 'open' && state.me.admin) state.openRequests = Math.max(0, state.openRequests - 1);
        if (q) Object.assign(q, res.body.request);
        const listed = state.orgMerges.find((x) => x.id === id);
        if (listed) Object.assign(listed, res.body.request);
        renderCount();
        status('ok', 'Declined.');
        updatePair(pair, v.orgs);
        renderList();
        if (v === state.view) drawPair(v);
      });
    };
  }
}

/** Undoes the merge of `slug`: its channels go back. The answer, or null when refused. */
async function unmerge(slug) {
  const res = await call('/api/admin/org-merge', 'DELETE', { slug });
  if (!res.ok) { failed('Undo', res); return null; }
  applyMoves(res.body.moves, null);
  status('ok', `${slug} is an org of its own again${res.body.moves.length ? `; ${res.body.moves.length} ${res.body.moves.length === 1 ? 'channel goes' : 'channels go'} back` : ''}.`);
  const orgs = await call('/api/admin/orgs');
  if (orgs.ok) state.orgs = orgs.body.orgs;
  loadDups({ fresh: true });
  return res.body;
}

/** A merge request in Requests' list. */
const mergeRow = (r) => `<div class="row${String(state.sel) === `${MERGE_REQUEST}${r.id}` ? ' on' : ''}" data-sel="${MERGE_REQUEST}${r.id}">
  <span class="name">${esc(dupName(r.from))} <span class="sub">into ${esc(dupName(r.into))}</span></span>
  ${r.status === 'open' ? '' : statusTag(r)}<span class="sub">${esc(ago(r.status === 'open' ? r.requestedAt : r.decidedAt))}</span></div>`;

/** A merge request picked under Requests: the pair's page while it is open, else what came of it. */
function showMergeRequest(id) {
  const r = state.orgMerges.find((x) => String(x.id) === String(id));
  if (!r) { $('detail').innerHTML = `<div class="empty">${backButton()} No such request.</div>`; return; }
  if (r.status === 'open') { showPair(r.from, r.into); return; }
  loadingPage();
  state.view = null;
  $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(dupName(r.from))} <span class="sub">into</span> ${esc(dupName(r.into))}</h1></div>
    <div class="card"><p>${askText(r)}</p><p>${decisionText(r)}</p>
    <p><a href="${esc(address({ tab: 'orgs', sel: pairSel(r.from, r.into) }))}">The two side by side</a></p></div>`;
}

/**
 * An org's page: the orgs merged into it, each undone here, its likely duplicates, and any
 * other org to compare it with.
 */
function orgMergeCard(slug, merged) {
  const pairs = (state.dups && !state.dups.error ? state.dups.pairs : []).filter((p) => p.a === slug || p.b === slug);
  const others = state.orgs.filter((o) => o.slug !== slug);
  return `<div class="card"><h2>Duplicates</h2>
    ${merged.length ? `<table id="mergedTable"><tr><th>Merged into it</th><th>By</th><th></th></tr>${merged.map((m) => `<tr><td>${esc(m.name || m.slug)} <span class="sub mono">${esc(m.slug)}</span></td>
      <td class="sub">${who({ email: m.merged_by })}, ${esc(ago(m.merged_at))}</td><td class="n"><button class="quiet" data-unmerge="${esc(m.slug)}"${off(`unmerge:${m.slug}`)}>Undo</button></td></tr>`).join('')}</table>` : ''}
    ${pairs.length ? `<ul class="dups">${pairs.map((p) => {
    const other = p.a === slug ? p.b : p.a;
    return `<li><a href="${esc(address({ tab: 'orgs', sel: pairSel(p.a, p.b) }))}">${esc(dupName(other))}</a> <span class="sub">${p.p === null ? 'Clef has not said yet' : `${pct(p.p)} one, says Clef`}${p.dismissed ? ' · not the same' : ''}</span></li>`;
  }).join('')}</ul>` : ''}
    <form class="form" id="oCompare"><label class="fld grow"><span>Compare with another org</span><input id="oOther" list="oOthers" autocomplete="off"></label>
      <datalist id="oOthers">${others.map((o) => `<option value="${esc(o.slug)}">${esc(o.name || '')}</option>`).join('')}</datalist><button>Compare</button></form>
    <p class="hint">Two orgs that are one company: merged, the one is filed under the other from then on, its channels, knowledge and agents' set-up too. Undo moves its channels back.</p></div>`;
}

function wireOrgMerge(slug) {
  for (const b of $('detail').querySelectorAll('[data-unmerge]')) {
    b.onclick = () => hold(b, `unmerge:${b.dataset.unmerge}`, async () => {
      if (!(await unmerge(b.dataset.unmerge)) || !b.isConnected) return;
      const table = b.closest('table');
      b.closest('tr').remove();
      if (table.rows.length < 2) table.remove();
    });
  }
  $('oCompare').onsubmit = (e) => {
    e.preventDefault();
    const typed = $('oOther').value.trim().toLowerCase();
    const o = state.orgs.find((x) => x.slug === typed || (x.name || '').toLowerCase() === typed);
    if (!o || o.slug === slug) { status('err', `No other org ${typed || 'by that name'}.`); return; }
    openUrl(address({ tab: 'orgs', sel: pairSel(slug, o.slug) }));
  };
}

// ---- bots -------------------------------------------------------------------------------
//
// The bots in the threads (src/ourbots.js), under Requests: Adobe's own count as staff, so the
// inbox shows them on Adobe's side, as a colleague; the external ones on the customer's. Bots
// have no mail address, which is how the inbox tells people apart, so an admin says whose each
// is: one that posted and nobody said yet waits as a request. A bot may also only post alerts:
// the threads it starts are alerts (src/alertbots.js).

/** What marks a bot among the requests picked (`?request=bot:slack:T…:B…`). */
const BOT = 'bot:';
/** A bot's name as the inbox shows it: an admin's, else the platform's. */
const botName = (b) => b.displayName || b.name || b.handle || b.id;
/** A bot's picture: an admin's, else the platform's (Slack, Discord), else an empty square. */
const botIco = (b) => {
  const url = b.displayAvatar || b.avatar || '';
  return /^(https:\/\/|\/)/.test(url) ? `<img class="ico" src="${esc(url)}" alt="">` : '<span class="ico none"></span>';
};
/** Whether a bot waits for an admin to say whose it is: nobody did, and it posted. */
const unreviewed = (b) => b.ours === null && b.messages > 0;
const botTags = (b) => [
  b.ours === true ? '<span class="tag ours" title="Adobe\'s: on Adobe\'s side in the inbox">Adobe</span>' : '',
  b.ours === false ? '<span class="tag" title="External: on the customer\'s side in the inbox">External</span>' : '',
  b.alerts ? '<span class="tag alerts" title="Only posts alerts: the threads it starts are alerts">Alerts</span>' : '',
].join('');
const botPosts = (b) => (b.messages ? `${b.messages} ${b.messages === 1 ? 'message' : 'messages'}` : 'mentioned only');
const botMatch = (b, f) => !f || `${b.displayName || ''} ${b.name || ''} ${b.handle || ''} ${b.id} ${platform(b)} ${b.channel || ''} ${b.ours === true ? 'adobe' : ''} ${b.ours === false ? 'external' : ''} ${b.alerts ? 'alerts' : ''}`.toLowerCase().includes(f);
// A bot that waits for a review says where and how much it posted; the others say what was said.
const botRow = (b) => `
      <div class="row${state.sel === `${BOT}${b.key}` ? ' on' : ''}" data-sel="${esc(`${BOT}${b.key}`)}" title="${esc(botName(b))} (${esc(platform(b))}, ${esc(botPosts(b))})">
        ${botIco(b)}<span class="name">${esc(botName(b))}${unreviewed(b) ? ` <span class="sub">${esc(platform(b))}</span>` : ''}</span>
        ${botTags(b)}${unreviewed(b) || !botTags(b) ? `<span class="sub">${esc(botPosts(b))}</span>` : ''}</div>`;

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
          <button type="button" data-ours="0" aria-pressed="${b.ours === false}"${off(`bot:${key}`)}>External</button></span>
        <label>Alerts</label><label class="inline"><input type="checkbox" id="bAlerts"${b.alerts ? ' checked' : ''}${off(`bot:${key}`)}>
          <span>It only posts alerts: the threads it starts are alerts</span></label>
        <label>Posted</label><span>${b.messages ? `${esc(botPosts(b))} in ${b.threads} ${b.threads === 1 ? 'thread' : 'threads'}${where ? `, ${esc(where)}` : ''}` : 'Nothing yet: it was mentioned'}</span>
        ${b.handle && b.handle !== b.name ? `<label>Mentioned as</label><span>@${esc(b.handle)}</span>` : ''}
        <label>Id</label><span class="mono">${esc(b.id)}</span>
        ${b.oursBy ? `<label>Said by</label><span class="sub">${esc(b.oursBy)}, ${esc(ago(b.oursAt))}</span>` : ''}
      </div><p class="hint">${b.ours === null ? 'Nobody said whose this bot is yet, so it waits under Requests. ' : ''}Bots have no mail address, which is how the inbox tells Adobe people from customers, so an admin says which bots are Adobe's and which are external. An Adobe bot's messages show on Adobe's side, as your colleagues' do, the ones it wrote before too${b.staff && !b.ours ? '; this one is there already, by its Discord role' : ''}. They stay a bot's: they are not an answer to the customer, and the thread agents read them as they read every bot's. A bot that only posts alerts starts alerts, also in a channel of conversations: they are counted, not unread, and no agent works them. Its replies in a person's thread leave that a conversation.</p></div>
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
    // Saying whose it is answers its request: Requests in the header counts one less.
    const said = (res) => {
      const waited = unreviewed(b);
      Object.assign(b, res.body.bot);
      if (waited && !unreviewed(b)) state.openRequests = Math.max(0, state.openRequests - 1);
      renderCount();
      renderList();
    };
    // Drawn again once the save is done, so its controls are not drawn as busy.
    const redraw = () => { if (v === state.view) draw(); };
    for (const btn of $('bOurs').querySelectorAll('[data-ours]')) {
      btn.onclick = () => hold(btn, `bot:${key}`, async () => {
        const ours = btn.dataset.ours === '1';
        if (ours === b.ours) return;
        const res = await call('/api/admin/bots', 'PUT', { key, ours });
        if (!res.ok) { failed('Save', res); return; }
        said(res);
        status('ok', ours ? `${botName(b)} is Adobe's now.` : `${botName(b)} is external now.`);
      }).then(redraw);
    }
    $('bAlerts').onchange = (e) => hold(e.target, `bot:${key}`, async () => {
      const alerts = e.target.checked;
      const res = await call('/api/admin/bots', 'PUT', { key, alerts });
      if (!res.ok) { failed('Save', res); return; }
      said(res);
      const jobs = res.body.refile ? ': re-filing the threads it started' : '';
      status('ok', alerts ? `${botName(b)} only posts alerts now${jobs}.` : `${botName(b)} posts more than alerts now${jobs}.`);
    }).then(redraw);
  };
  draw();
  if (!b.messages) return;
  call(`/api/admin/bot?key=${encodeURIComponent(key)}`).then((r) => {
    v.recent = r.ok ? r.body.recent : { error: r.body.error || `Could not load its messages (${r.status}).` };
    if (v === state.view) draw();
  });
}

// ---- admin accounts ---------------------------------------------------------------------
//
// The Teams tenant that hosts the teams has admin accounts of its own (src/accountlinks.js):
// `owner_` and the initials of the Adobe person who uses one. They are Adobe's by themselves,
// but nothing says whose: an admin gives each the mail address of its person, and the inbox
// shows it as them, the messages it wrote before too.

/** What marks an account among the requests picked (`?request=account:teams:…`). */
const ACCOUNT = 'account:';
const accountName = (a) => a.name || a.email || a.id;
const accountPosts = (a) => (a.messages ? `${a.messages} ${a.messages === 1 ? 'message' : 'messages'}` : 'no messages');
const accountMatch = (a, f) => !f || `${a.name || ''} ${a.email || ''} ${a.person?.name || ''} ${a.person?.email || ''} admin account`.toLowerCase().includes(f);
const accountRow = (a) => `
      <div class="row${state.sel === `${ACCOUNT}${a.key}` ? ' on' : ''}" data-sel="${esc(`${ACCOUNT}${a.key}`)}" title="${esc(accountName(a))} (${esc(platform(a))} admin account, ${esc(accountPosts(a))})">
        <span class="ico none"></span><span class="name">${esc(accountName(a))}${a.person ? ` <span class="sub">${esc(a.person.name || a.person.email)}</span>` : ''}</span>
        <span class="tag ours" title="Adobe's: on Adobe's side in the inbox">Adobe</span><span class="sub">${esc(accountPosts(a))}</span></div>`;

function showAccount(key) {
  const a = state.accounts.find((x) => x.key === key);
  if (!a) { $('detail').innerHTML = `<div class="empty">${backButton()} No such account.</div>`; return; }
  note = { kind: '', text: '' };
  state.view = { target: 'account', value: key, account: a };
  const v = state.view;
  const draw = () => {
    const whose = a.person ? `${a.person.name ? `${esc(a.person.name)} <span class="sub mono">${esc(a.person.email || '')}</span>` : `<span class="mono">${esc(a.person.email || '')}</span>`}` : '<span class="sub">Nobody said yet</span>';
    $('detail').innerHTML = `
      <div class="title">${backButton()}<span class="ico none"></span><h1 class="fill">${esc(accountName(a))}</h1><span class="sub">${esc(platform(a))} admin account</span></div>
      <div class="status" id="status"></div>
      <div class="card"><div class="field">
        <label>Whose</label><span>${whose}</span>
        <label>Posted</label><span>${a.messages ? `${esc(accountPosts(a))}${a.latest ? `, latest ${esc(ago(a.latest))}` : ''}` : 'Nothing yet'}</span>
        <label>Account</label><span class="mono">${esc(a.email || a.id)}</span>
        ${a.linkedBy ? `<label>Said by</label><span class="sub">${esc(a.linkedBy)}, ${esc(ago(a.linkedAt))}</span>` : ''}
      </div>
      <div class="form picker"><label class="fld grow"><span>${a.person ? 'Someone else\'s: their name or mail address' : 'Whose it is: their name or mail address'}</span><input id="aFind" autocomplete="off"></label><div class="picks s2-float" id="aPicks" hidden></div>
        ${a.person ? `<button type="button" id="aUnlink"${off(`account:${key}`)}>Nobody's</button>` : ''}</div>
      <p class="hint">An admin account of the Teams tenant that hosts the teams: Adobe's, so its messages show on Adobe's side, but it is named by initials, and nothing in Teams says whose it is. Give the colleague who uses it: the inbox then shows it as them, with their name and picture, the messages it wrote before too, and counts it as one of their accounts, after their own.</p></div>`;
    showStatus();
    const save = (email) => once(`account:${key}`, async () => {
      const res = await call('/api/admin/accounts', 'PUT', { key, email });
      if (!res.ok) { failed('Save', res); return; }
      Object.assign(a, res.body.account);
      status('ok', a.person ? `${accountName(a)} is ${a.person.name || a.person.email}'s now.` : `${accountName(a)} is nobody's now.`);
      renderList();
    }).then(() => { if (v === state.view) draw(); });
    if ($('aUnlink')) $('aUnlink').onclick = () => save(null);
    wirePersonPicker($('aFind'), $('aPicks'), (p) => save(p.email));
  };
  draw();
}

/**
 * A field that finds a colleague (GET /api/admin/people), or takes a full mail address, and
 * gives the one picked to `pick`: only staff are offered.
 */
function wirePersonPicker(input, picks, pick) {
  let timer;
  let list = [];
  let at = 0;
  const choose = (p) => { picks.hidden = true; input.value = ''; list = []; pick(p); };
  const render = () => {
    picks.innerHTML = list.map((p, i) => `<div class="row${i === at ? ' on' : ''}" data-i="${i}">
      <span class="name">${p.name ? esc(p.name) : `<i>${esc(p.email)}</i>`} ${p.name ? `<span class="sub mono">${esc(p.email)}</span>` : ''}</span></div>`).join('')
      || '<div class="empty pad">No colleague matches. Type their full mail address.</div>';
    placePicks(input, picks);
    picks.hidden = false;
    for (const el of picks.querySelectorAll('[data-i]')) {
      // eslint-disable-next-line no-loop-func
      el.onmousedown = (e) => { e.preventDefault(); choose(list[Number(el.dataset.i)]); };
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { picks.hidden = true; list = []; return; }
    timer = setTimeout(async () => {
      const r = await call(`/api/admin/people?q=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return;
      list = (r.body.people || []).filter((p) => p.staff);
      const email = q.toLowerCase();
      if (EMAIL.test(email) && !list.some((p) => p.email === email)) list.push({ email, name: null });
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
      choose(list[at]);
    } else if (e.key === 'Escape') {
      picks.hidden = true;
    }
  };
  input.onblur = () => setTimeout(() => { picks.hidden = true; }, 150);
}

// ---- start ------------------------------------------------------------------------------

(async () => {
  // Another team, org, request or section fades in (ui/app.js).
  Swap.watch($('detail'), () => `${state.tab}|${state.sel ?? ''}|${state.section === 'history' ? 'kb' : state.section ?? ''}`);
  const me = await call('/api/me');
  if (!me.ok) { $('list').innerHTML = `<div class="empty">${esc(me.body.error || 'Not signed in.')}</div>`; return; }
  state.me = me.body;
  Header.user(state.me, Header.role(state.me) || (state.me.teams?.length ? 'Read-only' : ''));
  if (!state.me.admin && !state.me.manages?.length && !state.me.teams?.length) {
    $('list').innerHTML = '<div class="empty">These pages are for the members of an ops team.</div>';
    $('detail').innerHTML = '<div class="empty"><a href="/inbox">Back to the inbox</a></div>';
    return;
  }
  Header.init(state.me, {
    count: false, // renderCount, from the requests loaded here
    // The inbox, not opened yet in this browser tab (ui/header.js keeps it as it was left): the
    // team picked's.
    fallback: { inbox: () => (state.tab === 'teams' && state.sel && state.sel !== UNASSIGNED ? `/inbox?team=${encodeURIComponent(state.sel)}` : null) },
    // Leaving saves what the agent has open, and asks, in the page, about edits that cannot be
    // saved; a new tab (⌘-click, middle click) leaves nothing.
    go: async (id, url) => {
      if (['teams', 'orgs', 'requests'].includes(id)) openUrl(url);
      else if (await Agent.leave()) location.assign(url);
    },
  });
  if (!(await load())) return;
  Agent.init(state.me, state.bases, {
    // The agent's address: the view and the file it has open, in the page's.
    onUrl: (mode) => {
      const w = Agent.where();
      const b = baseOf(state.tab, state.sel);
      if (!b || w.repo !== b.repo || !SECTIONS.includes(state.section)) return;
      state.section = w.view === 'file' ? 'kb' : w.view;
      state.path = w.path;
      toUrl(mode);
      drawSections();
    },
    // Its switches change what the tabs and the list count.
    onChange: () => {
      drawSections();
      renderList();
    },
    // A file it names (a technology of the team's catalog), in the knowledge base.
    onOpen: (view, path) => openUrl(address({ section: view === 'file' ? 'kb' : view, path })),
  });
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
    if (e.target.closest('[data-back]')) {
      Agent.leave().then((left) => { if (left) unselect(); });
      return;
    }
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
