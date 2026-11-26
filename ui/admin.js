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
 * or declines the requests in its inbox, where each is a thread (src/requestthreads.js); the rest
 * is for the admin team. Customers ask too, from the customer portal, for a channel: the admin
 * team opens one from its thread, and a team's managers on their team's page, when the team
 * follows a technology the customer picked.
 *
 * Teams: create, rename and delete teams; add members (found by name or email) and remove
 * them; the rules that file channels under the team (a channel-name prefix like `aem-`, a
 * Teams team name, a Slack Connect team id); and manual assignments of single channels, one of
 * which moves a channel to the team picked under its name (`moveMenu`). Orgs: display name, icon and
 * type (customer, partner, vendor), and manual assignments. The bots (which are Adobe's, which
 * external, which only post alerts, src/ourbots.js), the admin accounts and the conflicts between
 * the teams' technologies and rules are threads of the admin team's inbox too, with the other
 * requests. Changes apply at once, without
 * asking (the status line names the channels a rule change moved), and go to the API one
 * after the other, so many can be made in a row (see `serial`). Text fields save when they
 * change. A change updates the open page in place (see "view state"); nothing reloads.
 *
 * A team's page opens at its overview, everyone's at Adobe (see "a team's overview", ui/team.js):
 * its people, customers, collaborators, technologies and knowledge base. What changes the team
 * is its second section, Manage (`own`, `view=manage`), its managers' and the admin team's. A
 * customer's page opens at its overview too (see "a customer's overview", ui/customer.js): its
 * people, Adobe's and the teams on it, what it asks about, its channels, technologies and
 * knowledge base. Its Manage section (who follows it, its channels; its name, icon and type for
 * the admin team) is for the members of the ops teams.
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
  // Every ops team (GET /api/teams): the list of the teams you do not manage.
  directory: [],
  requests: [], openRequests: 0, names: {}, noIcon: false,
  // The Customers list's filter (its footer): one type of org, or all of them.
  orgType: '',
  // The people thread agents asked to be added to a team (src/memberrequests.js), on team pages.
  memberRequests: [],
  // The customers waiting in the customer portal, and whether it is connected to this inbox.
  portal: [], portalBound: false,
  // The team wizard's groups of the admin team's channels (GET /api/admin/team-groups): the
  // ones offered, the dismissed ones, and how much of the admin team's channels it saw.
  groups: [], dismissedGroups: [], groupCoverage: null,
  // The pairs of orgs that may be one (GET /api/admin/org-duplicates), whether the list shows the
  // less likely ones too, and the merges asked for (the admin team's, threads of its inbox).
  dups: null, orgMerges: [],
  // The pairs of a customer and a partner that may work together (GET /api/admin/org-partners),
  // for the admin team.
  links: null,
  // The channels no rule files under an org (GET /api/admin/orgs `unassigned`): how many.
  orgsUnassigned: null,
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
  const title = icon || domain;
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
/** An icon suggestion as tall as one, unseen: the suggestions keep their height while they load,
    and when there are none, so that what is under them does not move. */
const ICON_GHOST = `<button type="button" class="iconpick ghost" tabindex="-1" aria-hidden="true" disabled>
  <span class="ph"></span><span class="host">&nbsp;</span><span class="sub">&nbsp;</span></button>`;

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
  el.textContent = [...failures, note.text, saving].filter(Boolean).join(' ');
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
  // A change makes what was read ahead old (see "read ahead"), once it is sent and once it is done.
  if (method !== 'GET') forget();
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
  if (method === 'GET') return attempt();
  const done = parallel ? attempt() : serial(attempt);
  return done.finally(forget);
}

// ---- read ahead ---------------------------------------------------------------------------
//
// What the sections of a team's and a customer's page show (their overview and their Manage
// section, GET /api/teams/profile, /api/customers/profile, /api/admin/team, /api/admin/org, and
// the stack drawing) is read ahead, so that going to another section or another team shows it
// at once: the sections of what is picked once it is shown (`readAhead`), a section's tab or a
// row of the list when the pointer rests on it or it has the focus (`warm`). An answer is kept
// for KEEP_MS, and every change made here (`call` with another method, the agent's too) forgets
// all of them: what a change does is never shown from before it.

const KEEP_MS = 60000;
/** A path → `{ at, read }`: when it was asked for, and the answer (a promise of it). */
const ahead = new Map();
/** Counts the changes sent and done: an answer asked for before one is not kept. */
let changes = 0;
function forget() {
  changes += 1;
  ahead.clear();
  // The agent's counts and switches (channels it has, say) are read again too.
  Agent.stale();
}
/**
 * A GET as `call` answers it, read once in KEEP_MS (and while it is on its way); every caller
 * gets a copy of its own, which it may change. A failure is not kept.
 */
function cached(path) {
  let k = ahead.get(path);
  if (!k || Date.now() - k.at > KEEP_MS) {
    const before = changes;
    const read = call(path);
    k = { at: Date.now(), read };
    ahead.set(path, k);
    read.then((r) => { if ((!r.ok || changes !== before) && ahead.get(path)?.read === read) ahead.delete(path); });
  }
  return k.read.then((r) => structuredClone(r));
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

/** Whether you are on an ops team (the admin team is one): Customers' Manage is theirs. */
const onATeam = () => Boolean(state.me.admin) || (state.me.teams || []).length > 0;

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
  status('ok', moves.length ? `${what}: re-filing ${moves.length} channel${moves.length === 1 ? '' : 's'}${which}.` : `${what}: saved.`);
  return done.body;
}

// ---- navigation ---------------------------------------------------------------------------

// What is picked on each tab, in the URL.
const PARAM = { teams: 'team', orgs: 'org' };
const PICK = { teams: 'a team', orgs: 'a customer' };
/** The tabs whose rows have an agent: a team's, a customer's. */
const AGENTED = ['teams', 'orgs'];
/** A suggested team of the team wizard, picked in Teams (see "the team wizard"). */
const isGroup = (sel) => String(sel ?? '').startsWith(GROUP);
/** Two orgs that may be one, picked in Customers (see "duplicate customers"). */
const isPair = (sel) => String(sel ?? '').startsWith(PAIR);
/** Whether `sel` on `tab` is a team or a customer, whose page has an agent's sections. */
const agented = (tab, sel) => AGENTED.includes(tab) && !isGroup(sel) && !isPair(sel) && !isDomains(sel)
  && !isLink(sel);

/**
 * The address of what is picked (`sel` on `tab`), at a section of its page (`view`, none for its
 * own) and the file open there (`path`).
 */
function address({
  tab = state.tab, sel = state.sel, section = state.section, path = state.path,
} = {}) {
  const q = new URLSearchParams({ tab });
  if (sel) q.set(PARAM[tab], sel);
  // A team's page and a customer's open at their overview; what changes them is `manage`.
  if (sel && agented(tab, sel) && section === 'own' && sel !== UNASSIGNED) q.set('view', 'manage');
  else if (sel && agented(tab, sel) && section && !['own', 'overview'].includes(section)) {
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
  if (tab !== 'orgs') tab = 'teams';
  sel = sel || q.get(PARAM[tab]);
  const view = q.get('view');
  const legacy = Boolean(q.get('repo') || q.get('path'));
  let section = SECTIONS.includes(view) ? view : null;
  if (view === 'manage') section = 'own';
  if (view === 'vendors' && tab === 'teams') section = 'vendors';
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
 * Teams and Customers are pages of the header (ui/header.js), each opening as it
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
  const [teams, orgs, requests, bases, follows, directory] = await Promise.all([
    state.me.admin || state.me.manages?.length ? call('/api/admin/teams') : none,
    // Adobe's people on no team: every customer, whose overview they see.
    call(onTeam ? '/api/admin/orgs' : '/api/customers'),
    state.me.admin ? call('/api/admin/requests') : none,
    call('/api/kb'),
    call('/api/follows'),
    // Every team, whose overview everyone at Adobe sees.
    call('/api/teams')]);
  if (!teams.ok) { $('list').innerHTML = `<div class="empty">${esc(teams.body.error || 'Could not load.')}</div>`; return false; }
  // In place: the agent (ui/agent.js) counts on the same list.
  state.bases.splice(0, state.bases.length, ...(bases.ok ? bases.body.bases : []));
  state.teams = teams.body.teams || [];
  state.directory = directory.ok ? directory.body.teams || [] : [];
  state.names = teams.body.names || {};
  state.requests = requests.body.requests || [];
  state.memberRequests = requests.body.memberRequests || [];
  state.portal = requests.body.portal || [];
  state.orgMerges = requests.body.orgMerges || [];
  state.portalBound = Boolean(requests.body.portalBound);
  state.openRequests = requests.body.open ?? teams.body.requests ?? 0;
  renderCount();
  state.unassigned = teams.body.unassigned;
  state.orgs = orgs.body.orgs || [];
  state.orgsUnassigned = state.me.admin ? orgs.body.unassigned || null : null;
  // What you and your teams follow and mute (ui/follow.js): every Follow button here.
  Follow.set(follows.ok ? follows.body : null);
  state.types = orgs.body.types || ['customer', 'partner', 'vendor'];
  if (state.me.admin) loadGroups();
  // The duplicate customers are for the ops teams, who ask for a merge.
  if (onTeam) loadDups();
  // Which customers each partner works for: the admin team's review.
  if (state.me.admin) loadLinks();
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

/** A row of the list picked: what the agent has open is saved first, or you stay. */
async function pickRow(sel) {
  if (await Agent.leave()) select(sel);
}

/**
 * Redraws the list on the left, which every change does for its counts, keeping what is
 * being typed in its fields (a new team's name, say) and where the cursor is.
 */
/**
 * The knowledge base's sidebar (ui/kbchat.js): the agent of the team or the customer picked,
 * where it has a knowledge base, which everyone on a team reads (GET /api/kb); else none. It
 * changes it only for those who may write it.
 */
function showChat() {
  const { tab, sel } = state;
  const b = sel && agented(tab, sel) && sel !== UNASSIGNED ? baseOf(tab, sel) : null;
  KbChat.show(b && { ...b, name: tab === 'teams' ? teamLabel(sel) : orgLabel(sel) });
}

function renderList() {
  showChat();
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

// ---- the list on the left: the sidebar (ui/sidenav.js) ---------------------------------
//
// One line a row, ranked by activity (the threads with a person's message in the last 30
// days, `recent`) unless the sort menu in its footer asks for names in order. What waits for the
// admin team (the channels with no org or no team, the likely duplicates, the suggested teams)
// is at the top; then yours (the teams you are on or manage, the customers you follow), then the
// others. A customer's type and whether it has an icon are the footer's filter; the rest of what
// a row has to say is its title, and its page.

/** How busy a row is, as its title says it. */
const activityTitle = (x) => (x.recent === undefined || x.recent === null ? ''
  : `${x.recent} ${x.recent === 1 ? 'thread' : 'threads'} active in the last 30 days${x.latest ? `, the last message ${ago(x.latest)}` : ''}`);
/** What a row says of itself, on one line, as its title. */
const rowTitle = (...parts) => parts.filter(Boolean).join(', ');
/** A list in the sidebar's order (ui/sidenav.js, `rank`). */
const ranked = (list, name) => SideNav.rank(list, SideNav.sortOf(state.tab), {
  activity: (x) => x.recent, latest: (x) => x.latest, name,
});
const orgName = (o) => o.name || o.slug;

/** Whether you follow customer `slug` yourself (ui/follow.js): its threads in your personal view. */
const followsOrg = (slug) => Follow.follows('org', slug);

/** An org's row in the Customers list: its icon, its name, how busy it is. */
const orgRow = (o) => SideNav.row({
  sel: o.slug,
  on: state.sel === o.slug,
  lead: ico(o.icon, o.domain),
  label: orgName(o),
  title: rowTitle(
    o.name ? `${o.name} (${o.slug})` : o.slug,
    o.type !== 'customer' && o.type,
    o.channels !== undefined && channelCount(o.channels),
    followsOrg(o.slug) && 'following',
    Follow.muted('org', o.slug) && 'muted',
    o.base && Agent.activity(o.base),
    activityTitle(o),
  ),
  count: o.recent ?? '',
  countTitle: activityTitle(o),
});

/** A team's row: its letter, its name, how busy it is. */
function teamRow(t) {
  const b = baseOf('teams', t.slug);
  const people = t.members !== undefined ? peopleCount(t.members) : '';
  const chans = t.channels !== undefined ? `${channelCount(t.channels)}${t.shared ? ` + ${t.shared} shared` : ''}` : '';
  const agents = b && b.agents ? `agent in ${channelCount(b.agents)}` : '';
  return SideNav.row({
    sel: t.slug,
    on: state.sel === t.slug,
    lead: SideNav.tile(t.name),
    label: t.name,
    title: rowTitle(
      `${t.name} (${t.slug})`,
      t.self_managed && 'self-managed',
      people,
      chans,
      agents,
      b && Agent.activity(b),
      activityTitle(t),
    ),
    count: t.recent ?? '',
    countTitle: activityTitle(t),
  });
}

/** A section of rows under its header, or what it says when nothing matches. */
const navSection = (title, rows, { empty = '', hint = '' } = {}) => (rows.length || empty
  ? `<h2 class="navhead"${hint ? ` title="${esc(hint)}"` : ''}>${esc(title)}</h2>${rows.join('') || `<div class="navempty">${esc(empty)}</div>`}` : '');

/** The sidebar's frame, once per tab: its search field and add button stay as you type. */
function listFrame() {
  const el = $('list');
  if ($('navList') && el.dataset.tab === state.tab) return;
  el.dataset.tab = state.tab;
  el.classList.add('sidenav');
  const search = state.tab === 'teams'
    ? `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter teams" value="${esc(state.filter)}"></label>`
    : `<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter customers" value="${esc(state.filter)}"></label>`;
  const add = state.me.admin ? SideNav.add(state.tab === 'teams' ? 'New team' : 'New org') : '';
  el.innerHTML = `<div class="navtop">${search}${add}</div><div class="navlist" id="navList"></div><div id="navFoot"></div>`;
  if ($('navAdd')) $('navAdd').onclick = () => newForm($('navAdd'));
  $('filter').oninput = (e) => {
    state.filter = e.target.value;
    renderList();
  };
}

const ORG_TYPE_LABEL = {
  customer: 'Customers', partner: 'Partners', vendor: 'Vendors', internal: 'Internal',
};
const orgTypeLabel = (t) => ORG_TYPE_LABEL[t] || `${t[0].toUpperCase()}${t.slice(1)}`;
/** The org types there are, as the filter offers them. */
const orgTypes = () => [...new Set([...state.types, ...state.orgs.map((o) => o.type)])].filter(Boolean);

/** The Customers footer's filter: a type, and (the admin team's) only those without an icon. */
function orgFilter(button) {
  const groups = [{
    title: 'Type',
    items: [{ id: 'type:', label: 'All types', checked: !state.orgType },
      ...orgTypes().map((t) => ({
        id: `type:${t}`, label: orgTypeLabel(t), detail: String(state.orgs.filter((o) => o.type === t).length), checked: state.orgType === t,
      }))],
  }];
  if (state.me.admin) {
    groups.push({
      items: [{
        id: 'noicon', label: 'Without an icon', detail: String(state.orgs.filter(iconless).length), checked: state.noIcon, check: true,
      }],
    });
  }
  SideNav.menu(button, groups, (id) => {
    if (id === 'noicon') state.noIcon = !state.noIcon;
    else state.orgType = id.slice('type:'.length);
    renderList();
  });
}

function drawList() {
  listFrame();
  const f = state.filter.toLowerCase();
  const matches = (x) => !f || `${x.name || ''} ${x.slug}`.toLowerCase().includes(f);
  let body;
  let foot;
  if (state.tab === 'teams') {
    // Every team: the directory's (everyone's, with how busy each is), with what the admin API
    // says of those you manage; you see the overview of the others, and their agents read-only.
    const managed = new Map(state.teams.map((t) => [t.slug, t]));
    const listed = state.directory.length ? state.directory
      : state.bases.filter((b) => b.kind === 'team').map((b) => ({ slug: b.slug, name: b.name }));
    const all = [...listed.map((t) => ({ ...t, ...managed.get(t.slug) })),
      ...state.teams.filter((t) => !listed.some((x) => x.slug === t.slug))].filter(matches);
    const mine = new Set([...(state.me.teams || []).map((t) => t.slug), ...(state.me.manages || [])]);
    const yours = ranked(all.filter((t) => mine.has(t.slug)), (t) => t.name);
    const others = ranked(all.filter((t) => !mine.has(t.slug)), (t) => t.name);
    const un = state.unassigned && state.unassigned.channels && (!f || 'unassigned'.includes(f))
      ? SideNav.todo({
        sel: UNASSIGNED, on: state.sel === UNASSIGNED, label: 'Unassigned channels', count: state.unassigned.channels, title: 'Channels not filed under a team',
      }) : '';
    body = `${un}${state.me.admin ? groupList(f) : ''}
      ${navSection('Your teams', yours.map(teamRow))}
      ${navSection(yours.length ? 'Other teams' : 'Teams', others.map(teamRow), { empty: f ? 'Nothing matches.' : (yours.length ? '' : 'No teams.') })}`;
    foot = SideNav.foot('teams');
  } else {
    const shown = (o) => matches(o) && (!state.orgType || o.type === state.orgType) && (!state.noIcon || iconless(o));
    const orgs = state.orgs.filter(shown);
    const followed = ranked(orgs.filter((o) => followsOrg(o.slug)), orgName);
    let middle = '';
    let rest = orgs.filter((o) => !followsOrg(o.slug));
    if (!state.me.admin && onATeam()) {
      // The customers your teams own (their agents, which their managers change): of the
      // customers' knowledge bases, which everyone on a team reads, those you write.
      const ours = state.bases.filter((b) => b.kind === 'org' && b.write && !followsOrg(b.slug))
        .map((b) => ({ ...(state.orgs.find((o) => o.slug === b.slug) || { slug: b.slug, name: b.name, type: 'customer' }), base: b }))
        .filter(shown);
      const slugs = new Set(ours.map((o) => o.slug));
      rest = rest.filter((o) => !slugs.has(o.slug));
      middle = navSection('Your teams\' customers', ranked(ours, orgName).map(orgRow), {
      });
    }
    const un = state.me.admin && state.orgsUnassigned && state.orgsUnassigned.channels && (!f || 'unassigned'.includes(f))
      ? SideNav.todo({
        sel: UNASSIGNED, on: state.sel === UNASSIGNED, label: 'Unassigned channels', count: state.orgsUnassigned.channels, title: 'Channels not filed under an org',
      }) : '';
    const yours = followed.length || middle;
    body = `${un}${domainsRow(f)}${onATeam() ? dupSection(f) : ''}${state.me.admin ? linkSection(f) : ''}
      ${navSection('Following', followed.map(orgRow))}${middle}
      ${navSection(yours ? 'Other customers' : 'Customers', ranked(rest, orgName).map(orgRow), { empty: f || state.orgType || state.noIcon ? 'Nothing matches.' : (yours ? '' : 'No customer yet.') })}`;
    const label = [state.orgType ? orgTypeLabel(state.orgType) : 'All types', state.noIcon && 'no icon'].filter(Boolean).join(', ');
    foot = SideNav.foot('orgs', { filter: { label, on: Boolean(state.orgType || state.noIcon) } });
  }
  SideNav.fill($('navList'), body);
  $('navFoot').outerHTML = `<div id="navFoot">${foot}</div>`;
  const redraw = () => renderList();
  SideNav.wire($('list'), redraw);
  if ($('list').querySelector('[data-nav-filter]')) $('list').querySelector('[data-nav-filter]').onclick = (e) => orgFilter(e.currentTarget);
  for (const el of $('navList').querySelectorAll('[data-sel]')) el.onclick = () => pickRow(el.dataset.sel);
}

/**
 * The admin team's form for a new team or a new org, in a Popover under the add button: what
 * it was made with goes back into it when it could not be.
 */
function newForm(button) {
  const el = openPop(button);
  if (!el) return;
  el.classList.add('newpop');
  if (state.tab === 'teams') {
    el.innerHTML = `<form class="form" id="newTeam"><p class="what">New team</p><label class="fld grow"><span>Name</span><input id="ntName" required></label>
        <label class="fld"><span>Slug</span><input id="ntSlug" pattern="[a-z0-9][a-z0-9-]*" required></label><button class="primary">Create</button></form>
      <div class="status err" id="listStatus">${esc(state.listError)}</div>`;
    $('ntName').oninput = () => { if (!$('ntSlug').dataset.touched) $('ntSlug').value = $('ntName').value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
    $('ntSlug').oninput = () => { $('ntSlug').dataset.touched = '1'; };
    $('newTeam').onsubmit = async (e) => {
      e.preventDefault();
      const body = { slug: $('ntSlug').value, name: $('ntName').value };
      const r = await call('/api/admin/teams', 'POST', body);
      if (!r.ok) {
        listError(`${body.name}: ${r.body.error || `failed (${r.status})`}`);
        return;
      }
      state.listError = '';
      el.hidePopover();
      state.teams.push({
        ...r.body.team, members: 0, rules: 0, channels: 0, threads: 0, recent: 0,
      });
      state.teams.sort((x, y) => x.name.localeCompare(y.name));
      select(r.body.team.slug);
    };
  } else {
    el.innerHTML = `<form class="form" id="newOrg"><p class="what">New org</p><label class="fld grow"><span>Display name</span><input id="noName" required></label>
        <label class="fld"><span>Type</span><select id="noType">${state.types.map((t) => `<option>${t}</option>`).join('')}</select></label><button class="primary">Create</button></form>
      <div class="status err" id="listStatus">${esc(state.listError)}</div>`;
    $('newOrg').onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: $('noName').value, type: $('noType').value };
      const r = await call('/api/admin/orgs', 'POST', body);
      if (!r.ok) {
        listError(`${body.name}: ${r.body.error || `failed (${r.status})`}`);
        return;
      }
      state.listError = '';
      el.hidePopover();
      state.orgs.push({
        ...r.body.org, channels: 0, threads: 0, recent: 0,
      });
      state.orgs.sort((x, y) => (x.name || x.slug).localeCompare(y.name || y.slug));
      select(r.body.org.slug);
    };
  }
  placePop(el, button);
  el.querySelector('input').focus();
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
  else if (state.tab === 'orgs' && isDomains(sel)) showDomains();
  else if (state.tab === 'orgs' && isLink(sel)) showLink(...String(sel).slice(LINK.length).split(':'));
  else if (agented(state.tab, sel)) showPicked({ channel, flash, fresh: true });
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
const inKb = (section) => section === 'kb' || section === 'history';

/** The knowledge base of a team (`teams`) or a customer (`orgs`), where you see one. */
const baseOf = (tab, slug) => state.bases.find((b) => b.kind === (tab === 'orgs' ? 'org' : 'team') && b.slug === slug) || null;

/**
 * The sections of a team's or a customer's page that you see, the one it opens at first: its
 * own where it is yours (a team you manage, Unassigned, any for the admin team), then its
 * agent's where it has a knowledge base.
 */
function sectionsOf(tab, slug) {
  // A customer's own section is every ops team member's: who follows it, and its channels; the
  // admin team edits its name, icon and type there too.
  const own = tab === 'teams' ? state.teams.some((t) => t.slug === slug) || (slug === UNASSIGNED && state.me.admin)
    : Boolean(state.me.admin) || (onATeam() && slug !== UNASSIGNED && state.orgs.some((o) => o.slug === slug));
  const b = baseOf(tab, slug);
  return [
    // A team's and a customer's overview, everyone's (ui/team.js, ui/customer.js); then what
    // changes them.
    ...(slug !== UNASSIGNED ? ['overview'] : []),
    // A team's vendors, everyone's too (ui/team.js `TeamView.vendors`).
    ...(tab === 'teams' && slug !== UNASSIGNED ? ['vendors'] : []),
    ...(own ? ['own'] : []),
    ...(b ? ['agents', 'mcp', ...(b.kind === 'team' ? ['extraction'] : []), 'kb', 'history'] : []),
  ];
}

/** The tabs of the sections, the open one current, the agent's badges once they are read. */
function sectionTabs() {
  const b = baseOf(state.tab, state.sel);
  const tags = b ? Agent.tags(b.repo) : {};
  const label = {
    overview: 'Overview', vendors: 'Vendors', own: 'Manage', ...SECTION_LABEL,
  };
  const open = state.section === 'history' ? 'kb' : state.section;
  return sectionsOf(state.tab, state.sel).filter((x) => x !== 'history').map((x) => `<a href="${esc(address({ section: x, path: null }))}"
    data-section="${x}"${open === x ? ' aria-current="page"' : ''}><span>${esc(label[x])}</span>${tags[x] || ''}</a>`).join('');
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
 * reads the agent again (another team or customer was picked); another section shows what was
 * read of it, unless it is old (ui/agent.js, `META_MAX_AGE`).
 */
function showPicked({ channel = null, flash = null, fresh = false } = {}) {
  const { tab, sel, section } = state;
  const b = baseOf(tab, sel);
  if (!sectionsOf(tab, sel).length) {
    // Neither yours to manage nor with a knowledge base you see.
    loadingPage();
    state.view = null;
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(tab === 'teams' ? teamLabel(sel) : orgLabel(sel))}</h1></div>
      <div class="empty">${tab === 'teams' ? 'This team has no knowledge base yet.' : 'No knowledge base yet.'}</div>`;
    return;
  }
  if (section === 'overview' || section === 'own' || section === 'vendors') {
    let shown;
    if (section === 'vendors') shown = showVendors(sel);
    else if (section === 'overview' && tab === 'teams') shown = showOverview(sel);
    else if (section === 'overview') shown = showOrgOverview(sel);
    else if (tab === 'teams') shown = showTeam(sel);
    else shown = showOrg(sel);
    // The agent's badges, on its tabs.
    if (b) Agent.load(b.repo, { fresh });
    readAhead(shown);
    return;
  }
  loadingPage();
  state.view = { target: 'agent', value: sel };
  const kb = inKb(section);
  $('detail').innerHTML = `${agentTitle(b)}${sectionsNav()}
    <div class="agent${kb ? ' kb' : ''}" id="agent">${kb ? '<section id="files" aria-label="Files"></section>' : ''}<section id="editor"></section></div>`;
  tabInView();
  readAhead(Agent.show(b.repo, {
    view: section === 'kb' ? 'file' : section, path: state.path, channel, flash, fresh, nav: 'replace',
  }));
}

/** What the overview and the Manage section of a team (`teams`) or a customer (`orgs`) read. */
const READS = {
  overview: (tab, sel) => (tab === 'teams' ? `/api/teams/profile?team=${encodeURIComponent(sel)}`
    : `/api/customers/profile?org=${encodeURIComponent(sel)}`),
  own: (tab, sel) => `/api/admin/${tab === 'teams' ? 'team' : 'org'}?slug=${encodeURIComponent(sel)}`,
  // A team's Vendors section (src/vendors.js).
  vendors: (tab, sel) => `/api/teams/vendors?team=${encodeURIComponent(sel)}`,
};
/** The people suggested for a team, which its Manage section shows (not the admin team's). */
const suggestPath = (slug) => `/api/admin/member-suggestions?team=${encodeURIComponent(slug)}`;
/** A team's or a customer's stack drawing, which its overview shows where it has one. */
const stackPath = (tab, sel) => `/api/kb/stack?${tab === 'teams' ? 'team' : 'org'}=${encodeURIComponent(sel)}`;

/**
 * Reads a section of a team's or a customer's page ahead (see "read ahead"): its overview (and
 * its stack drawing), its Manage section, or with `agent` its agent's, which is the picked one's
 * only (ui/agent.js keeps one knowledge base's).
 */
function warm(tab, sel, section, { agent = false } = {}) {
  if (!sel || !agented(tab, sel)) return;
  const shown = sectionsOf(tab, sel);
  const s = shown.includes(section) ? section : shown[0];
  if (s === 'overview') {
    cached(READS.overview(tab, sel)).then((r) => {
      if (r.ok && (tab === 'teams' ? r.body.kb?.stack : r.body.kb?.drawing)) cached(stackPath(tab, sel));
    });
  } else if (s === 'vendors') {
    cached(READS.vendors(tab, sel));
  } else if (s === 'own') {
    cached(READS.own(tab, sel));
    if (tab === 'teams' && sel !== 'admin' && sel !== UNASSIGNED) cached(suggestPath(sel));
  } else if (s && agent) {
    const b = baseOf(tab, sel);
    if (b) Agent.preload(b.repo);
  }
}

/**
 * Once the section shown is there (`shown`, a promise), the other sections of what is picked
 * are read ahead: going to one of them shows it at once.
 */
function readAhead(shown) {
  const { tab, sel } = state;
  Promise.resolve(shown).catch(() => {}).then(() => setTimeout(() => {
    if (state.tab !== tab || state.sel !== sel) return;
    for (const s of sectionsOf(tab, sel)) warm(tab, sel, s, { agent: true });
  }, 0));
}

/**
 * The pointer resting on (or the focus on) a section's tab, a row of the list or a link to a
 * team or a customer: what it opens is read ahead.
 */
function wireWarm() {
  let timer = 0;
  let at = null;
  const target = (e) => e.target.closest?.('#sections a[data-section], #list [data-sel], a[href^="/inbox/admin?"]');
  const go = (el) => {
    if (el.matches('#list [data-sel]')) {
      warm(state.tab, el.dataset.sel);
      return;
    }
    const w = wanted(el.getAttribute('href'));
    const here = w.tab === state.tab && String(w.sel) === String(state.sel);
    warm(w.tab, w.sel, w.section || (el.dataset.section ?? null), { agent: here });
  };
  const rest = (e) => {
    const el = target(e);
    if (el === at) return;
    at = el;
    clearTimeout(timer);
    // Resting, not passing over it on the way elsewhere.
    if (el) timer = setTimeout(() => go(el), e.type === 'focusin' ? 0 : 80);
  };
  document.addEventListener('pointerover', rest);
  document.addEventListener('focusin', rest);
  // Pressed: the click comes when it is let go.
  document.addEventListener('pointerdown', (e) => {
    const el = target(e);
    if (el) go(el);
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
  showPicked({ channel, flash });
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
  const kind = clef.kind && clef.kind !== 'channel' ? `, ${esc(clef.kind)}` : '';
  const title = `Suggested: ${clef.team === 'none' ? 'no ops team' : teamLabel(clef.team)} (${pct(clef.p)}), ${clef.kind || '?'} (${pct(clef.kindP)})`;
  if (here !== undefined) {
    return `<span class="tag clef${here >= 0.5 ? ' yes' : ''}" title="${esc(title)}">${pct(here)} match${kind}</span>`;
  }
  return `<span class="tag clef" title="${esc(title)}">Suggested: ${esc(clef.team === 'none' ? 'none' : teamLabel(clef.team))} ${pct(clef.p)}${kind}</span>`;
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
    <p class="hint">Search by channel, Teams team, customer or id. The admin team confirms or declines your request.</p>
    <div id="askSlot"></div></div>`;
  }
  return `<div class="card"><h2>Channels</h2><div id="channelsTable"></div>
    <div class="form picker"><label class="fld grow"><span>${target === 'team' ? 'Add a channel to this team' : 'Assign a channel here by hand'}</span><input id="pick" autocomplete="off"></label><div class="picks s2-float" id="picks" hidden></div></div>
    <p class="hint">Search by channel, Teams team, customer, team or id.${target === 'team' ? ' A channel another team holds is shared with this team.' : ''}</p></div>`;
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
      status('ok', `Shared ${plainName(c)} with ${teamLabel(value)}. Still filed under ${teamLabel(res.shared.from)}.`);
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
      return `<tr class="left"><td>${channelName(c)}<div class="sub">${esc(platform(c))}, <span class="mono">${esc(c.channelId)}</span></div></td>
        <td colspan="${triage ? 5 : 4}" class="sub">${c.left.unshared ? `Removed from this team's inbox. Still filed under ${esc(teamLabel(c.left.team))}.`
  : `Moved to ${esc(teamLabel(c.left.team))} / ${esc(orgLabel(c.left.org))}${c.left.kind !== 'channel' ? ` (${esc(c.left.kind)})` : ''}. Threads are being re-filed.`}</td></tr>`;
    }
    const manual = c.manual[target];
    const shares = c.sharedWith || [];
    // On a team's page, a channel another team holds and shares with this one.
    const sharedHere = target === 'team' && c.team !== state.view.value && shares.includes(state.view.value);
    const also = shares.filter((t) => t !== state.view.value);
    const alsoTag = target === 'team' && also.length
      ? ` <span class="tag" title="Also in these teams' inboxes">also ${esc(also.map(teamLabel).join(', '))}</span>` : '';
    const teamCell = `${esc(teamLabel(c.team))}${shares.length ? ` <span class="tag" title="Also in these teams' inboxes">+ ${esc(shares.map(teamLabel).join(', '))}</span>` : ''}`;
    const pick = triage && c.clef && c.clef.team !== 'none' && c.clef.team !== 'admin' && state.teams.some((t) => t.slug === c.clef.team) ? c.clef.team : null;
    // The admin team moves a channel filed here to any team: its name opens the list of them.
    const name = movable && !sharedHere
      ? `<button class="link chan" data-move="${esc(c.channelId)}" aria-haspopup="dialog" title="Move to another team">${channelName(c)}</button>`
      : channelName(c);
    return `<tr><td>${name}<div class="sub">${esc(platform(c))}, <span class="mono">${esc(c.channelId)}</span></div></td>
      <td>${other === 'org' ? esc(orgLabel(c.org)) : teamCell}${c.kind !== 'channel' ? ` <span class="tag">${esc(c.kind)}</span>` : ''}${alsoTag}</td>
      <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td>
      ${triage ? `<td class="nw">${clefTag(c.clef)}${pick ? ` <button class="link" data-give="${esc(c.channelId)}" data-source="${esc(c.source)}" data-team="${esc(pick)}"${off(assignKey(target, c.channelId, pick))} title="Assign to ${esc(teamLabel(pick))}">→ ${esc(teamLabel(pick))}</button>` : ''}</td>` : ''}
      <td class="nw">${sharedHere ? `<span class="tag manual" title="Filed under ${esc(teamLabel(c.team))}">shared by ${esc(teamLabel(c.team))}</span>
        ${swappable(c) ? `<button class="link" data-swap="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`swap:${c.channelId}`)} title="File under ${esc(teamLabel(state.view.value))}. ${esc(teamLabel(c.team))} keeps sharing the channel.">Make primary</button>` : ''}
        ${(c.followedByRule || []).includes(state.view.value) ? '<span class="sub" title="Shared by a follow rule of this team">by a follow rule</span>'
    : `${state.me.admin ? `<button class="link" data-unshare="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unshare:${state.view.value}:${c.channelId}`)} title="Remove from this team's inbox. Stays filed under ${esc(teamLabel(c.team))}.">Remove</button>` : ''}`}`
    : `${manual ? `<span class="tag manual" title="Assigned by hand, overriding the rules">manual</span>
        ${state.me.admin ? `<button class="link" data-unassign="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unassign:${target}:${c.channelId}`)}>Undo</button>` : ''}` : '<span class="sub">by rule</span>'}
        ${back && c.team !== 'admin' ? ` <button class="link" data-give="${esc(c.channelId)}" data-source="${esc(c.source)}" data-team="admin"${off(assignKey(target, c.channelId, 'admin'))} title="Move back to ${esc(teamLabel('admin'))}">→ ${esc(teamLabel('admin'))}</button>` : ''}`}</td></tr>`;
  }).join('');
  $('channelsTable').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>${other === 'org' ? 'Org' : 'Team'}</th><th>Threads</th><th>Latest</th>${triage ? '<th>Suggested</th>' : ''}<th></th></tr>${rows}</table>`
    : '<div class="empty">No channels.</div>';
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
      status('ok', `${plainName(c)} is filed under ${teamLabel(team)}.${swapped.shared ? ` ${teamLabel(from)} keeps sharing the channel.` : ''}`);
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
      status('ok', `Removed ${plainName(c)} from ${teamLabel(team)}'s inbox. Still filed under ${teamLabel(c.team)}.`);
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
    <p class="hint">Assigned by hand, overriding the rules. Shared teams keep the channel.</p>`;
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
      const id = match.length === 1 && match[0] === 'channelId' ? `, id <span class="mono">${hl(c.channelId, words)}</span>` : '';
      const here = c[target] === value;
      // Adding a team to a channel another team holds shares it; one the admin team holds moves.
      const shares = target === 'team' && !here && !isHolding(c.team) && !isHolding(value);
      return `<div class="row pickrow${i === at ? ' on' : ''}" data-i="${i}">
        <span class="name"><span class="ch">${channelName(c, words)}</span>
          <span class="sub">${esc(platform(c))}${org ? `, customer <b>${hl(org, words)}</b>${slug}` : ''}${id},
          ${c.threads} thread${c.threads === 1 ? '' : 's'}${c.latest ? `, ${esc(ago(c.latest))}` : ''}</span></span>
        <span class="where">${pending(c) ? '<span class="tag open" title="Waiting for the admin team">requested</span><br>' : ''}${here ? '<span class="tag manual">here by rule</span>' : `<span class="sub">now in</span> ${hl(teamLabel(c.team), words)}${target === 'org' ? ` / ${esc(orgLabel(c.org))}` : ''}${shares ? '<br><span class="sub" title="Stays filed under its team">shared here</span>' : ''}`}
          ${target === 'team' && c.clef ? `<br>${clefTag(c.clef, c.clef.teams[value] ?? 0)}` : ''}</span></div>`;
    }).join('') || '<div class="empty pad">No channels match.</div>';
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
    const where = p.channels && total ? `; active in ${p.channels} of ${total} admin team channels` : '';
    return `<span class="person" title="${esc(did + where)}">${esc(p.name)}<span class="sub">, ${esc(did)}</span></span>`;
  }).join('');
  return `<tr><td>${channelName(c)}<div class="sub">${esc(platform(c))}${org ? `, customer <b>${esc(org)}</b>` : ''}${c.topic ? `, <span title="${esc(c.topic)}">${esc(c.topic.length > 80 ? `${c.topic.slice(0, 80)}…` : c.topic)}</span>` : ''}</div></td>
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
  const head = '<tr><th>Channel</th><th>Active team members</th><th>Suggested</th><th>Threads</th><th>Latest</th><th></th></tr>';
  const none = '<tr><td colspan="6" class="sub">No team members are active in the admin team\'s channels.</td></tr>';
  const table = suggestions.length ? `<table>${head}${active.length ? active.map(row).join('') : none}
    ${clefOnly.length ? `<tr class="section"><td colspan="6">Also suggested, with no team members active</td></tr>${shown.map(row).join('')}` : ''}</table>
    ${clefOnly.length > shown.length ? `<button class="link" id="sMore">Show ${clefOnly.length - shown.length} more</button>` : ''}`
    : '<div class="empty">No suggestions.</div>';
  $('suggestTable').innerHTML = `${table}
    ${coverage ? `<p class="hint">${coverage.classified} of ${coverage.channels} channels classified.
      ${coverage.classified < coverage.channels ? '<button class="link" id="sClassify">Classify more now</button>' : ''}</p>` : ''}`;
  for (const b of $('suggestTable').querySelectorAll('[data-add]')) {
    b.onclick = () => press(b, () => assignHere(state.view.suggestions.find((x) => x.channelId === b.dataset.add)));
  }
  if ($('sMore')) $('sMore').onclick = () => { state.view.showAllClef = true; renderSuggestions(); };
  if ($('sClassify')) {
    const b = $('sClassify');
    b.onclick = () => hold(b, 'classify', async () => {
      const v = state.view;
      status('', 'Classifying channels…');
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
 * What the team follows (src/follows.js): the technologies and topics whose threads are in its
 * inbox, in any team's channels. Its managers and the admin team pick them here, as with Follow's
 * chevron wherever one is shown (ui/follow.js); the list offers the rest of the tech stack, by
 * product, and the topics Clef asks about. Its customers are follow rules, on the customer's page.
 */
function renderFollows() {
  const v = state.view;
  const { team } = v;
  const tech = new Map(v.followable.map((t) => [t.tech, t]));
  const areas = new Map((v.areas || []).map((a) => [a.id, a]));
  const name = (kind, id) => (kind === 'tech' ? tech.get(id)?.name : areas.get(id)?.name) || id;
  const rows = [...v.follows.map((f) => ({ kind: 'tech', id: f.tech, by: f.added_by })),
    ...(v.followsBy || []).filter((f) => f.kind === 'area').map((f) => ({ kind: 'area', id: f.target, by: f.added_by }))];
  const offFor = (kind, id) => off(`follow:${team.slug}:${kind}:${id}`);
  $('followsTable').innerHTML = rows.length
    ? `<table><tr><th>What</th><th>Name</th><th>Product</th><th>Added by</th><th></th></tr>${rows.map((f) => `<tr>
      <td>${f.kind === 'tech' ? 'Technology' : 'Topic'}</td>
      <td>${esc(name(f.kind, f.id))} <span class="sub mono">${esc(f.id)}</span></td><td>${esc(f.kind === 'tech' ? tech.get(f.id)?.product || '' : '')}</td>
      <td>${esc(f.by || '')}</td>
      <td><button class="link" data-unfollow="${esc(f.id)}" data-kind="${f.kind}"${offFor(f.kind, f.id)}>Unfollow</button></td></tr>`).join('')}</table>`
    : '<div class="empty">Nothing followed yet.</div>';
  const followed = new Set(rows.map((f) => `${f.kind}:${f.id}`));
  const groups = new Map();
  for (const t of v.followable.filter((x) => !followed.has(`tech:${x.tech}`))) {
    const g = t.product || 'Other';
    groups.set(g, [...(groups.get(g) || []), t]);
  }
  const topics = [...areas.values()].filter((a) => !followed.has(`area:${a.id}`));
  $('fTech').innerHTML = `<option value="">Pick one…</option>${topics.length ? `<optgroup label="Topics">${topics.map((a) => `<option value="area:${esc(a.id)}">${esc(a.name)}</option>`).join('')}</optgroup>` : ''}${[...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="tech:${esc(t.tech)}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}`;
  // PUT /api/follows with the team, as Follow's chevron sends it (src/following.js).
  const change = (kind, id, follow, button) => hold(button, `follow:${team.slug}:${kind}:${id}`, async () => {
    const res = await call('/api/follows', 'PUT', {
      kind, target: id, team: team.slug, follow,
    });
    if (!res.ok) { failed(follow ? `Follow ${name(kind, id)}` : `Unfollow ${name(kind, id)}`, res); return; }
    Follow.set(res.body);
    const now = await call(READS.own('teams', team.slug));
    if (now.ok) {
      v.follows = now.body.follows || [];
      v.followsBy = now.body.followsBy || [];
    }
    status('ok', follow ? `${team.name} follows ${name(kind, id)}.` : `${team.name} no longer follows ${name(kind, id)}.`);
  }).then(() => { if (v === state.view) renderFollows(); });
  for (const b of $('followsTable').querySelectorAll('[data-unfollow]')) {
    b.onclick = () => change(b.dataset.kind, b.dataset.unfollow, false, b);
  }
  $('followForm').onsubmit = (e) => {
    e.preventDefault();
    const [kind, ...id] = $('fTech').value.split(':');
    if (kind && id.length) change(kind, id.join(':'), true, $('fAdd'));
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
  const r = await cached(suggestPath(v.team.slug));
  if (v !== state.view || !$('memberSuggest')) return;
  if (!r.ok) { $('memberSuggest').innerHTML = `<div class="empty">${esc(r.body.error || 'Could not load the suggestions.')}</div>`; return; }
  v.memberSuggest = { ...r.body, showDismissed: false };
  renderMemberSuggestions();
}

/** Why someone is suggested, in words: what they did in the team's threads, channels and topics. */
function suggestedWhy(p) {
  return [
    p.posted ? `posted in ${p.posted} of the team's threads` : '',
    p.reacted ? `reacted in ${p.reacted} ${p.reacted === 1 ? 'thread' : 'threads'}` : '',
    p.channels ? `in ${p.channels} of the team's channels` : '',
    p.topics.length ? `works on ${p.topics.map((t) => t.label).join(', ')}` : '',
  ].filter(Boolean).join(', ');
}

function renderMemberSuggestions() {
  const v = state.view;
  const s = v.memberSuggest;
  const el = $('memberSuggest');
  if (!s || !el) return;
  const slug = v.team.slug;
  const key = (email) => `msug:${slug}:${email}`;
  const rows = s.suggestions.map((p) => `<tr>
      <td>${esc(p.name || p.email)}<div class="sub">${esc(p.email)}${p.teams.length ? `, on ${esc(p.teams.map(teamLabel).join(', '))}` : ''}</div></td>
      <td class="sub">${esc(suggestedWhy(p))}${p.last ? `, last ${esc(ago(p.last))}` : ''}</td>
      <td class="nw">${p.added ? '<span class="tag manual">added</span>' : `<button data-sadd="${esc(p.email)}"${off(key(p.email))}>Add</button>
        <button class="link" data-sdismiss="${esc(p.email)}"${off(key(p.email))} title="Not suggested for this team again">Dismiss</button>`}</td></tr>`).join('');
  const dismissed = s.dismissed.length ? `<p class="hint">${s.showDismissed
    ? `Not suggested: ${s.dismissed.map((d) => `${esc(d.name || d.email)} <span class="sub">(${d.why === 'removed' ? 'taken off the team' : 'dismissed'}${d.by ? ` by ${esc(d.by)}` : ''} ${esc(ago(d.at))})</span> <button class="link" data-sagain="${esc(d.email)}"${off(key(d.email))}>Suggest again</button>`).join(', ')}`
    : `<button class="link" id="sDismissed">${peopleCount(s.dismissed.length)} not suggested any more</button>`}</p>` : '';
  el.innerHTML = `${rows ? `<table><tr><th>Name</th><th>Why</th><th></th></tr>${rows}</table>`
    : '<div class="empty">No suggestions.</div>'}
    ${dismissed}`;
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
  const does = r.target === 'follow' ? '<span class="tag" title="Shares matching channels with the team">follows</span>' : '<span class="tag manual" title="Files matching channels under the team">files</span>';
  // A customer the team follows (PUT /api/admin/org-follows): changed on the customer's page.
  const org = followedOrg(r);
  if (org) {
    return `<tr data-rule="${r.id}"><td>${does}</td><td>Customer</td><td><a href="${esc(address({ tab: 'orgs', sel: org, section: 'overview' }))}">${esc(orgLabel(org))}</a></td>
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
    <label class="fld"><span>Does</span><select id="rTarget"><option value="team">files channels</option><option value="follow"${r.target === 'follow' ? ' selected' : ''}>follows channels</option></select></label>
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
  const detail = $('detail');
  const shown = `${state.tab}|${state.sel}`;
  const nav = $('sections');
  if (nav && detail.dataset.shown === shown && nav.parentElement === detail) {
    // Another section of what is shown: its title and tabs stay, the tab asked for current.
    while (nav.nextSibling) nav.nextSibling.remove();
    nav.after(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Loading…' }));
    drawSections();
  } else {
    detail.innerHTML = '<div class="empty">Loading…</div>';
  }
  detail.dataset.shown = shown;
  return () => ticket === loading;
}

// ---- a team's overview ----------------------------------------------------------------------
//
// The first section of a team's page, everyone's: its people, customers, collaborators,
// technologies and knowledge base, from GET /api/teams/profile (src/teamprofile.js), which
// ui/team.js draws. What changes the team is its managers' section (`own`, "Manage").

/** A team's stack drawing, where its knowledge base has one: under its entries. */
async function drawTeamStack(slug, current) {
  const r = await cached(stackPath('teams', slug));
  const slot = $('tvStack');
  if (!current() || !slot || !r.ok || !r.body.drawing) return;
  const view = r.body.drawing;
  const name = teamLabel(slug);
  slot.innerHTML = `<div class="tv-drawing"><h3>Stack drawing</h3>${Stack.html(view)}
    <p class="hint"><a href="${esc(address({ section: 'kb', path: r.body.path }))}">${r.body.may ? 'Edit in the knowledge base' : 'Open in the knowledge base'}</a></p></div>`;
  Stack.wire(slot, view, { title: `${name}'s stack` });
}

async function showOverview(slug) {
  const current = loadingPage();
  const r = await cached(READS.overview('teams', slug));
  if (!current()) return;
  state.view = { target: 'overview', value: slug };
  if (!r.ok) {
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(teamLabel(slug))}</h1></div>
      ${sectionsNav()}<div class="empty">${esc(r.body.error || 'Could not load.')}</div>`;
    tabInView();
    return;
  }
  const p = r.body;
  const onTeam = Boolean(state.me.admin) || (state.me.teams || []).some((t) => t.slug === slug);
  const base = baseOf('teams', slug);
  const ctx = {
    // The customers' overviews are everyone's at Adobe, as the teams'.
    orgHref: (org) => address({ tab: 'orgs', sel: org, section: 'overview' }),
    orgName: (org, name) => name || orgLabel(org),
    orgIcon: (org, icon) => {
      const o = state.orgs.find((x) => x.slug === org);
      return ico(icon || o?.icon || null, o?.domain || null);
    },
    teamHref: (team) => address({ tab: 'teams', sel: team, section: 'overview' }),
    kbHref: (path) => (base && p.kb?.readable ? address({ section: 'kb', path }) : null),
    // A member's Follow, and a technology's (ui/follow.js): not your own. Its chevron is you and
    // this team only: the other teams that follow it are not this page's.
    follow: (thing) => (thing.kind === 'person' && thing.id === state.me.id ? '' : Follow.button(thing, { team: slug })),
    // A node of the Topics page, picked (ui/topics.js opens its group, and adds its line to the chart).
    topicHref: (id) => `/inbox/topics?${new URLSearchParams({ sel: id })}`,
  };
  const facts = [
    p.team.self_managed ? '<span title="Every member is a team manager">Self-managed</span>' : '',
    `${channelCount(p.team.channels)}${p.team.shared ? ` + ${p.team.shared} shared` : ''}`,
    onTeam && slug !== 'admin' ? `<a href="/inbox?team=${encodeURIComponent(slug)}">Open inbox</a>` : '',
  ].filter(Boolean).join(', ');
  $('detail').innerHTML = `
    <div class="title">${backButton()}<h1 class="fill">${esc(p.team.name)}</h1>
      <span class="sub">${facts}</span><span class="sub mono">${esc(p.team.slug)}</span></div>
    ${sectionsNav()}
    <div class="ov" id="overview">${TeamView.html(p, ctx)}</div>`;
  tabInView();
  TeamView.wire($('overview'), p, ctx);
  if (p.kb?.stack) drawTeamStack(slug, current);
}

// ---- a team's vendors -----------------------------------------------------------------------
//
// The second section of a team's page, everyone's: the vendors it works with and what waits on
// them, from GET /api/teams/vendors (src/vendors.js), which ui/team.js draws (`TeamView.vendors`).
// Its managers and the admin team follow a vendor whose channels are not in its inbox yet (PUT
// /api/admin/org-follows, as on the vendor's page in Customers).

async function showVendors(slug) {
  const current = loadingPage();
  const r = await cached(READS.vendors('teams', slug));
  if (!current()) return;
  state.view = { target: 'vendors', value: slug };
  const title = (name) => `<div class="title">${backButton()}<h1 class="fill">${esc(name)}</h1><span class="sub mono">${esc(slug)}</span></div>`;
  if (!r.ok) {
    $('detail').innerHTML = `${title(teamLabel(slug))}${sectionsNav()}<div class="empty">${esc(r.body.error || 'Could not load.')}</div>`;
    tabInView();
    return;
  }
  const p = r.body;
  const ctx = {
    orgHref: (org) => address({ tab: 'orgs', sel: org, section: 'overview' }),
    orgName: (org, name) => name || orgLabel(org),
    orgIcon: (org, icon) => {
      const o = state.orgs.find((x) => x.slug === org);
      return ico(icon || o?.icon || null, o?.domain || null);
    },
  };
  const draw = () => {
    $('overview').innerHTML = TeamView.vendors(p, ctx);
    // The team follows a vendor as Follow's chevron does it (ui/follow.js): PUT /api/follows
    // with the team, said with Undo; `followChanged` draws the section again from the server.
    for (const b of $('overview').querySelectorAll('[data-follow]')) {
      const org = b.dataset.follow;
      b.onclick = () => hold(b, `orgfollow:${slug}:${org}`, async () => {
        if (!await Follow.toggle('org', org, orgLabel(org), slug)) return;
        const v = p.vendors.find((x) => x.slug === org);
        if (v) Object.assign(v, { follows: true, inInbox: true });
      }).then(() => { if (state.view?.target === 'vendors' && state.view.value === slug && $('overview')) draw(); });
    }
  };
  $('detail').innerHTML = `${title(p.team.name)}${sectionsNav()}
    <div class="status" id="status"></div>
    <div class="ov" id="overview"></div>`;
  showStatus();
  tabInView();
  draw();
}

async function showTeam(slug) {
  const current = loadingPage();
  const r = await cached(READS.own('teams', slug));
  if (!current()) return;
  if (!r.ok) { $('detail').innerHTML = `<div class="empty">${esc(r.body.error)}</div>`; return; }
  const {
    team, members, rules, channels, suggestions, coverage, requests = [], follows = [], followable = [],
    followsBy = [], areas = [], portal = [], memberRequests = [],
  } = r.body;
  if (r.body.portalBound !== undefined) state.portalBound = Boolean(r.body.portalBound);
  const v = {
    target: 'team', value: slug, team, members, rules, channels, suggestions, coverage, requests, follows, followable, portal,
    memberRequests, followsBy, areas,
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
      <span><b>Self-managed</b>: every member is a team manager.</span></label>
      ${admin ? '' : '<p class="hint">Only the admin team can change this.</p>'}</div>` : ''}
    ${real ? `<div class="card"><h2>Members</h2><div id="membersTable"></div>
      <div class="form picker"><label class="fld grow"><span>Add a member</span><input id="mFind" autocomplete="off"></label><div class="picks s2-float" id="mPicks" hidden></div></div>
      <p class="hint">Members also need to be in the inbox's Access policy.</p></div>
    ${real && v.memberRequests.length ? '<div class="card"><h2>People asked for</h2><div id="memberRequestsTable"></div><div id="mrSlot"></div></div>' : ''}
    ${slug !== 'admin' ? `<div class="card"><h2>Suggested members</h2>
      <div id="memberSuggest"><div class="empty">Looking for people…</div></div></div>` : ''}

    ${admin ? `<div class="card"><h2>Rules</h2><div id="rulesTable"></div>
      <div id="ruleSlot">${ruleForm()}</div>
      <p class="hint">The matching rule with the lowest priority wins. Example: channel name starts with <code>aem-</code>.</p>
      ${templates.length ? `<p class="hint">${templates.length} rule${templates.length === 1 ? '' : 's'} name the team from the match ($1) and may also apply.</p>` : ''}</div>` : ''}` : ''}
    ${channelsCard('team')}
    ${real ? `<div class="card"><h2>Following</h2><div id="followsTable"></div>
      <form class="form" id="followForm"><label class="fld grow"><span>Follow a topic or a technology</span><select id="fTech"></select></label>
      <button class="primary" id="fAdd">Follow</button></form>
      <p class="hint">Threads about these show in this team's inbox, from any channel.</p></div>` : ''}
    ${real && (!admin || v.requests.length) ? '<div class="card"><h2>Requests</h2><div id="requestsTable"></div></div>' : ''}
    ${real && v.portal.length ? '<div class="card"><h2>Customers in the portal</h2><div id="portalTable"></div></div>' : ''}
    ${suggestions ? `<div class="card"><h2>Suggested channels</h2>
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
    status('ok', on ? 'Every member is a team manager now.' : 'No longer self-managed. Roles stay as they are.');
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
      'Members are removed from the team. A team with rules or threads cannot be deleted.',
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
    const fits = g.team ? `likely ${teamLabel(g.team.slug)}` : '';
    return SideNav.row({
      sel: GROUP + g.prefix,
      on: state.sel === `${GROUP}${g.prefix}`,
      labelHtml: `<span class="mono">${esc(g.prefix)}</span>…`,
      title: rowTitle(
        `Channels starting with ${g.prefix}`,
        channelCount(g.size),
        checked ? peopleCount(checked) : 'nobody in most of them',
        fits,
      ),
      count: g.size,
      countTitle: channelCount(g.size),
    });
  };
  const offered = state.groups.filter(match);
  const dismissed = state.dismissedGroups.filter(match);
  if (!offered.length && !dismissed.length) return '';
  const holds = (list) => list.some((g) => state.sel === `${GROUP}${g.prefix}`);
  const more = dismissed.length ? SideNav.group({
    key: 'teams:groups:dismissed', label: `${dismissed.length} dismissed`, body: dismissed.map(row).join(''), holds: holds(dismissed),
  }) : '';
  return SideNav.group({
    key: 'teams:groups',
    label: 'Suggested teams',
    count: offered.length,
    title: 'Groups of the admin team\'s channels that look like a team of their own',
    body: `${offered.map(row).join('') || '<div class="navempty">None now.</div>'}${more}`,
    holds: Boolean(f) || holds(offered) || holds(dismissed),
  });
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
      <td><label for="gp${i}">${esc(p.name || p.email)}</label><div class="sub">${esc(p.email)}${did(p) ? `, ${esc(did(p))}` : ''}</div></td>
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
  if (!v.moves) { el.innerHTML = `<span class="sub">${v.movesError ? esc(v.movesError) : 'Checking what the rules would move…'}</span>`; return; }
  const mine = new Set(v.group.channels.map((c) => `${c.source}:${c.channelId}`));
  // What changes team: a rule change also re-files what the rules say otherwise already.
  const moved = v.moves.filter((m) => m.from.some((f) => f.team !== m.to.team));
  const others = moved.filter((m) => !mine.has(`${m.channel.source}:${m.channel.channelId}`));
  el.innerHTML = `<div class="status ${others.length ? 'warn' : 'ok'}">The rules re-file ${channelCount(moved.length)} under the team.</div>
    ${others.length ? `<p class="hint">The rules also move ${others.map((m) => `<b>${esc(plainName(m.channel))}</b> from ${esc(m.from.map((x) => teamLabel(x.team)).join(', '))}`).join(', ')}.</p>` : ''}`;
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
    $('detail').innerHTML = `<div class="title">${backButton()}</div><div class="empty">No admin team channels start with <code>${esc(prefix)}</code>.</div>`;
    return;
  }
  const teams = state.teams.filter((t) => t.slug !== 'admin');
  const preferred = g.team ? g.team.slug : (g.slugTaken ? g.slug : '');
  const v = {
    target: 'group', group: g, mode: preferred ? 'existing' : 'new', moves: null, checked: new Set(g.people.filter((p) => p.suggested).map((p) => p.email)),
  };
  state.view = v;
  const checked = v.checked.size;
  const listed = g.membersListed < g.size ? ` Members listed for ${g.membersListed}.` : '';
  $('detail').innerHTML = `
    <div class="title">${backButton()}<h1 class="fill">Channels starting with <code>${esc(g.prefix)}</code></h1>
      ${g.dismissed ? '<button id="gAgain">Suggest again</button>' : '<button id="gDismiss" title="Hide until more channels start with this prefix">Dismiss</button>'}</div>
    <div class="status" id="status"></div>
    <p class="hint lead">${channelCount(g.size)} without a team.${listed}
      ${g.dismissed ? ` Dismissed by ${esc(g.dismissed.by || 'someone')} ${esc(ago(g.dismissed.at))}.` : ''}</p>
    <div class="card wizteam"><h2>Team</h2>
      <label class="inline"><input type="radio" name="gMode" value="new"${v.mode === 'new' ? ' checked' : ''}><span>A new team</span></label>
      <div class="form"><label class="fld grow"><span>Name</span><input id="gName" value="${esc(g.slugTaken ? '' : g.name)}"></label>
        <label class="fld"><span>Slug</span><input id="gSlug" pattern="[a-z0-9][a-z0-9-]*" value="${esc(g.slugTaken ? '' : g.slug)}"></label></div>
      <label class="inline"><input type="radio" name="gMode" value="existing"${v.mode === 'existing' ? ' checked' : ''}><span>An existing team</span>
        <select id="gTeam" aria-label="Ops team">${teams.map((t) => `<option value="${esc(t.slug)}"${t.slug === preferred ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      ${g.team ? `<p class="hint">${g.team.people} of the ${peopleCount(checked)} checked below ${g.team.people === 1 ? 'is' : 'are'} already on ${esc(teamLabel(g.team.slug))}.</p>` : ''}
      ${g.slugTaken && !g.team ? `<p class="hint">There is a team <span class="mono">${esc(g.slug)}</span> already.</p>` : ''}</div>
    <div class="card"><h2>Members</h2><div id="gPeople"></div>
      <p class="hint">They join as members.</p></div>
    <div class="card"><h2>Rules</h2><table><tr><th>Field</th><th>Rule</th><th>Platform</th></tr>${g.rules.map((r) => `<tr><td>${esc(FIELD_LABEL[r.field] || r.field)}</td><td>${describe(r)}</td><td>${r.source ? esc(platform({ source: r.source })) : 'All'}</td></tr>`).join('')}</table>
      <div class="preview" id="gMoves"></div></div>
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
// in its inbox, where the request is a thread (src/requestthreads.js): Confirm runs the assignment the team's page makes, after its
// dry run said what it moves; Decline takes a reason. Both pages show what came of each.

const who = (p) => esc((p && (p.name || p.email)) || 'someone');
/** A request's thread in the admin team's inbox (src/requestthreads.js): where it is decided. */
const requestThread = (kind, id) => `/inbox?team=admin&t=${encodeURIComponent(`request:${kind}:${id}`)}`;
/**
 * Where an address of Requests, the page the requests had before they were threads of the admin
 * team's inbox, goes now: `request=<id>` a channel request, the others by their prefix.
 */
function requestsAddress(sel) {
  if (!sel) return '/inbox?team=admin';
  const kinds = [['member:', 'member'], ['portal:', 'portal'], ['orgmerge:', 'merge'], ['conflict:', 'tech'],
    ['ruleconflict:', 'rule'], ['bot:', 'bot'], ['account:', 'account']];
  const k = kinds.find(([prefix]) => sel.startsWith(prefix));
  return k ? requestThread(k[1], sel.slice(k[0].length)) : requestThread('channel', sel);
}
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
    moved: `filed under ${esc(teamLabel(r.team))}`,
    shared: `shared with ${esc(teamLabel(r.team))}, still filed under ${esc(teamLabel(r.channel.team))}`,
    assigned: `assigned to ${esc(teamLabel(r.team))}`,
  }[r.outcome] || '';
  return `${statusTag(r)} by ${who(r.decidedBy)}${when}${did ? `: ${did}` : ''}`;
}

/** The number of open requests, on Inbox in the header: the admin team's inbox has them. */
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
}

/** The team page's requests: what was asked for, by whom, and the answer. */
function renderRequests() {
  const v = state.view;
  const rows = v.requests.map((r) => `<tr><td>${channelName(r.channel)}<div class="sub">${esc(platform(r.channel))}, <span class="mono">${esc(r.channel.channelId)}</span></div></td>
    <td class="nw">${who(r.requestedBy)}<div class="sub">${esc(ago(r.requestedAt))}</div></td>
    <td class="note">${esc(r.note || '')}</td>
    <td>${decisionText(r)}</td>
    <td class="nw">${r.status !== 'open' ? '' : state.me.admin
    ? `<a href="${esc(requestThread('channel', r.id))}" title="Open in the admin team's inbox">Review</a>`
    : `<button class="link" data-withdraw="${r.id}"${off(`request:${r.id}`)} >Withdraw</button>`}</td></tr>`).join('');
  $('requestsTable').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>Asked by</th><th>Note</th><th>Answer</th><th></th></tr>${rows}</table>`
    : '<div class="empty">No requests yet.</div>';
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
 * Sent, the request is a thread of the admin team's inbox, and pending here.
 */
function askFor(c) {
  const v = state.view;
  const asked = v.requests.find((x) => x.status === 'open' && x.channel.channelId === c.channelId);
  if (asked) {
    status('', `${plainName(c)} is already requested.`);
    return;
  }
  const shares = !isHolding(c.team);
  $('askSlot').innerHTML = `<form class="form" id="askForm">
    <span class="what">Ask the admin team to add <b>${channelName(c)}</b> to ${esc(teamLabel(v.value))}
      <span class="sub">(now in ${esc(teamLabel(c.team))}${shares ? ', would be shared' : ''})</span></span>
    <label class="fld grow"><span>Reason (optional)</span><input id="askNote" maxlength="500"></label>
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
      else status('ok', `Requested ${plainName(c)}.`);
      if (v === state.view) renderRequests();
    });
  };
}

// ---- membership requests --------------------------------------------------------------------
//
// A thread's agent asks, for whoever asked it in the sidebar, that someone be added to an ops team
// (src/memberrequests.js). An admin decides in the admin team's inbox, where it is a thread, a team's
// managers on its page (`renderMemberRequests`): Confirm adds the person as a member, as adding
// them on the team's page does; Decline takes a reason.

const memberName = (r) => r.person.name || r.person.email;

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
  const rows = v.memberRequests.map((r) => `<tr><td>${esc(memberName(r))}<div class="sub">${esc(r.person.email)}${r.person.teams.length ? `, on ${esc(r.person.teams.map(teamLabel).join(', '))}` : ''}</div></td>
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

// ---- customers in the portal ---------------------------------------------------------------
//
// A customer who can use neither Slack nor Teams with Adobe signs in to the customer portal
// with their work mail address, says what they use of Adobe's and asks for a channel
// (src/portalrequests.js). The admin team answers in its inbox, where it is a thread: Open channel makes the
// channel in the portal, files it under a team and a customer, and posts the welcome message
// as whoever opens it; Decline takes a reason the customer reads. A team's managers see the
// customers who picked a technology the team follows on their team's page, and open a channel
// for their team.

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
      ${r.logo ? `<img class="ico" src="${esc(r.logo)}" alt="" title="Logo uploaded in the portal">` : ''}
      <h1 class="fill">${esc(r.company || r.domain)} <span class="sub">${esc(r.domain)}</span></h1>${statusTag(r)}</div>
    <div class="status" id="status"></div>
    <div class="card"><div class="field">
      <label>Asks for</label><span>a channel in the customer portal</span>
      <label>Uses</label><span>${r.tech.map((t) => `<span class="tag">${esc(t.name)}</span>`).join(' ') || '<span class="sub">nothing picked</span>'}</span>
      <label>Followed by</label><span>${r.teams.length ? r.teams.map((t) => `<a href="/inbox/admin?tab=teams&team=${encodeURIComponent(t.team)}&view=manage">${esc(t.name)}</a> <span class="sub">${esc(t.tech.map((id) => techName.get(id) || id).join(', '))}</span>`).join(', ') : '<span class="sub">no team follows any of these</span>'}</span>
      ${r.note ? `<label>Needs</label><span class="note">${esc(r.note)}</span>` : ''}
      <label>Asked by</label><span>${who(r.requestedBy)} <span class="sub">${esc(r.requestedBy.email || '')}, ${esc(ago(r.requestedAt))}</span></span>
      <label>People</label><span>${r.members.map((m) => `${esc(m.name || m.email)}${m.joined ? '' : ' <span class="sub">(invited)</span>'}`).join(', ')}</span>
      ${c ? `<label>Channel</label><span>filed under <a href="/inbox/admin?tab=teams&team=${encodeURIComponent(c.team)}&view=manage">${esc(teamLabel(c.team))}</a>, customer <b>${esc(orgLabel(c.org))}</b> <span class="sub mono">${esc(c.channelId)}</span></span>` : ''}
      ${open ? '' : `<label>Answer</label><span>${statusTag(r)} by ${who(r.decidedBy)} ${esc(ago(r.decidedAt))}${r.reason ? `: <span class="note">${esc(r.reason)}</span>` : ''}</span>`}
    </div></div>
    ${r.status === 'declined' ? '' : `<div class="card"><h2>${c ? 'Opening another channel' : 'Opening a channel'}</h2>
      ${state.portalBound ? '' : '<p class="hint lead">The customer portal is not connected (PORTAL_WORKER).</p>'}
      <form class="form portalopen" id="pqForm">
        <label class="fld"><span>Channel name</span><input id="pqName" maxlength="80" value="${esc(c ? '' : r.suggest.name)}" required></label>
        ${admin ? `<label class="fld"><span>Customer${r.suggest.known ? `: ${esc(r.suggest.orgName || r.suggest.org)}` : ' (new)'}</span><input id="pqOrg" class="mono" maxlength="63" value="${esc(c ? c.org : r.suggest.org)}" required></label>` : ''}
        <label class="fld"><span>Team</span><select id="pqTeam"${forTeam ? ' disabled' : ''}>${teams.map((t) => `<option value="${esc(t.slug)}"${t.slug === first ? ' selected' : ''}>${esc(t.name)}${esc(why(t.slug))}</option>`).join('')}</select></label>
        ${admin && teams.length > 1 ? `<fieldset class="what shares"><legend>Also in the inbox of</legend>${teams.map((t) => `<label class="only"><input type="checkbox" name="pqShare" value="${esc(t.slug)}"> ${esc(t.name)}</label>`).join('')}</fieldset>` : ''}
        <label class="fld what"><span>Welcome message, posted as you</span><textarea id="pqWelcome" rows="4" maxlength="8000">${esc(first ? welcomeText(r, first) : '')}</textarea></label>
        <button class="primary" id="pqOpen"${state.portalBound && teams.length ? '' : ' disabled'}${off(`portal:${r.id}`)}>Open channel</button></form>
      <p class="hint">Everyone in the customer's lobby joins the channel.</p></div>`}
    ${open && admin ? `<div class="card"><h2>Decline</h2><form class="form" id="pqDeclineForm"><label class="fld grow"><span>Reason, for the customer (optional)</span><input id="pqReason" maxlength="500"></label>
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

// ---- a customer's overview ------------------------------------------------------------------
//
// The first section of a customer's page, everyone's at Adobe: its people, Adobe's people and
// the teams on it, what it asks about, its channels, technologies and knowledge base, from
// GET /api/customers/profile (src/orgprofile.js), which ui/customer.js draws. Its title has a
// Follow of your own (its conversations in your personal view) and a link to its threads in an
// inbox of yours; what changes it is its Manage section (`own`).

/** A customer's threads in an inbox of yours: a team's of yours that has it, else your own view. */
function orgInbox(slug, teams) {
  const q = `filters=1&f.customer=${encodeURIComponent(slug)}`;
  const mine = new Set((state.me.teams || []).map((t) => t.slug));
  const team = teams.find((t) => mine.has(t.slug) && (t.filed || t.shared || t.follows));
  if (team) return `/inbox?team=${encodeURIComponent(team.slug)}&${q}`;
  return followsOrg(slug) ? `/inbox?view=personal&${q}` : null;
}

/** A customer's stack drawing, where its knowledge base has one: under its entries. */
async function drawOrgStack(slug, current) {
  const r = await cached(stackPath('orgs', slug));
  const slot = $('tvStack');
  if (!current() || !slot || !r.ok || !r.body.drawing) return;
  const view = r.body.drawing;
  const kb = baseOf('orgs', slug);
  slot.innerHTML = `<div class="tv-drawing"><h3>Stack drawing</h3>${Stack.html(view)}
    ${kb ? `<p class="hint"><a href="${esc(address({ section: 'kb', path: r.body.path }))}">${r.body.may ? 'Edit in the knowledge base' : 'Open in the knowledge base'}</a></p>` : ''}</div>`;
  Stack.wire(slot, view, { title: `${orgLabel(slug)}'s stack` });
}

async function showOrgOverview(slug) {
  const current = loadingPage();
  const r = await cached(READS.overview('orgs', slug));
  if (!current()) return;
  state.view = { target: 'org-overview', value: slug };
  if (!r.ok && r.body.mergedInto) {
    // Merged (src/orgmerge.js): it is the org it went into now.
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(slug)}</h1></div>
      <div class="empty">Merged into <a href="${esc(address({ tab: 'orgs', sel: r.body.mergedInto, section: 'overview' }))}">${esc(orgLabel(r.body.mergedInto))}</a>.</div>`;
    return;
  }
  if (!r.ok) {
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(orgLabel(slug))}</h1></div>
      ${sectionsNav()}<div class="empty">${esc(r.body.error || 'Could not load.')}</div>`;
    tabInView();
    return;
  }
  const p = r.body;
  const row = state.orgs.find((o) => o.slug === slug);
  const base = baseOf('orgs', slug);
  const ctx = {
    teamHref: (team) => address({ tab: 'teams', sel: team, section: 'overview' }),
    teamName: (team) => teamLabel(team),
    kbHref: (path) => (base && p.kb?.readable ? address({ section: 'kb', path }) : null),
    // A node of the Topics page, picked, as a team's overview links them.
    topicHref: (id) => `/inbox/topics?${new URLSearchParams({ sel: id })}`,
    // A person's, a topic's and a product's Follow (ui/follow.js): not your own.
    follow: (thing) => (thing.kind === 'person' && thing.id === state.me.id ? '' : Follow.button(thing)),
    // A vendor's page lists the customers of its products.
    orgHref: (org) => address({ tab: 'orgs', sel: org, section: 'overview' }),
    orgIcon: (org, icon) => {
      const o = state.orgs.find((x) => x.slug === org);
      return ico(icon || o?.icon || null, o?.domain || null);
    },
  };
  const name = p.org.name || p.org.slug;
  const inbox = orgInbox(slug, p.teams);
  const facts = [
    channelCount(p.org.channels),
    inbox ? `<a href="${esc(inbox)}" title="Open in your inbox">Threads</a>` : '',
  ].filter(Boolean).join(', ');
  $('detail').innerHTML = `
    <div class="title">${backButton()}${ico(p.org.icon || row?.icon || null, p.org.domain || row?.domain || null)}<h1 class="fill">${esc(name)}</h1>
      ${p.org.type !== 'customer' ? `<span class="tag ${esc(p.org.type)}">${esc(p.org.type)}</span>` : ''}
      <span class="sub">${facts}</span>${Follow.button({ kind: 'org', id: slug, name })}<span class="sub mono">${esc(slug)}</span></div>
    ${sectionsNav()}
    <div class="status" id="status"></div>
    <div class="ov" id="overview">${CustomerView.html(p, ctx)}</div>`;
  showStatus();
  tabInView();
  CustomerView.wire($('overview'), p, ctx);
  if (p.kb?.drawing) drawOrgStack(slug, current);
}

// ---- orgs ---------------------------------------------------------------------------------

async function showOrg(slug) {
  const current = loadingPage();
  const r = await cached(READS.own('orgs', slug));
  if (!current()) return;
  if (!r.ok && r.body.mergedInto) {
    // Merged (src/orgmerge.js): it is the org it went into now.
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(slug)}</h1></div>
      <div class="empty">Merged into <a href="${esc(address({ tab: 'orgs', sel: r.body.mergedInto, section: 'overview' }))}">${esc(orgLabel(r.body.mergedInto))}</a>.</div>`;
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
      <span class="sub mono">${esc(org.slug)}</span><button class="danger" id="oDelete" title="Reset the name, icon and type"${org.updated_at ? '' : ' hidden'}>Reset</button></div>
    ${sectionsNav()}
    <div class="status" id="status"></div>
    ${followCard()}
    <div class="card"><div class="field">
      <label for="oName">Display name</label><span class="inline"><input id="oName" class="fill" value="${esc(org.name || '')}"></span>
      <label>Type</label><span class="seg" id="oType">${types.map((t) => `<button type="button" data-type="${t}" aria-pressed="${org.type === t}">${t}</button>`).join('')}</span>
      <label for="oIcon">Icon</label><span class="inline"><input id="oIcon" class="mono fill" value="${esc(org.icon || '')}"></span>
      <label>Suggestions</label><div class="icons" id="oIcons"><span class="sub">Looking for icons…</span>${ICON_GHOST}</div>
    </div><p class="hint">Icon: a domain (uses the favicon) or an https image URL.${domain ? ` Defaults to the favicon of ${esc(domain)}.` : ''}</p></div>
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
    // A partner and a customer are candidates only by their names; partners pair with customers.
    if (retyped) {
      loadDups({ fresh: true });
      loadLinks({ fresh: true });
    }
  };
  // The icon suggestions (src/favicons.js), each a button that makes it the org's icon.
  let found = [];
  const markIcons = () => {
    const now = $('oIcon').value.trim();
    for (const b of $('oIcons').querySelectorAll('[data-icon]')) b.setAttribute('aria-pressed', String(b.dataset.icon === now));
  };
  const tile = (c) => {
    const share = c.p === null || c.p === undefined ? '' : `${Math.round(c.p * 100)}%`;
    const what = c.via === 'favicon' ? `Favicon of ${c.host}` : `${c.icon}, from ${c.host}`;
    const verdict = c.svg ? '' : share && `: ${share} match`;
    return `<button type="button" class="iconpick${c.p !== null && c.p < FITS ? ' weak' : ''}" data-icon="${esc(c.icon)}"
      title="${esc(`${what}${c.title ? ` (“${c.title}”)` : ''}${verdict}`)}"><img src="${esc(c.via === 'favicon' ? favicon(c.icon) : c.src)}" alt="">
      <span class="host">${esc(c.host)}${c.via === 'site' ? ' <span class="sub">site</span>' : ''}</span><span class="sub">${c.svg ? 'SVG' : share}</span></button>`;
  };
  const drawIcons = () => {
    $('oIcons').innerHTML = `${found.map(tile).join('') || '<span class="sub">No icons found.</span>'}
      <button type="button" class="again" id="oIconsAgain" title="Fetch the icons again">Look again</button>${ICON_GHOST}`;
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
      $('oIcons').innerHTML = `<span class="sub">Could not look for icons: ${esc(res.body.error || res.status)}</span>${ICON_GHOST}`;
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

function followCard() {
  return '<div class="card"><h2>Following</h2><div id="orgFollows"></div></div>';
}

/** Who follows the customer: your Follow and Mute (ui/follow.js, as on its overview), and every team that does. */
function renderOrgFollows() {
  const v = state.view;
  const slug = v.value;
  const name = v.org.name || slug;
  const teams = [...new Set(v.follows.map((f) => f.team))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
  $('orgFollows').innerHTML = `<div class="fo-at">${Follow.button({ kind: 'org', id: slug, name })}</div>
    <p class="sub">${teams.length ? `Followed by ${teams.map((t) => `<a href="${esc(address({ tab: 'teams', sel: t, section: 'overview' }))}">${esc(teamLabel(t))}</a>`).join(', ')}.` : 'No team follows this customer.'}</p>`;
}

/**
 * After a change of what you or a team follows (ui/follow.js): the lists that show it, and the
 * page on screen where it is a team's: a customer's followers and channels (a team that follows
 * it shares them), or a team's Following.
 */
async function followChanged(change) {
  if (change.kind === 'org') renderList();
  const v = state.view;
  if (!change.team || !v) return;
  // A team's Vendors section, which says whom it follows (an Undo there too).
  if (v.target === 'vendors' && v.value === change.team && change.kind === 'org') {
    showVendors(change.team);
    return;
  }
  if (v.target === 'org' && v.value === change.id) {
    const now = await call(READS.own('orgs', change.id));
    if (v !== state.view || !now.ok) return;
    if (now.body.channels) v.channels = now.body.channels;
    v.follows = now.body.follows || v.follows;
    renderOrgFollows();
    renderChannels();
  } else if (v.target === 'team' && v.value === change.team && $('followsTable')) {
    const now = await call(READS.own('teams', change.team));
    if (v !== state.view || !now.ok) return;
    v.follows = now.body.follows || [];
    v.followsBy = now.body.followsBy || [];
    renderFollows();
  }
}

/** A customer's channels card: the table, and for the admin team the picker that assigns one here. */
function orgChannelsCard() {
  return `<div class="card"><h2>Channels</h2><div id="orgChannels"></div>
    ${state.me.admin ? '<div class="form picker"><label class="fld grow"><span>Assign a channel here by hand</span><input id="pick" autocomplete="off"></label><div class="picks s2-float" id="picks" hidden></div></div>' : ''}
    ${state.me.admin || (state.me.manages || []).length ? '' : '<p class="hint">Only team managers can change channels.</p>'}</div>`;
}

function renderOrgChannels() {
  const v = state.view;
  const asked = (c, team) => v.requests.some((r) => r.team === team && r.channel.channelId === c.channelId && r.channel.source === c.source);
  const movable = state.me.admin && state.teams.length > 1;
  const rows = v.channels.map((c) => {
    const where = `<div class="sub">${esc(platform(c))}, <span class="mono">${esc(c.channelId)}</span></div>`;
    if (c.left) {
      return `<tr class="left"><td>${channelName(c)}${where}</td><td colspan="4" class="sub">${c.left.unshared ? `Out of ${esc(teamLabel(c.left.team))}'s inbox.`
        : `Filed under ${esc(teamLabel(c.left.team))} / ${esc(orgLabel(c.left.org))} now. Threads are being re-filed.`}</td></tr>`;
    }
    const byRule = c.followedByRule || [];
    const shares = (c.sharedWith || []).map((t) => `<li>${esc(teamLabel(t))} <span class="sub">${byRule.includes(t) ? (v.follows.some((f) => f.team === t) ? 'follows the customer' : 'by a follow rule') : 'shared'}</span>
      ${managesHere(t) && !byRule.includes(t) ? `<button class="link" data-unshare="${esc(c.channelId)}" data-team="${esc(t)}"${off(`unshare:${t}:${c.channelId}`)} title="Remove from ${esc(teamLabel(t))}'s inbox. Stays filed under ${esc(teamLabel(c.team))}.">Remove</button>` : ''}</li>`).join('');
    const split = (c.split || []).filter((x) => x.threads);
    const home = `<li><b>${esc(teamLabel(c.team))}</b> <span class="sub">filed${c.manual?.team ? ' by hand' : ''}</span>
      ${!isHolding(c.team) && managesHere(c.team) ? `<button class="link" data-release="${esc(c.channelId)}"${off(`release:${c.channelId}`)} title="Return to ${esc(teamLabel('admin'))}">Remove</button>` : ''}</li>`;
    // A manager asks for it for their teams that do not have it filed.
    const ask = state.me.admin ? '' : (state.me.manages || []).filter((t) => t !== c.team).map((t) => (asked(c, t)
      ? `<span class="tag manual" title="Waiting for the admin team">asked for ${esc(teamLabel(t))}</span>`
      : `<button class="link" data-ask="${esc(c.channelId)}" data-team="${esc(t)}"${off(`ask:${t}:${c.channelId}`)} title="Ask the admin team to move this channel to ${esc(teamLabel(t))}">Ask for ${esc(teamLabel(t))}</button>`)).join(' ');
    const manualOrg = state.me.admin && c.manual?.org
      ? `<span class="tag manual" title="Assigned by hand, overriding the rules">manual</span> <button class="link" data-unassign="${esc(c.channelId)}" data-source="${esc(c.source)}"${off(`unassign:org:${c.channelId}`)}>Undo</button>` : '';
    const name = movable
      ? `<button class="link chan" data-move="${esc(c.channelId)}" aria-haspopup="dialog" title="Move to another team">${channelName(c)}</button>` : channelName(c);
    return `<tr><td>${name}${where}</td>
      <td><ul class="teams">${home}${shares}</ul>${split.length ? `<div class="sub" title="Being re-filed under ${esc(teamLabel(c.team))}">${split.map((x) => `${x.threads} ${x.threads === 1 ? 'thread' : 'threads'} still under ${esc(teamLabel(x.team))}`).join(', ')}</div>` : ''}
        ${c.kind !== 'channel' ? ` <span class="tag">${esc(c.kind)}</span>` : ''}</td>
      <td class="n">${c.threads}</td><td class="sub">${esc(ago(c.latest))}</td><td class="nw">${manualOrg}${ask}</td></tr>`;
  }).join('');
  $('orgChannels').innerHTML = rows
    ? `<table><tr><th>Channel</th><th>Teams</th><th>Threads</th><th>Latest</th><th></th></tr>${rows}</table>`
    : '<div class="empty">No channels.</div>';
  const find = (id) => v.channels.find((c) => c.channelId === id && !c.left);
  const redraw = () => { if (v === state.view) renderOrgChannels(); renderList(); };
  for (const b of $('orgChannels').querySelectorAll('[data-move]')) {
    b.onclick = () => moveMenu(b, find(b.dataset.move));
  }
  for (const b of $('orgChannels').querySelectorAll('[data-release]')) {
    const c = find(b.dataset.release);
    const from = c.team;
    b.onclick = async () => {
      if (!(await confirmFirst(`Remove ${plainName(c)} from ${teamLabel(from)}?`, `The channel goes back to ${teamLabel('admin')}. Only ${teamLabel('admin')} can give it back to ${teamLabel(from)}.`, 'Remove'))) return;
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
      status('ok', `Removed ${plainName(c)} from ${teamLabel(team)}'s inbox. Still filed under ${teamLabel(c.team)}.`);
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
      else status('ok', `Requested ${plainName(c)} for ${teamLabel(team)}.`);
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
    <p class="hint">Pick an org for each channel.</p></div>`;
  showStatus();
  renderUnassigned(v);
}

function renderUnassigned(v) {
  if (v !== state.view || !$('unassignedTable')) return;
  const rows = v.channels.map((c) => {
    const where = `<div class="sub">${esc(platform(c))}, <span class="mono">${esc(c.channelId)}</span></div>`;
    if (c.left) {
      return `<tr class="left"><td>${channelName(c)}${where}</td><td colspan="4" class="sub">Filed under ${esc(orgLabel(c.left.org))}. Threads are being re-filed.</td></tr>`;
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
    <div class="newtype" hidden><span class="sub">New org of type</span><select aria-label="Type">${state.types.map((t) => `<option>${t}</option>`).join('')}</select></div>`;
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

// ---- partner domains -------------------------------------------------------------------------
//
// The mail domains whose people are partners' (src/partners.js), the admin team's, in Customers:
// those found in the partners' threads, and its own over them. A domain is added by hand (with a
// partner org, or a name), a found one given another name or partner, or said not to be a
// partner's; removing a row of its own brings back what was found. Below, the domains a partner's
// people write from that are left out as a customer's own, each one click from being a partner's.

const DOMAINS = 'domains:';
const isDomains = (sel) => sel === DOMAINS;
const DOMAIN_STATE = {
  found: ['', 'Found'], manual: ['manual', 'Set by hand'], excluded: ['declined', 'Not a partner'],
};

/** The row in Customers that opens them, the admin team's. */
const domainsRow = (f) => (state.me.admin && (!f || 'partner domains'.includes(f))
  ? SideNav.todo({
    sel: DOMAINS, on: isDomains(state.sel), label: 'Partner domains', title: 'Mail domains of partners\' people',
  }) : '');

async function showDomains({ fresh = false } = {}) {
  const current = loadingPage();
  state.view = null;
  const r = await call(`/api/admin/partner-domains${fresh ? '?fresh=1' : ''}`);
  if (!current()) return;
  if (!r.ok) {
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">Partner domains</h1></div><div class="empty">${esc(r.body.error || `Could not load (${r.status}).`)}</div>`;
    return;
  }
  state.view = { target: 'domains', value: DOMAINS, ...r.body };
  drawDomains(state.view);
}

/** A partner org's name, as a link to its page. */
const partnerLink = (slug, name) => (slug
  ? `<a href="${esc(address({ tab: 'orgs', sel: slug, section: 'overview' }))}">${esc(name || orgLabel(slug))}</a>` : esc(name || ''));

function domainForm(v, d = {}) {
  const org = d.manual ? d.manual.org : d.org;
  const name = d.manual ? d.manual.name : '';
  return `<form class="form" id="pdForm">
    <label class="fld grow"><span>Mail domain</span><input id="pdDomain" class="mono" value="${esc(d.domain || '')}" required></label>
    <label class="fld"><span>Partner</span><select id="pdOrg"><option value="">None: by name</option>${v.partners.map((p) => `<option value="${esc(p.slug)}"${p.slug === org ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="fld grow"><span>Name (optional)</span><input id="pdName" value="${esc(name || '')}"></label>
    <button class="primary">Save</button>
  </form>`;
}

function drawDomains(v) {
  const rows = v.domains.map((d) => {
    const [cls, label] = DOMAIN_STATE[d.state];
    const found = d.found ? `${d.found.people} ${d.found.people === 1 ? 'person' : 'people'}, ${d.found.threads} ${d.found.threads === 1 ? 'thread' : 'threads'}` : '';
    const by = d.manual && d.manual.by ? `${esc(d.manual.by)}${d.manual.at ? `, ${esc(ago(d.manual.at))}` : ''}` : '';
    const key = `pd:${d.domain}`;
    const acts = [
      `<button class="link" data-pd-edit="${esc(d.domain)}">Change</button>`,
      d.state === 'excluded' ? '' : `<button class="link" data-pd-exclude="${esc(d.domain)}"${off(key)}>Not a partner</button>`,
      d.manual ? `<button class="link" data-pd-undo="${esc(d.domain)}"${off(key)}>${d.found ? 'Back to found' : 'Remove'}</button>` : '',
    ].filter(Boolean).join(' ');
    return `<tr><td class="mono">${esc(d.domain)}</td><td>${d.state === 'excluded' ? '<span class="sub">none</span>' : partnerLink(d.org, d.name)}</td>
      <td><span class="tag${cls ? ` ${cls}` : ''}">${label}</span>${by ? `<div class="sub">${by}</div>` : ''}</td><td class="sub">${found}</td><td class="picks-cell">${acts}</td></tr>`;
  }).join('');
  const left = (v.left || []).map((d) => `<tr><td class="mono">${esc(d.domain)}</td><td>${partnerLink(d.org, d.name)}</td><td>${partnerLink(d.customer, orgLabel(d.customer))}</td>
    <td class="sub">${d.people} ${d.people === 1 ? 'person' : 'people'}</td><td><button class="link" data-pd-take="${esc(d.domain)}" data-org="${esc(d.org)}"${off(`pd:${d.domain}`)}>Partner's</button></td></tr>`).join('');
  $('detail').innerHTML = `<div class="title">${backButton()}<span class="ico none"></span><h1 class="fill">Partner domains</h1>
      <button id="pdFresh">Find again</button></div>
    <div class="status" id="status"></div>
    <div class="card"><h2>Add or change one</h2><div id="pdSlot">${domainForm(v)}</div>
      <p class="hint">People from these domains and their subdomains show as the partner's.</p></div>
    <div class="card"><h2>Domains</h2>${rows ? `<table><tr><th>Domain</th><th>Partner</th><th>Source</th><th>Posters</th><th></th></tr>${rows}</table>` : '<div class="empty">None found, none set.</div>'}
      <p class="hint">Found in partner orgs' threads${v.at ? ` ${esc(ago(v.at))}` : ''}.</p></div>
    ${left ? `<div class="card"><h2>Left out as a customer's</h2><table><tr><th>Domain</th><th>Seen at</th><th>Customer</th><th>Posters</th><th></th></tr>${left}</table></div>` : ''}`;
  showStatus();
  wireDomains(v);
}

/** Saves a row of the admin team's, and shows the list again as the Worker has it. */
async function saveDomain(v, body, what) {
  const saved = await once(`pd:${body.domain}`, async () => {
    const res = await call('/api/admin/partner-domains', body.remove ? 'DELETE' : 'PUT', body.remove ? { domain: body.domain } : body);
    if (!res.ok) { failed(what, res); return false; }
    status('ok', `${what}: saved.`);
    return true;
  });
  if (!saved || v !== state.view) return;
  // Drawn once the row's buttons are not busy any more.
  const r = await call('/api/admin/partner-domains');
  if (r.ok && v === state.view) {
    Object.assign(v, r.body);
    drawDomains(v);
  }
}

function wireDomains(v) {
  const find = (domain) => v.domains.find((d) => d.domain === domain);
  const wireForm = () => {
    $('pdForm').onsubmit = (e) => {
      e.preventDefault();
      const domain = $('pdDomain').value.trim();
      saveDomain(v, { domain, org: $('pdOrg').value, name: $('pdName').value }, domain);
    };
  };
  wireForm();
  $('pdFresh').onclick = () => press($('pdFresh'), () => showDomains({ fresh: true }));
  for (const b of $('detail').querySelectorAll('[data-pd-edit]')) {
    b.onclick = () => {
      $('pdSlot').innerHTML = domainForm(v, find(b.dataset.pdEdit));
      wireForm();
      $('pdName').focus();
    };
  }
  for (const b of $('detail').querySelectorAll('[data-pd-exclude]')) {
    b.onclick = () => press(b, () => saveDomain(v, { domain: b.dataset.pdExclude, excluded: true }, b.dataset.pdExclude));
  }
  for (const b of $('detail').querySelectorAll('[data-pd-undo]')) {
    b.onclick = () => press(b, () => saveDomain(v, { domain: b.dataset.pdUndo, remove: true }, b.dataset.pdUndo));
  }
  for (const b of $('detail').querySelectorAll('[data-pd-take]')) {
    b.onclick = () => press(b, () => saveDomain(v, { domain: b.dataset.pdTake, org: b.dataset.org }, b.dataset.pdTake));
  }
}

// ---- duplicate customers ---------------------------------------------------------------------
//
// One company can end up under two slugs (a channel named workfront-acmeco and one named
// aem-acme). The Worker lists the pairs of orgs that may be one, from their names, icons, mail
// domains, Slack Connect teams and people, each with Clef's verdict (src/orgmerge.js); the list
// on the left shows the likely ones first. A pair's page puts the two side by side: the admin
// team merges one into the other (tried first: what would be re-filed) or says they are not the
// same; anyone else who sees one of them asks the admin team for the merge, which waits in its
// inbox, a thread there. A merge can be undone on the page of the org kept.

const PAIR = 'pair:';
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
  const said = p.p === null ? 'not checked yet' : `${pct(p.p)} likely the same`;
  const why = [`${p.a}, ${p.b}`, said, asked ? 'merge asked for' : '', p.dismissed ? 'not the same' : ''].filter(Boolean).join(', ');
  return SideNav.row({
    sel: pairSel(p.a, p.b),
    on: state.sel === pairSel(p.a, p.b),
    cls: 'dup',
    lead: `${ico(orgs[p.a].icon, orgs[p.a].domain)}${ico(orgs[p.b].icon, orgs[p.b].domain)}`,
    labelHtml: `${esc(dupName(p.a))} <span class="sep">and</span> ${esc(dupName(p.b))}`,
    title: `${dupName(p.a)} (${p.a}) and ${dupName(p.b)} (${p.b}), ${why}`,
    count: asked ? 'asked' : (p.p === null ? '' : pct(p.p)),
    countTitle: said,
  });
}

/** The pairs at the top of the list (filtered as the list is), the less likely ones folded. */
function dupSection(f) {
  const d = state.dups;
  if (!d || d.error) return '';
  const match = (p) => !f || `${dupName(p.a)} ${p.a} ${dupName(p.b)} ${p.b}`.toLowerCase().includes(f);
  const top = d.pairs.filter((p) => likelyPair(p) && match(p));
  const rest = d.pairs.filter((p) => !likelyPair(p) && match(p));
  if (!top.length && !rest.length && !d.unchecked) return '';
  const checking = d.unchecked ? `<div class="navnote">Checking ${d.unchecked} more…</div>` : '';
  const holds = (list) => list.some((p) => state.sel === pairSel(p.a, p.b));
  const more = rest.length ? SideNav.group({
    key: 'orgs:dups:more', label: `${rest.length} less likely`, body: rest.map(dupRow).join(''), holds: holds(rest),
  }) : '';
  return SideNav.group({
    key: 'orgs:dups',
    label: 'Likely duplicates',
    count: top.length,
    body: `${top.map(dupRow).join('') || `<div class="navempty">${f ? 'Nothing matches.' : 'None for now.'}</div>`}${checking}${more}`,
    holds: (Boolean(f) && (top.length + rest.length) > 0) || holds(top) || holds(rest),
  });
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
  const page = address({ tab: 'orgs', sel: o.slug, section: 'overview' });
  const chans = o.channelNames.map((c) => `<li>${esc(c.label)} <span class="sub">${esc(platform(c))}, ${c.threads} ${c.threads === 1 ? 'thread' : 'threads'}</span>${c.topic ? `<div class="sub">${esc(c.topic)}</div>` : ''}</li>`).join('');
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
  if (!pr) return '<span class="sub">Checking…</span>';
  if (!pr.ok) return `<span class="err">${esc(pr.body.error || `failed (${pr.status})`)}</span>`;
  const { moves, moved = {}, kb = {} } = pr.body;
  const from = nameIn(v, v.from);
  const into = nameIn(v, v.keep);
  const what = {
    mcp_servers: ['MCP server', 'MCP servers'],
    agent_secrets: ['secret', 'secrets'],
    agent_repos: ['repository', 'repositories'],
    person_follows_by: ['follower', 'followers'],
    org_stacks: ['stack drawing', 'stack drawings'],
    portal_requests: ['portal lobby', 'portal lobbies'],
  };
  const along = Object.entries(moved).map(([k, n]) => `${n} ${(what[k] || [k, k])[n === 1 ? 0 : 1]}`);
  return `<ul>
    <li>${moves.length ? `Re-files ${moves.length} ${moves.length === 1 ? 'channel' : 'channels'} under ${esc(into)}: ${moves.slice(0, 6).map((m) => esc(plainName(m.channel))).join(', ')}${moves.length > 6 ? ` and ${moves.length - 6} more` : ''}.` : 'No channels to re-file.'}</li>
    ${along.length ? `<li>Moves ${esc(along.join(', '))} to ${esc(into)}.</li>` : ''}
    ${kb.entries ? `<li>Copies ${kb.entries} knowledge-base entries to ${esc(into)}.</li>` : ''}
    <li>Keeps the name, icon and type of ${esc(into)}, filling gaps from ${esc(from)}.</li>
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
  const clef = pair.p === null ? 'Not checked yet.'
    : `${pct(pair.p)} likely the same company${pair.stale ? ' (out of date)' : ''}${pair.checked ? `, checked ${esc(ago(pair.checked))}` : ''}.`;
  const seg = `<span class="seg" id="pKeep">${[pair.a, pair.b].map((s) => `<button type="button" data-keep="${esc(s)}" aria-pressed="${v.keep === s}">${esc(nameIn(v, s))}</button>`).join('')}</span>`;
  let act = '';
  if (v.done) {
    act = `<div class="card"><h2>Merged</h2><p>${esc(nameIn(v, v.done.from))} is part of <a href="${esc(address({ tab: 'orgs', sel: v.done.into, section: 'overview' }))}">${esc(nameIn(v, v.done.into))}</a> now${v.done.moves ? `; ${v.done.moves} ${v.done.moves === 1 ? 'channel is' : 'channels are'} re-filed` : ''}${v.done.kb ? `; ${v.done.kb}` : ''}.</p>
      <div class="form"><button id="pUndo"${off(`unmerge:${v.done.from}`)}>Undo the merge</button></div></div>`;
  } else if (admin) {
    act = `<div class="card"><h2>Merge</h2><div class="field"><label>Keep</label>${seg}</div>
      <div class="preview" id="pPreview">${mergePreviewText(v)}</div>
      <div class="form"><button class="primary" id="pMerge"${v.preview && v.preview.ok ? '' : ' disabled'}${off(`merge:${v.value}`)}>Merge ${esc(nameIn(v, v.from))} into ${esc(nameIn(v, v.keep))}</button>
        ${pair.dismissed ? `<button id="pDismiss" data-undo="1"${off(`dismiss:${v.value}`)}>They may be one after all</button>` : `<button id="pDismiss"${off(`dismiss:${v.value}`)}>Not the same</button>`}</div>
      ${pair.dismissed ? `<p class="hint">Marked not the same by ${who({ email: pair.dismissed.by })} ${esc(ago(pair.dismissed.at))}.</p>` : ''}</div>`;
  } else if (mine) {
    act = `<div class="card"><h2>Your request</h2><p>${askText(mine, v)}</p><div class="form"><button id="pWithdraw"${off(`ask:${mine.id}`)}>Withdraw</button></div></div>`;
  } else if (!open.length) {
    act = `<div class="card"><h2>Ask for a merge</h2><form class="form" id="pAskForm"><div class="fld"><span class="sub">Keep</span>${seg}</div>
      <label class="fld grow"><span>Reason (optional)</span><input id="pNote" maxlength="500"></label>
      <button class="primary" id="pAsk"${off(`ask:${v.value}`)}>Ask the admin team</button></form></div>`;
  }
  // Your own open request is the card that takes it back.
  const listed = asks.filter((q) => q !== mine);
  const asked = listed.length ? `<div class="card"><h2>Asked for</h2><ul class="asks">${listed.map((q) => `<li>${askText(q, v)}${q.status === 'open' ? '' : `, ${decisionText(q)}`}
      ${admin && q.status === 'open' ? `<form class="form" data-decline="${q.id}"><label class="fld grow"><span>Reason, for ${who(q.requestedBy)} (optional)</span><input maxlength="500"></label><button class="danger"${off(`ask:${q.id}`)}>Decline</button></form>` : ''}</li>`).join('')}</ul></div>` : '';
  $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(dupName(pair.a, orgs))} <span class="sub">and</span> ${esc(dupName(pair.b, orgs))}</h1></div>
    <div class="status" id="status"></div>
    <div class="card"><div class="pair">${pairSide(orgs[pair.a], !v.done && v.keep === pair.a)}${pairSide(orgs[pair.b], !v.done && v.keep === pair.b)}</div></div>
    <div class="card"><h2>Likely the same</h2><p>${clef}</p>${pair.signals.length ? `<ul>${pair.signals.map((x) => `<li>${esc(x.text[0].toUpperCase() + x.text.slice(1))}.</li>`).join('')}</ul>` : '<p class="sub">No shared signals.</p>'}</div>
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
      const ok = await confirmFirst(`Merge ${nameIn(v, from)} into ${nameIn(v, into)}?`, `${from}'s channels, agent setup and knowledge move to ${into}. Undo moves the channels back.`, 'Merge');
      if (!ok) return;
      const res = await call('/api/admin/org-merge', 'POST', { from, into });
      if (!res.ok) { failed('Merge', res); return; }
      const { moves, kb = {} } = res.body;
      applyMoves(moves, null);
      settleAsks(v, 'merged');
      state.orgs = state.orgs.filter((o) => o.slug !== from);
      if (state.dups && !state.dups.error) state.dups.pairs = state.dups.pairs.filter((p) => p.a !== from && p.b !== from);
      const copied = kb.copied ? `${kb.copied} knowledge-base ${kb.copied === 1 ? 'entry' : 'entries'} copied` : '';
      const left = kb.kept && kb.kept.length ? `${kb.kept.length} already in ${into}` : '';
      v.done = {
        from, into, moves: moves.length, kb: [copied, left, kb.error ? `knowledge base not copied: ${kb.error}` : ''].filter(Boolean).join(', '),
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
      status('ok', undo ? 'Back on the list.' : 'Marked not the same.');
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
          status('ok', 'Merge requested.');
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
      else status('ok', 'Request withdrawn.');
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
  status('ok', `Unmerged ${slug}${res.body.moves.length ? `; ${res.body.moves.length} ${res.body.moves.length === 1 ? 'channel moves' : 'channels move'} back` : ''}.`);
  const orgs = await call('/api/admin/orgs');
  if (orgs.ok) state.orgs = orgs.body.orgs;
  loadDups({ fresh: true });
  return res.body;
}

/**
 * An org's page: the orgs merged into it, each undone here, its likely duplicates, and any
 * other org to compare it with.
 */
function orgMergeCard(slug, merged) {
  const pairs = (state.dups && !state.dups.error ? state.dups.pairs : []).filter((p) => p.a === slug || p.b === slug);
  const others = state.orgs.filter((o) => o.slug !== slug);
  return `<div class="card"><h2>Duplicates</h2>
    ${merged.length ? `<table id="mergedTable"><tr><th>Merged in</th><th>By</th><th></th></tr>${merged.map((m) => `<tr><td>${esc(m.name || m.slug)} <span class="sub mono">${esc(m.slug)}</span></td>
      <td class="sub">${who({ email: m.merged_by })}, ${esc(ago(m.merged_at))}</td><td class="n"><button class="quiet" data-unmerge="${esc(m.slug)}"${off(`unmerge:${m.slug}`)}>Undo</button></td></tr>`).join('')}</table>` : ''}
    ${pairs.length ? `<ul class="dups">${pairs.map((p) => {
    const other = p.a === slug ? p.b : p.a;
    return `<li><a href="${esc(address({ tab: 'orgs', sel: pairSel(p.a, p.b) }))}">${esc(dupName(other))}</a> <span class="sub">${p.p === null ? 'not checked yet' : `${pct(p.p)} likely the same`}${p.dismissed ? ', not the same' : ''}</span></li>`;
  }).join('')}</ul>` : ''}
    <form class="form" id="oCompare"><label class="fld grow"><span>Compare with another org</span><input id="oOther" list="oOthers" autocomplete="off"></label>
      <datalist id="oOthers">${others.map((o) => `<option value="${esc(o.slug)}">${esc(o.name || '')}</option>`).join('')}</datalist><button>Compare</button></form></div>`;
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

// ---- partners --------------------------------------------------------------------------------
//
// Which customers each partner (an agency, a system integrator) works for. The Worker finds the
// pairs of a customer and a partner that may work together, from the partner's people in the
// customer's threads and channels, the sites both name, the partner's knowledge base, a Slack
// Connect or Teams team they share and a channel named for both, each with Clef's verdict
// (src/orgpartners.js). The admin team confirms a pair or dismisses it; everyone at Adobe reads
// the confirmed and likely ones (GET /api/customers/partners).

const LINK = 'partner:';
const linkSel = (customer, partner) => `${LINK}${customer}:${partner}`;
const isLink = (sel) => String(sel ?? '').startsWith(LINK);
const linkName = (slug, orgs = state.links?.orgs) => (orgs && orgs[slug] && orgs[slug].name) || orgLabel(slug);
/** Whether a pair waits for the admin team: nobody decided it, and Clef says it is likely. */
const reviewLink = (x) => !x.confirmed && !x.dismissed && x.p !== null && x.p >= (state.links?.likely ?? 0.5);

/** The pairs, from the Worker; while Clef has not answered for all, asked again as it gets further. */
async function loadLinks({ fresh = false, round = 0 } = {}) {
  const r = await call(`/api/admin/org-partners${fresh ? '?fresh=1' : ''}`);
  if (!r.ok) {
    state.links = {
      error: r.body.error || `failed (${r.status})`, pairs: [], orgs: {}, unchecked: 0,
    };
    return;
  }
  const was = state.links && !state.links.error ? state.links.unchecked : null;
  state.links = r.body;
  if (state.tab === 'orgs') renderList();
  if (r.body.unchecked && round < 10 && (was === null || round === 0 || r.body.unchecked < was)) {
    loadLinks({ round: round + 1 });
  }
}

/** What is said of a pair, in a few words. */
function linkSaid(x) {
  if (x.confirmed) return 'confirmed';
  if (x.dismissed) return 'dismissed';
  return x.p === null ? 'Clef has not said yet' : `${pct(x.p)} likely, says Clef`;
}

function linkRow(x) {
  const { orgs } = state.links;
  let shown = x.p === null ? '' : pct(x.p);
  if (x.confirmed) shown = '✓';
  else if (x.dismissed) shown = '–';
  return SideNav.row({
    sel: linkSel(x.customer, x.partner),
    on: state.sel === linkSel(x.customer, x.partner),
    cls: 'dup',
    lead: `${ico(orgs[x.partner].icon, orgs[x.partner].domain)}${ico(orgs[x.customer].icon, orgs[x.customer].domain)}`,
    labelHtml: `${esc(linkName(x.partner))} <span class="sep">for</span> ${esc(linkName(x.customer))}`,
    title: `${linkName(x.partner)} (${x.partner}) for ${linkName(x.customer)} (${x.customer}) · ${linkSaid(x)}`,
    count: shown,
    countTitle: linkSaid(x),
  });
}

/** The admin team's: the pairs to review at the top of the list, the rest folded. */
function linkSection(f) {
  const d = state.links;
  if (!d || d.error) return '';
  const match = (x) => !f || `${linkName(x.customer)} ${x.customer} ${linkName(x.partner)} ${x.partner}`.toLowerCase().includes(f);
  const top = d.pairs.filter((x) => reviewLink(x) && match(x));
  const open = d.pairs.filter((x) => !reviewLink(x) && !x.confirmed && !x.dismissed && match(x));
  const done = d.pairs.filter((x) => (x.confirmed || x.dismissed) && match(x));
  if (!top.length && !open.length && !done.length && !d.unchecked) return '';
  const checking = d.unchecked ? `<div class="navnote">Clef is looking at ${d.unchecked} more…</div>` : '';
  const holds = (list) => list.some((x) => state.sel === linkSel(x.customer, x.partner));
  const fold = (key, label, list) => (list.length ? SideNav.group({
    key, label, body: list.map(linkRow).join(''), holds: holds(list),
  }) : '');
  return SideNav.group({
    key: 'orgs:partners',
    label: 'Likely partners',
    count: top.length,
    title: 'A partner that may work for a customer, as Clef sees it: confirm it, or dismiss it',
    body: `${top.map(linkRow).join('') || `<div class="navempty">${f ? 'Nothing matches.' : 'None to review.'}</div>`}${checking}
      ${fold('orgs:partners:less', `${open.length} less likely`, open)}${fold('orgs:partners:done', `${done.length} decided`, done)}`,
    holds: (Boolean(f) && (top.length + open.length + done.length) > 0) || holds(top) || holds(open) || holds(done),
  });
}

/** The pair as it is now, in the list on the left too. */
function updateLink(x, orgs) {
  if (!state.links || state.links.error) return;
  const i = state.links.pairs.findIndex((y) => y.customer === x.customer && y.partner === x.partner);
  if (i >= 0) state.links.pairs[i] = x;
  else state.links.pairs.unshift(x);
  Object.assign(state.links.orgs, orgs);
}

async function showLink(customer, partner) {
  const current = loadingPage();
  state.view = null;
  const r = await call(`/api/admin/org-partners?pair=${encodeURIComponent(`${customer}:${partner}`)}`);
  if (!current()) return;
  if (!r.ok) {
    $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">Partners</h1></div><div class="empty">${esc(r.body.error || `Could not load (${r.status}).`)}</div>`;
    return;
  }
  const [pair] = r.body.pairs;
  const { orgs } = r.body;
  updateLink(pair, orgs);
  renderList();
  state.view = {
    target: 'link', value: `${customer}:${partner}`, pair, orgs,
  };
  drawLink(state.view);
}

function drawLink(v) {
  const { pair, orgs } = v;
  const [p, c] = [linkName(pair.partner, orgs), linkName(pair.customer, orgs)];
  const clef = pair.p === null ? 'Clef has not been asked yet; it is, the next time the list loads.'
    : `Clef says ${pct(pair.p)} that ${esc(p)} works for ${esc(c)}${pair.stale ? ' (from before what they share changed: it is asked again)' : ''}${pair.checked ? `, asked ${esc(ago(pair.checked))}` : ''}.`;
  const evidence = pair.signals.length
    ? `<ul>${pair.signals.map((x) => `<li>${esc(x.text[0].toUpperCase() + x.text.slice(1))}.</li>`).join('')}</ul>`
    : '<p class="sub">Nothing they share says so now.</p>';
  let said = `Confirmed, everyone at Adobe sees ${esc(p)} as a partner of ${esc(c)}; dismissed, nobody does, whatever Clef says.`;
  if (pair.confirmed) said = `Confirmed by ${who({ email: pair.confirmed.by })} ${esc(ago(pair.confirmed.at))}.`;
  else if (pair.dismissed) said = `Dismissed by ${who({ email: pair.dismissed.by })} ${esc(ago(pair.dismissed.at))}: not shown as partners, whatever Clef says.`;
  const key = `link:${v.value}`;
  $('detail').innerHTML = `<div class="title">${backButton()}<h1 class="fill">${esc(p)} <span class="sub">for</span> ${esc(c)}</h1></div>
    <div class="status" id="status"></div>
    <div class="card"><div class="pair">${pairSide(orgs[pair.partner], false)}${pairSide(orgs[pair.customer], false)}</div></div>
    <div class="card"><h2>Why ${esc(p)} may work for ${esc(c)}</h2><p>${clef}</p>${evidence}</div>
    <div class="card"><h2>Partner of the customer</h2><div class="form">
      ${pair.confirmed ? `<button id="lUndo" data-what="confirm"${off(key)}>Not confirmed after all</button>` : `<button class="primary" id="lConfirm"${off(key)}>Confirm</button>`}
      ${pair.dismissed ? `<button id="lUndo" data-what="dismiss"${off(key)}>Not dismissed after all</button>` : `<button id="lDismiss"${off(key)}>Dismiss</button>`}</div>
      <p class="hint">${said}</p></div>`;
  showStatus();
  // Drawn again once it is done: drawn meanwhile, its buttons would stay disabled (`off`).
  const decide = (b, what, undo) => hold(b, key, async () => {
    const res = await call(`/api/admin/org-partners/${what}`, 'POST', { customer: pair.customer, partner: pair.partner, undo });
    if (!res.ok) { failed(what === 'confirm' ? 'Confirm' : 'Dismiss', res); return false; }
    Object.assign(pair, { confirmed: res.body.pair.confirmed, dismissed: res.body.pair.dismissed });
    updateLink(pair, orgs);
    renderList();
    return true;
  }).then((done) => {
    if (!done || v !== state.view) return;
    drawLink(v);
    if (undo) status('ok', 'Taken back.');
    else status('ok', what === 'confirm' ? 'Confirmed.' : 'Dismissed.');
  });
  if ($('lConfirm')) $('lConfirm').onclick = () => decide($('lConfirm'), 'confirm', false);
  if ($('lDismiss')) $('lDismiss').onclick = () => decide($('lDismiss'), 'dismiss', false);
  if ($('lUndo')) $('lUndo').onclick = () => decide($('lUndo'), $('lUndo').dataset.what, true);
}

// ---- start ------------------------------------------------------------------------------

(async () => {
  // Requests was a page of these: its requests are threads of the admin team's inbox now.
  const legacy = new URLSearchParams(location.search);
  if (legacy.get('tab') === 'requests') {
    location.replace(requestsAddress(legacy.get('request')));
    return;
  }
  // Another team, org or section fades in (ui/app.js).
  Swap.watch($('detail'), () => `${state.tab}|${state.sel ?? ''}|${state.section === 'history' ? 'kb' : state.section ?? ''}`);
  const me = await call('/api/me');
  if (!me.ok) { $('list').innerHTML = `<div class="empty">${esc(me.body.error || 'Not signed in.')}</div>`; return; }
  state.me = me.body;
  Header.user(state.me, Header.role(state.me) || (state.me.teams?.length ? 'Read-only' : ''));
  // Teams is everyone's at Adobe (a team's overview); the rest is for the members of a team.
  if (!state.me.admin && !state.me.manages?.length && !state.me.teams?.length && !state.me.staff) {
    $('list').innerHTML = '<div class="empty">These pages are for Adobe\'s people.</div>';
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
      if (['teams', 'orgs'].includes(id)) openUrl(url);
      else if (await Agent.leave()) location.assign(url);
    },
  });
  // Following and muting (ui/follow.js): sent as the page sends (`call`, which forgets what was
  // read ahead), said in a toast with Undo.
  Follow.init({
    me: state.me,
    readonly: Boolean(state.me.readonly),
    request: (method, path, body) => call(path, method, body).then((r) => ({ ok: r.ok, status: r.status, data: r.body })),
  });
  Follow.on(followChanged);
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
    // Its changes make what was read ahead old (see "read ahead").
    onWrite: forget,
  });
  wireWarm();
  // The knowledge base's agent answered in its sidebar, and may have changed it: as it is now.
  KbChat.init({ onAnswer: (repo) => Agent.changed(repo) });
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
