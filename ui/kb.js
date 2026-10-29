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
 * The knowledge-base editor, the Agents page: every knowledge base (pile 3) you may see, its
 * files, and an editor that saves as you type: a pause in typing commits the file as the
 * signed-in person. The admin team edits every knowledge base, team managers their teams';
 * the other members of a team see its knowledge base, its agents and their tools read-only,
 * and change only their own settings here: whether the agent's thinking shows in their inbox,
 * everywhere or in one channel (`traces`, `channelTraces` of /api/settings). No native dialogs (alert, confirm): a debugger attached over CDP dismisses them on
 * its own, so the questions that remain are asked in the page. The one exception is
 * beforeunload, and only for edits that could not be saved: nothing else can ask then.
 * `systemprompt.md` holds the
 * instructions appended to the system prompt of every thread agent that uses the knowledge
 * base; agents cannot change it. index.md and log.md are written by code and shown read-only.
 */
const SYSTEM_PROMPT = 'systemprompt.md';
const GENERATED = new Set(['index.md', 'log.md']);
const state = {
  me: null, bases: [], repo: null, files: [], hasSystemPrompt: false, file: null, filter: '', view: 'file',
  channels: null, configured: true, teamDefault: null, mcp: null, globals: null, tools: null, perFilter: {},
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => state.bases.find((b) => b.repo === state.repo);
/** Whether you change the open knowledge base, its agents and their tools; else you only look. */
const mayEdit = () => Boolean(base()?.may);
/** Who changes the open knowledge base, for the read-only. */
const whoEdits = () => (base()?.kind === 'team' ? `the admin team and the managers of ${base().name}` : 'the admin team');

async function call(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

function systemPromptTemplate(b) {
  const who = b.kind === 'team' ? `the ops team ${b.name}` : `the customer ${b.name}`;
  return `---\ntype: System Prompt\ntitle: Agent instructions for ${who}\ndescription: Appended to the system prompt of every thread agent that uses this knowledge base.\n---\n\n`
    + `<!-- Instructions for the agents of every thread of ${who}, in Markdown: how to address people, what to\n`
    + '     always check, what never to promise, who to ask. Comments like this one are not sent to the agents. -->\n\n';
}

function conceptTemplate(path) {
  const title = path.split('/').pop().replace(/\.md$/, '').replace(/[-_]+/g, ' ');
  return `---\ntype: Reference\ntitle: ${title}\ndescription: One sentence that says what this is.\ntags: []\n---\n\n`;
}

/** The editor's text, or null when it shows something else. */
function editorText() {
  return $('text') && state.editor ? state.editor.value : null;
}

/** Whether the editor holds text that is not saved: edited since it was opened or saved. */
function edited() {
  const f = state.file;
  return Boolean(f && !f.readonly && editorText() !== null && editorText() !== f.baseline);
}

/**
 * Asks in the page, with a modal <dialog>: resolves true for `yes`, false otherwise
 * (including Escape). Not window.confirm(): a debugger attached over CDP dismisses those.
 */
function ask(question, detail, yes) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm';
    dlg.setAttribute('aria-label', question);
    dlg.innerHTML = `<form method="dialog"><p><b>${esc(question)}</b></p>${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
      <div class="apply"><button value="no">Cancel</button><button value="yes" class="primary">${esc(yes)}</button></div></form>`;
    dlg.addEventListener('cancel', () => { dlg.returnValue = 'no'; });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'yes'); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[value="no"]').focus();
  });
}

/**
 * Before the editor shows something else: saves what is pending. Asks only when there are
 * edits that could not be saved (a conflict, an invalid concept, no path yet).
 */
async function leave() {
  await flush();
  if (!edited()) return true;
  return ask('Your last changes are not saved.', state.file.problem || 'They could not be committed.', 'Discard them');
}

/**
 * The inbox, not opened yet in this browser tab (ui/header.js keeps it as it was left): the
 * inbox of the team whose knowledge base is open.
 */
function teamInbox() {
  const b = base();
  return b && b.kind === 'team' ? `/inbox?team=${encodeURIComponent(b.slug)}` : null;
}

/**
 * The URL names the knowledge base and the file (or the history), so
 * reloads and the browser's Back and Forward land where they were. Going to another knowledge
 * base or file is a new history entry (`push`); settling the URL of the same view is not.
 */
function toUrl(mode = 'push') {
  const q = new URLSearchParams();
  if (state.repo) q.set('repo', state.repo);
  if (state.file && !state.file.isNew) q.set('path', state.file.path);
  if (['history', 'agents', 'mcp'].includes(state.view)) q.set('view', state.view);
  const url = `/inbox/kb${q.size ? `?${q}` : ''}`;
  if (url !== `${location.pathname}${location.search}`) {
    history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  }
}

// ---- knowledge bases --------------------------------------------------------------------

/**
 * How customers and vendors are listed: by activity (the default: most entries in their
 * knowledge base first, then most tools turned on) or by name. Kept in this browser.
 */
const SORTS = { activity: 'Activity', name: 'A–Z' };
const keptSort = () => { try { return localStorage.getItem('opspile.kb.sort'); } catch { return null; } };
state.sort = keptSort() === 'name' ? 'name' : 'activity';

const byName = (x, y) => x.name.localeCompare(y.name) || x.repo.localeCompare(y.repo);
const byActivity = (x, y) => (y.entries || 0) - (x.entries || 0) || (y.tools || 0) - (x.tools || 0) || byName(x, y);

/** "12 entries · 2 tools" for a row's title and its count. */
function activity(b) {
  const parts = [b.entries === null || b.entries === undefined ? 'entries not counted yet' : `${b.entries} entr${b.entries === 1 ? 'y' : 'ies'}`];
  if (b.tools) parts.push(`${b.tools} tool${b.tools === 1 ? '' : 's'} on`);
  return parts.join(' · ');
}

function renderBases() {
  const f = state.filter.toLowerCase();
  const shown = state.bases.filter((b) => !f || `${b.name} ${b.slug} ${b.repo}`.toLowerCase().includes(f));
  const row = (b) => `<div class="row${b.repo === state.repo ? ' on' : ''}" data-repo="${esc(b.repo)}" title="${esc(activity(b))}">
      <span>${esc(b.name)}</span>${b.agents ? `<span class="tag agent" title="Thread agents are on in ${b.agents} channel${b.agents === 1 ? '' : 's'}">agent${b.agents > 1 ? ` · ${b.agents}` : ''}</span>` : ''}<span class="sub">${esc(b.repo)}</span>${b.entries ? `<span class="n">${b.entries}</span>` : ''}</div>`;
  const teams = shown.filter((b) => b.kind === 'team');
  const orgs = shown.filter((b) => b.kind === 'org').sort(state.sort === 'name' ? byName : byActivity);
  const sorts = Object.entries(SORTS).map(([k, label]) => `<button data-sort="${k}" aria-pressed="${state.sort === k}"
    title="${k === 'name' ? 'Alphabetically' : 'Most entries in the knowledge base first, then most tools turned on'}">${label}</button>`).join('');
  $('bases').innerHTML = `<input id="filter" placeholder="Filter" value="${esc(state.filter)}" aria-label="Filter knowledge bases">${
    (teams.length ? `<h2>Ops teams</h2>${teams.map(row).join('')}` : '')
    + (orgs.length ? `<h2 class="sorted"><span>Customers and vendors</span><span class="seg" role="group" aria-label="Sort customers and vendors">${sorts}</span></h2>${orgs.map(row).join('')}` : '')
    || '<div class="empty">No knowledge bases.</div>'}`;
  $('filter').oninput = (e) => {
    state.filter = e.target.value;
    const at = e.target.selectionStart;
    renderBases();
    $('filter').focus();
    $('filter').setSelectionRange(at, at);
  };
  for (const el of $('bases').querySelectorAll('[data-repo]')) {
    el.onclick = () => openRepo(el.dataset.repo);
  }
  for (const el of $('bases').querySelectorAll('[data-sort]')) {
    el.onclick = () => {
      state.sort = el.dataset.sort;
      try { localStorage.setItem('opspile.kb.sort', state.sort); } catch { /* private mode */ }
      renderBases();
      $('bases').querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
    };
  }
}

/** Phones show one column at a time: `bases`, `files` or `editor`. */
const showPane = (pane) => { document.querySelector('main').dataset.pane = pane; };
const UP = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
const up = (pane, label) => `<button class="up" data-up="${pane}">${UP}${label}</button>`;

async function openRepo(repo, { path, view, nav = 'push' } = {}) {
  if (repo !== state.repo && !(await leave())) return false;
  showPane('files');
  state.repo = repo;
  state.file = null;
  state.view = view || 'file';
  renderBases();
  $('files').innerHTML = '<div class="empty">Loading…</div>';
  $('editor').innerHTML = '<div class="empty">Pick a file.</div>';
  state.channels = null;
  state.mcp = null;
  state.globals = null;
  state.tools = null;
  const [{ ok, body }] = await Promise.all([
    call(`/api/kb/files?repo=${encodeURIComponent(repo)}`),
    loadChannels(repo),
    loadMcp(repo),
    loadTools(repo),
  ]);
  if (state.repo !== repo) return true;
  if (!ok) {
    $('files').innerHTML = `<div class="empty">${esc(body.error || 'Could not list the files.')}</div>`;
    toUrl(nav);
    return true;
  }
  state.files = body.files;
  state.hasSystemPrompt = body.hasSystemPrompt;
  state.truncated = body.truncated;
  renderFiles();
  if (state.view === 'history') showHistory({ force: true, nav });
  else if (state.view === 'agents') showAgents({ force: true, nav });
  else if (state.view === 'mcp') showMcp({ force: true, nav });
  else openFile(path || SYSTEM_PROMPT, { force: true, nav });
  return true;
}

// ---- files ------------------------------------------------------------------------------

function renderFiles() {
  const b = base();
  const others = state.files.filter((f) => f.path !== SYSTEM_PROMPT);
  const rows = [];
  let lastDir = null;
  for (const f of others) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (dir !== lastDir && dir) rows.push(`<div class="row dir">${esc(dir)}/</div>`);
    lastDir = dir;
    const name = f.path.slice(dir ? dir.length + 1 : 0);
    rows.push(`<div class="row${state.file?.path === f.path ? ' on' : ''}" data-path="${esc(f.path)}" style="padding-left:${dir ? 20 : 8}px">
      <span>${esc(name)}</span>${GENERATED.has(name) ? '<span class="tag">generated</span>' : ''}</div>`);
  }
  $('files').innerHTML = `${up('bases', 'Knowledge bases')}<h2>${esc(b.name)}</h2>
    <div class="row${state.file?.path === SYSTEM_PROMPT ? ' on' : ''}" data-path="${SYSTEM_PROMPT}">
      <span>${SYSTEM_PROMPT}</span><span class="tag${state.hasSystemPrompt ? '' : ' missing'}">${state.hasSystemPrompt ? 'agent instructions' : 'not written yet'}</span></div>
    <div class="row${state.view === 'agents' ? ' on' : ''}" id="agents" title="Which of its channels have thread agents">
      <span>Thread agents</span>${agentsTag()}</div>
    <div class="row${state.view === 'mcp' ? ' on' : ''}" id="mcp" title="Tools its agents get where they are turned on, and MCP servers they call from code mode">
      <span>Tools and MCP servers</span>${toolsTag()}${mcpTag()}</div>
    <h2>Files</h2>
    ${rows.join('') || '<div class="empty" style="padding:8px">Empty so far.</div>'}
    ${state.truncated ? '<div class="empty" style="padding:8px">Only the first 400 entries are shown.</div>' : ''}
    <div class="tools">${mayEdit() ? '<button id="new">New file</button>' : ''}<button id="history"${state.view === 'history' ? ' class="primary"' : ''}>History</button></div>
    ${mayEdit() ? '' : `<div class="empty ro" style="padding:8px">Read-only: ${esc(whoEdits())} change it.</div>`}`;
  for (const el of $('files').querySelectorAll('[data-path]')) {
    el.onclick = () => openFile(el.dataset.path);
  }
  if ($('new')) $('new').onclick = newFile;
  $('history').onclick = () => showHistory();
  $('agents').onclick = () => showAgents();
  $('mcp').onclick = () => showMcp();
}

// ---- thread agents ----------------------------------------------------------------------

/** The channels this knowledge base learns from, with their agents; null when unknown. */
async function loadChannels(repo) {
  const { ok, body } = await call(`/api/kb/channels?repo=${encodeURIComponent(repo)}`);
  if (state.repo !== repo) return;
  state.channels = ok ? body.channels : null;
  state.configured = ok ? body.configured : true;
  state.teamDefault = ok ? body.teamDefault || null : null;
}

/**
 * The counts of the list of knowledge bases (agents, tools, entries), again: switches and
 * saves here change them, in this knowledge base and in those of its channels' team or customer.
 */
async function refreshBases() {
  const r = await call('/api/kb');
  if (!r.ok) return;
  for (const x of r.body.bases) {
    const mine = state.bases.find((y) => y.repo === x.repo);
    if (mine) Object.assign(mine, { agents: x.agents, tools: x.tools, entries: x.entries });
  }
  renderBases();
}

const agentCount = () => (state.channels || []).filter((c) => c.agent.enabled).length;

/** "on in 2 of 5 channels", or "off", next to "Thread agents". */
function agentsTag() {
  if (!state.channels) return '<span class="tag missing">unknown</span>';
  const on = agentCount();
  const of = state.channels.filter((c) => c.kind === 'channel').length;
  return on ? `<span class="tag agent">on in ${on} of ${of} channel${of === 1 ? '' : 's'}</span>` : '<span class="tag missing">off</span>';
}

const SOURCES = { slack: 'Slack', teams: 'Teams', discord: 'Discord' };
const channelName = (c) => (c.source !== 'teams' ? `#${c.name || c.channelId}`
  : [c.groupName, c.name].filter(Boolean).join(' › ') || c.channelId);

function ago(at) {
  if (!at) return '';
  const d = (Date.now() - new Date(at).getTime()) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  return new Date(at).toLocaleDateString();
}

async function showAgents({ force = false, nav = 'push' } = {}) {
  if (!force && state.file && !(await leave())) return false;
  if (!force) showPane('editor');
  state.view = 'agents';
  state.file = null;
  renderFiles();
  toUrl(nav);
  renderAgents();
  return true;
}

/** For a team's knowledge base: the switch that gives its channels agents unless switched off. */
function teamDefaultRow() {
  const b = base();
  const d = state.teamDefault;
  if (b.kind !== 'team' || !d) return '';
  const by = d.by ? `Turned ${d.enabled ? 'on' : 'off'} by ${esc(d.by)}, ${esc(ago(d.at))}` : '';
  return `<div class="ch default">
      <div class="who">
        <div class="nm">On by default</div>
        <div class="sub">${d.enabled ? `Every channel of ${esc(b.name)} has a thread agent, new ones too, unless it is switched off below.`
    : `Off: only the channels switched on below have thread agents. On, every channel of ${esc(b.name)} nobody switched gets one, new ones too.`}</div>
        ${by ? `<div class="sub by">${by}</div>` : ''}
      </div>
      <span class="state${d.enabled ? ' on' : ''}">${d.enabled ? 'On' : 'Off'}</span>
      <button class="switch" role="switch" aria-checked="${d.enabled}" aria-label="Thread agents by default in ${esc(b.name)}"
        title="${d.may ? `Turn agents by default ${d.enabled ? 'off' : 'on'}` : `Only the admin team and the managers of ${esc(b.name)} change it.`}" id="teamDefault"${d.may ? '' : ' disabled'}></button>
    </div>`;
}

// ---- the agent's thinking, for you -----------------------------------------------------
//
// Your own settings (/api/settings, src/settings.js), not the knowledge base's: whether the
// inbox shows the agent's thinking under a thread (what it is doing while it works, its note
// once done), everywhere (`traces`) and in one channel (`channelTraces`, which wins). Anyone
// who sees the agents changes them; the inbox's user menu has them too.

/** `{ on, own }`: whether the agent's thinking shows for you in a channel, and whether it is set there. */
function tracesIn(channel) {
  const s = state.settings || {};
  const own = s.channelTraces?.[channel];
  return { on: typeof own === 'boolean' ? own : s.traces !== false, own: typeof own === 'boolean' };
}

/** The switch above the channels: the agent's thinking, for you, in every channel. */
function tracesRow() {
  if (!state.settings) return '';
  const on = state.settings.traces !== false;
  const set = Object.keys(state.settings.channelTraces || {}).length;
  return `<div class="ch default mine">
      <div class="who">
        <div class="nm">The agent's thinking, for you</div>
        <div class="sub">${on ? 'Your inbox shows it under the threads of every channel with an agent: what it is doing while it works, and its note once done.'
    : 'Hidden in your inbox: no agent\'s work or notes under the threads.'}${set ? ` ${set} channel${set === 1 ? ' is' : 's are'} set on ${set === 1 ? 'its' : 'their'} own, below or in the inbox, and win${set === 1 ? 's' : ''}.` : ' A channel set on its own below wins.'}</div>
        <div class="sub by">Only for you, in every browser; nobody else's inbox changes.</div>
      </div>
      <span class="state${on ? ' on' : ''}">${on ? 'Shown' : 'Hidden'}</span>
      <button class="switch" role="switch" aria-checked="${on}" aria-label="Show the agent's thinking in your inbox" id="tracesAll"
        title="${on ? 'Hide the agent\'s thinking in your inbox' : 'Show the agent\'s thinking in your inbox'}"></button>
    </div>`;
}

/** A channel's own choice, in its row: as everywhere, shown, or hidden (where it has an agent, or a choice). */
function tracesSelect(c) {
  if (!state.settings || c.kind !== 'channel') return '';
  const { own, on } = tracesIn(c.channelId);
  if (!c.agent.enabled && !own) return '';
  const all = state.settings.traces !== false ? 'shown' : 'hidden';
  const value = own ? (on ? 'on' : 'off') : '';
  return `<label class="sub mine">The agent's thinking, for you
      <select data-traces="${esc(c.channelId)}" aria-label="The agent's thinking in ${esc(channelName(c))}, for you">
        <option value=""${value === '' ? ' selected' : ''}>As everywhere (${all})</option>
        <option value="on"${value === 'on' ? ' selected' : ''}>Shown</option>
        <option value="off"${value === 'off' ? ' selected' : ''}>Hidden</option>
      </select></label>`;
}

/** Saves your settings; says how it went in the note. */
async function saveTraces(patch, done) {
  const repo = state.repo;
  const { ok, body } = await call('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  if (state.repo !== repo || state.view !== 'agents') return;
  if (!ok) { renderAgents({ kind: 'err', text: body.error || 'Saving your setting failed.' }); return; }
  state.settings = body;
  renderAgents({ kind: 'ok', text: done });
}

function bindTraces() {
  if ($('tracesAll')) {
    $('tracesAll').onclick = () => {
      const on = state.settings.traces === false;
      saveTraces({ traces: on }, on ? 'Your inbox shows the agent\'s thinking again, except in channels set to hide it.'
        : 'Your inbox hides the agent\'s thinking, except in channels set to show it.');
    };
  }
  for (const el of $('editor').querySelectorAll('[data-traces]')) {
    el.onchange = () => {
      const c = state.channels.find((x) => x.channelId === el.dataset.traces);
      const on = el.value === '' ? null : el.value === 'on';
      saveTraces({ channelTraces: { [c.channelId]: on } }, on === null
        ? `The agent's thinking in ${channelName(c)} is as everywhere again, for you.`
        : `Your inbox ${on ? 'shows' : 'hides'} the agent's thinking in ${channelName(c)}.`);
    };
  }
}

function renderAgents(note) {
  const b = base();
  const list = state.channels;
  const whose = b.kind === 'team' ? `the channels of ${b.name}` : `the channels of ${b.name}, in every ops team`;
  const explain = `A thread agent follows every thread of a channel where it is on: it reads each new message, keeps a draft
    reply for the team (it never posts) and files what it learns in the team's and the customer's knowledge bases.
    The admin team and the managers of the team that owns a channel turn it on or off.${mayEdit() ? ''
    : ' Here you see them; what you change is only whether your inbox shows the agent\'s thinking.'}`;
  const rows = (list || []).map((c) => {
    const a = c.agent;
    const alert = c.kind !== 'channel';
    let by = '';
    if (a.set && a.by) by = `Turned ${a.enabled ? 'on' : 'off'} by ${esc(a.by)}, ${esc(ago(a.at))}`;
    else if (a.via === 'team') by = `On by default for ${esc(c.teamName)}`;
    else if (a.enabled) by = 'On by default (AGENT_CHANNELS)';
    const why = alert ? 'Alert channels have no thread agents.'
      : c.may ? `Turn the agent ${a.enabled ? 'off' : 'on'}` : `Only the admin team and the managers of ${c.teamName} turn it on or off.`;
    return `<div class="ch" data-row="${esc(c.channelId)}">
      <div class="who">
        <div class="nm">${esc(channelName(c))}<span class="src">${esc(SOURCES[c.source] || c.source)}</span>${alert ? '<span class="src">alerts</span>' : ''}</div>
        <div class="sub">${esc([b.kind === 'org' ? c.teamName : c.org, `${c.threads} thread${c.threads === 1 ? '' : 's'}`, c.latest && `last ${ago(c.latest)}`].filter(Boolean).join(' · '))}</div>
        ${by ? `<div class="sub by">${by}</div>` : ''}
        ${tracesSelect(c)}
      </div>
      <span class="state${a.enabled ? ' on' : ''}">${a.enabled ? 'On' : 'Off'}</span>
      <button class="switch" role="switch" aria-checked="${a.enabled}" aria-label="Thread agent in ${esc(channelName(c))}" title="${esc(why)}"
        data-channel="${esc(c.channelId)}"${c.may ? '' : ' disabled'}></button>
    </div>`;
  }).join('');
  $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="title">Thread agents in ${esc(whose)}</span></div>
    <div class="note${note ? ` ${note.kind}` : state.configured ? '' : ' warn'}" id="note">${note ? esc(note.text)
  : state.configured ? explain : 'Agents are not configured in this deployment: a channel\'s switch takes effect once they are.'}</div>
    <div class="channels">${list ? tracesRow() + teamDefaultRow() + (rows || '<div class="empty">No channels yet.</div>') : '<div class="empty">Could not list the channels.</div>'}</div>`;
  for (const el of $('editor').querySelectorAll('[data-channel]')) {
    el.onclick = () => switchAgent(state.channels.find((c) => c.channelId === el.dataset.channel), el);
  }
  if ($('teamDefault')) $('teamDefault').onclick = () => switchTeamDefault($('teamDefault'));
  bindTraces();
  // Opened from a thread's agent in the inbox: its channel, marked for a moment.
  const focus = state.focusChannel && $('editor').querySelector(`[data-row="${CSS.escape(state.focusChannel)}"]`);
  state.focusChannel = null;
  if (focus) {
    focus.scrollIntoView({ block: 'center' });
    focus.classList.add('found');
    setTimeout(() => focus.classList.remove('found'), 2400);
  }
}

/** A channel's switch: takes effect right away, no question (it is one channel, and switches back). */
async function switchAgent(c, el) {
  const on = !c.agent.enabled;
  const name = channelName(c);
  const repo = state.repo;
  el.disabled = true;
  const { status, ok, body } = await call('/api/kb/agent', {
    method: 'PUT',
    body: JSON.stringify({ channel: c.channelId, enabled: on }),
  });
  if (state.repo !== repo || state.view !== 'agents') return;
  if (!ok) { renderAgents({ kind: 'err', text: body.error || `Switching failed (${status}).` }); return; }
  c.agent = body.agent;
  const b = base();
  if (b) b.agents = agentCount();
  // The other knowledge bases of the channel (its team's, its customer's) count it too.
  refreshBases();
  renderBases();
  renderFiles();
  renderAgents({
    kind: 'ok',
    text: on ? `The thread agent in ${name} is on: every thread that gets a new message has one, which keeps a draft reply (it never posts) and files what it learns.`
      : `The thread agent in ${name} is off: its threads' agents stop at their next message. Their drafts, and what they filed, stay.`,
  });
}

/** The team's default: asks first, since it turns on (or off) the agents of many channels at once. */
async function switchTeamDefault(el) {
  const b = base();
  const on = !state.teamDefault.enabled;
  const unset = (state.channels || []).filter((c) => c.kind === 'channel' && !c.agent.set && c.agent.via !== 'deployment');
  const n = `${unset.length} channel${unset.length === 1 ? '' : 's'}`;
  const yes = await ask(
    on ? `Turn on thread agents by default in ${b.name}?` : `Turn off thread agents by default in ${b.name}?`,
    on ? `${unset.length ? `${n} nobody switched get${unset.length === 1 ? 's' : ''} an agent now` : 'No channel changes now'}, and every channel ${b.name} gets later has one too. Channels switched off stay off.`
      : `${unset.length ? `The agents of ${n} nobody switched stop at their next message` : 'No channel changes now'}; channels switched on stay on, and new channels have no agent.`,
    on ? 'Turn on' : 'Turn off',
  );
  if (!yes) return;
  const repo = state.repo;
  el.disabled = true;
  const { status, ok, body } = await call('/api/kb/agent', { method: 'PUT', body: JSON.stringify({ team: b.slug, enabled: on }) });
  if (state.repo !== repo || state.view !== 'agents') return;
  if (!ok) { renderAgents({ kind: 'err', text: body.error || `Switching failed (${status}).` }); return; }
  await loadChannels(repo);
  if (state.repo !== repo || state.view !== 'agents') return;
  b.agents = agentCount();
  refreshBases();
  renderFiles();
  renderAgents({ kind: 'ok', text: on ? `Thread agents are on by default in ${b.name}.` : `Thread agents are off by default in ${b.name}.` });
}

// ---- MCP servers ------------------------------------------------------------------------
//
// The MCP servers the thread agents of this team (kb-team-*) or customer (kb-org-*) may use,
// over /api/kb/mcp (src/mcpadmin.js). Agents call their tools from code mode scripts, as
// `tools.mcp__<name>__<tool>`. Credentials are request headers: sent once, then only their
// names come back. Or the server signs in with OAuth: Connect sends the browser to the server's
// sign-in (/api/kb/mcp/oauth/start), which comes back to the editor with `mcp_connected=<id>`
// or `mcp_error=<why>` (src/agent/mcpoauth.js); the agents then act as whoever connected it.

/** This knowledge base's MCP servers, and the global ones; null when unknown. */
async function loadMcp(repo) {
  const { ok, body } = await call(`/api/kb/mcp?repo=${encodeURIComponent(repo)}`);
  if (state.repo !== repo) return;
  state.mcp = ok ? body.servers : null;
  state.globals = ok ? body.globals || [] : null;
}

/** Whether a global server is on somewhere here: for the team, or in any of these channels. */
const globalOn = (g) => Boolean((g.team && g.team.enabled) || Object.values(g.channels).some((c) => c.enabled));

const mcpUsable = (s) => {
  const allowed = String(s.allow || '').split(/[\s,]+/).filter(Boolean);
  return allowed.length ? s.tools.filter((t) => allowed.includes(t.name)).length : s.tools.length;
};

/** "2 servers", or "none", next to "MCP servers". */
function mcpTag() {
  if (!state.mcp) return '<span class="tag missing">unknown</span>';
  const on = state.mcp.filter((s) => s.enabled).length + (state.globals || []).filter(globalOn).length;
  return on ? `<span class="tag agent">${on} server${on === 1 ? '' : 's'}</span>` : '<span class="tag missing">none</span>';
}

async function showMcp({ force = false, nav = 'push' } = {}) {
  if (!force && state.file && !(await leave())) return false;
  state.view = 'mcp';
  state.file = null;
  state.editing = null;
  renderFiles();
  toUrl(nav);
  renderMcp();
  return true;
}

/** How an OAuth server is signed in, for its row. */
function oauthCreds(o) {
  if (o.connected) return `OAuth: connected by ${o.by}, ${ago(o.at)}; the agents act as them`;
  return o.by ? `OAuth: connected by ${o.by}, no longer works` : 'OAuth: not connected';
}

function mcpRow(s) {
  const allowed = new Set(String(s.allow || '').split(/[\s,]+/).filter(Boolean));
  const usable = mcpUsable(s);
  const oauth = s.auth === 'oauth' ? s.oauth : null;
  let status = '<span class="src">not checked</span>';
  if (oauth && !oauth.connected) status = `<span class="src${oauth.error ? ' err' : ''}">${oauth.error ? 'sign-in expired' : 'not connected'}</span>`;
  else if (s.checkError) status = '<span class="src err">unreachable</span>';
  else if (s.checkedAt) status = `<span class="src ok">${usable} tool${usable === 1 ? '' : 's'}</span>`;
  const tools = s.tools.map((t) => {
    const off = allowed.size && !allowed.has(t.name);
    return `<span class="src${off ? ' off' : ''}" title="${esc(t.description || '')}${t.readOnly ? ' (read-only)' : ''}${off ? ' (not for agents)' : ''}">${esc(t.name)}</span>`;
  }).join('');
  const creds = oauth ? oauthCreds(oauth)
    : s.headerNames.length ? s.headerNames.map((h) => `${h} ••••`).join(', ') : 'no credentials';
  const signIn = oauth ? `<button data-connect="${s.id}"${oauth.connected ? '' : ' class="primary"'}>${oauth.connected ? 'Reconnect' : 'Connect'}</button>${oauth.connected ? `<button data-disconnect="${s.id}">Disconnect</button>` : ''}` : '';
  const checkable = !oauth || oauth.connected;
  return `<div class="ch">
    <div class="who">
      <div class="nm">${esc(s.name)}<span class="src mono">mcp__${esc(s.name.replace(/[^a-z0-9_]/g, '_'))}</span>${status}</div>
      <div class="sub">${esc([s.description, s.url].filter(Boolean).join(' · '))}</div>
      ${oauth && oauth.error ? `<div class="sub err">${esc(oauth.error)}</div>` : ''}
      ${s.checkError ? `<div class="sub err">${esc(s.checkError)}</div>` : ''}
      ${tools ? `<div class="tags">${tools}</div>` : ''}
      <div class="sub by">${esc([creds, s.checkedAt && `checked ${ago(s.checkedAt)}`, s.updatedBy && `changed by ${s.updatedBy}`].filter(Boolean).join(' · '))}</div>
    </div>
    ${mayEdit() ? `<span class="acts">${signIn}${checkable ? `<button data-check="${s.id}">Check</button>` : ''}<button data-edit="${s.id}">Edit</button><button class="danger" data-del="${s.id}">Delete</button></span>` : ''}
    <span class="state${s.enabled ? ' on' : ''}">${s.enabled ? 'On' : 'Off'}</span>
    <button class="switch" role="switch" aria-checked="${s.enabled}" aria-label="Agents use ${esc(s.name)}" title="${mayEdit() ? (s.enabled ? 'Agents use it; turn it off' : 'Turn it on for the agents') : `Only ${esc(whoEdits())} change it.`}" data-server="${s.id}"${mayEdit() ? '' : ' disabled'}></button>
  </div>`;
}

// ---- agent tools --------------------------------------------------------------------------
//
// Tools the thread agents get only where they are turned on (src/agent/agenttools.js), over
// /api/kb/tools (src/tooladmin.js): post_message, and the computer (pi's bash tool on
// Cloudflare Computer). For a team, or one channel; a channel's switch wins over its team's.
// They are the first group of the tools and MCP servers page (renderMcp).

/** The agent tools of this knowledge base's team or customer; null when unknown. */
async function loadTools(repo) {
  const { ok, body } = await call(`/api/kb/tools?repo=${encodeURIComponent(repo)}`);
  if (state.repo !== repo) return;
  state.tools = ok ? body.tools : null;
}

const toolOn = (t) => Boolean((t.team && t.team.enabled) || Object.values(t.channels).some((c) => c.enabled));

/** "2 tools" next to "Tools and MCP servers", when any is on; their names on hover. */
function toolsTag() {
  const on = (state.tools || []).filter(toolOn);
  return on.length ? `<span class="tag agent" title="${esc(on.map((t) => t.names.join(', ')).join(', '))}">${on.length} tool${on.length === 1 ? '' : 's'}</span>` : '';
}

/**
 * The per-channel switches of a tool or a global server: the channels switched on their own
 * first, then by name, with a filter when there are many. In a customer's knowledge base they
 * are all there is (no team switch above them), so they are shown; in a team's they fold.
 * `kind` names the select (`tch`, `gch`), `fold` the <details> (`tper`, `per`).
 */
function channelSwitches({
  kind, fold, id, title, switches, team, works = () => true, open,
}) {
  const b = base();
  const list = (state.channels || []).filter((c) => c.kind === 'channel');
  if (!list.length) return '';
  const set = list.filter((c) => switches[c.channelId]).length;
  const key = `${kind}:${id}`;
  const q = (state.perFilter[key] || '').trim().toLowerCase();
  const label = (c) => `${channelName(c)}${b.kind === 'org' ? ` · ${c.teamName}` : ''}`;
  const plain = (c) => channelName(c).replace(/^#/, '');
  const sorted = [...list].sort((x, y) => Number(Boolean(switches[y.channelId])) - Number(Boolean(switches[x.channelId]))
    || plain(x).localeCompare(plain(y)));
  const teamState = team ? (team.enabled ? 'on' : 'off') : null;
  const rows = sorted.map((c) => {
    const ok = works(c);
    const sw = switches[c.channelId];
    const value = sw ? (sw.enabled ? 'on' : 'off') : '';
    const where = SOURCES[c.source] || c.source;
    const tip = !ok ? `Not on ${where}` : sw && sw.by ? `Turned ${sw.enabled ? 'on' : 'off'} by ${sw.by}, ${ago(sw.at)}` : '';
    const hidden = q && !label(c).toLowerCase().includes(q);
    return `<div class="row2" data-find="${esc(label(c).toLowerCase())}"${hidden ? ' hidden' : ''}><span title="${esc(tip)}">${esc(label(c))}${ok ? '' : ` <i class="na">not on ${esc(where)}</i>`}</span>
      <select data-${kind}="${esc(id)}" data-channel="${esc(c.channelId)}" aria-label="${esc(title)} in ${esc(channelName(c))}"${c.may && ok ? '' : ' disabled'}>
        <option value=""${value === '' ? ' selected' : ''}>As its team${teamState ? ` (${teamState})` : ''}</option>
        <option value="on"${value === 'on' ? ' selected' : ''}>On</option>
        <option value="off"${value === 'off' ? ' selected' : ''}>Off</option>
      </select></div>`;
  }).join('');
  const matches = sorted.filter((c) => !q || label(c).toLowerCase().includes(q)).length;
  const find = list.length >= 6 ? `<input type="search" class="find" data-find-for="${esc(key)}" value="${esc(state.perFilter[key] || '')}"
    placeholder="Filter ${list.length} channels" aria-label="Filter the channels of ${esc(title)}">` : '';
  const none = `<div class="none"${matches ? ' hidden' : ''}>No channel matches.</div>`;
  if (b.kind === 'org') return `<div class="per flat">${find}${rows}${none}</div>`;
  return `<details class="per"${open ? ' open' : ''} data-${fold}="${esc(id)}"><summary>Per channel${set ? ` (${set} set)` : ''}</summary>${find}${rows}${none}</details>`;
}

/** The per-channel switches of a tool; channels on a platform it does not work on are left off. */
const toolPerChannel = (t) => channelSwitches({
  kind: 'tch',
  fold: 'tper',
  id: t.tool,
  title: t.title,
  switches: t.channels,
  team: t.team,
  works: (c) => !t.platforms || t.platforms.includes(c.source),
  open: state.openTool === t.tool,
});

function toolRow(t) {
  const b = base();
  const on = Boolean(t.team && t.team.enabled);
  const by = t.team && t.team.by ? `Turned ${on ? 'on' : 'off'} for ${esc(b.name)} by ${esc(t.team.by)}, ${esc(ago(t.team.at))}` : '';
  const platforms = t.platforms ? `<span class="src">${esc(t.platforms.map((p) => SOURCES[p] || p).join(', '))} only</span>` : '';
  const sw = t.team ? `<span class="state${on ? ' on' : ''}">${on ? 'On' : 'Off'}</span>
    <button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(t.title)} for ${esc(b.name)}"
      title="${mayEdit() ? (on ? `Agents of ${esc(b.name)} have it; turn it off` : `Turn it on for every channel of ${esc(b.name)}`) : `Only ${esc(whoEdits())} change it.`}" data-tteam="${esc(t.tool)}"${mayEdit() ? '' : ' disabled'}></button>` : '';
  return `<div class="ch global">
    <div class="who">
      <div class="nm">${esc(t.title)}<span class="src mono">${esc(t.names.join(', '))}</span>${platforms}${t.problem ? '<span class="src err">not set up</span>' : ''}</div>
      <div class="sub">${esc(t.description)}</div>
      ${t.note ? `<div class="sub">${esc(t.note)}</div>` : ''}
      ${t.problem ? `<div class="sub err">${esc(t.problem)}</div>` : ''}
      ${by ? `<div class="sub by">${by}</div>` : ''}
    </div>
    ${sw}
    ${toolPerChannel(t)}
  </div>`;
}

const TOOL_CONFIRM = {
  post_message: {
    on: (where) => `From their next message, the agents of ${where} can post replies in their threads themselves, as the opspile app, without a person reading them first. They still keep drafts for anything a person should review.`,
    off: (where) => `Agents of ${where} only keep drafts again, from their next message.`,
  },
  computer: {
    on: (where) => `From their next message, the agents of ${where} have a bash shell with a working directory of their own per thread (Cloudflare Computer), and curl, which reaches the internet without a filter.`,
    off: (where) => `Agents of ${where} lose their shell with their next message. The files they made stay in their threads.`,
  },
};

/** The built-in tools, as the first group of the tools and MCP servers page. */
function toolsSection() {
  const b = base();
  if (!state.tools) return '<div class="empty">Could not list the agent tools.</div>';
  const note = b.kind === 'team' ? `opspile's own tools: off until they are turned on for every channel of ${b.name}, or for one of its channels (a channel's own switch wins).`
    : `opspile's own tools: turned on for a whole team in its knowledge base, or here for one of ${b.name}'s channels.`;
  return `<h3 class="group">Tools</h3><div class="sub" style="color:var(--mute);font-size:12px;margin:0 2px 4px">${esc(note)}</div>${state.tools.map(toolRow).join('')}`;
}

/** The handlers of the built-in tools' switches. */
function bindTools() {
  const b = base();
  if (!state.tools) return;
  const repo = state.repo;
  const find = (tool) => state.tools.find((t) => t.tool === tool);
  const stale = () => state.repo !== repo || state.view !== 'mcp';
  for (const el of $('editor').querySelectorAll('[data-tper]')) {
    el.addEventListener('toggle', () => { state.openTool = el.open ? el.dataset.tper : null; });
  }
  for (const el of $('editor').querySelectorAll('[data-tteam]')) {
    el.onclick = async () => {
      const t = find(el.dataset.tteam);
      const on = !(t.team && t.team.enabled);
      const yes = await ask(
        on ? `Turn on ${t.title} for ${b.name}?` : `Turn off ${t.title} for ${b.name}?`,
        `${TOOL_CONFIRM[t.tool][on ? 'on' : 'off'](`every channel of ${b.name}`)} Channels switched on their own keep their switch.`,
        on ? 'Turn on' : 'Turn off',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/tools', { method: 'PUT', body: JSON.stringify({ tool: t.tool, team: b.slug, enabled: on }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Switching failed.' }); return; }
      t.team = body.switch;
      renderFiles();
      refreshBases();
      renderMcp({ kind: 'ok', text: `${t.title} is ${on ? 'on' : 'off'} for ${b.name}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-tch]')) {
    el.onchange = async () => {
      const t = find(el.dataset.tch);
      const c = state.channels.find((x) => x.channelId === el.dataset.channel);
      const enabled = el.value === '' ? null : el.value === 'on';
      if (enabled && !(await ask(`Turn on ${t.title} in ${channelName(c)}?`, TOOL_CONFIRM[t.tool].on(channelName(c)), 'Turn on'))) {
        renderMcp();
        return;
      }
      const { ok, body } = await call('/api/kb/tools', { method: 'PUT', body: JSON.stringify({ tool: t.tool, channel: c.channelId, enabled }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Switching failed.' }); return; }
      if (body.switch) t.channels[c.channelId] = body.switch;
      else delete t.channels[c.channelId];
      state.openTool = t.tool;
      renderFiles();
      refreshBases();
      renderMcp({ kind: 'ok', text: enabled === null ? `${t.title} in ${channelName(c)} follows its team again.` : `${t.title} is ${enabled ? 'on' : 'off'} in ${channelName(c)}.` });
    };
  }
}

// ---- global MCP servers ---------------------------------------------------------------
//
// opspile's own servers (src/agent/globals.js): the browser (Cloudflare Browser Run) and GitHub
// (read-only, as the opspile GitHub App). Set up once; off until they are turned on for a team
// here, or for one channel (a channel's switch wins over its team's).

const toolTags = (tools) => tools.map((t) => `<span class="src" title="${esc(t.description || '')}${t.readOnly ? ' (read-only)' : ''}">${esc(t.name)}</span>`).join('');

/** The GitHub App's installation page, where its repositories are picked: a link, in a new tab. */
const installLink = (app, label, primary) => `<a class="btn${primary ? ' primary' : ''}" href="${esc(app.installUrl)}"
  target="_blank" rel="noopener" title="${esc(app.installUrl)}">${esc(label)} ↗</a>`;

function githubSetup(g) {
  const gh = g.github;
  if (!gh) return '';
  if (!gh.installations) {
    // A team manager: installs the app on the repositories; the admin team allows each installation.
    return `<div class="setup"><span>Agents read the repositories the GitHub App
      <a href="${esc(gh.app.htmlUrl)}" target="_blank" rel="noopener">${esc(gh.app.slug)}</a> is installed on,
      once the admin team allows the installation.</span>
      ${installLink(gh.app, 'Install on repositories', !g.available)}</div>`;
  }
  if (!gh.app) {
    return `<form class="setup" id="ghCreate" autocomplete="off">
      <span>Create the GitHub App, read-only, on</span>
      <input id="ghOrg" class="mono" placeholder="your own account" aria-label="GitHub organization" title="The GitHub organization that owns the app; empty: your own account">
      <input id="ghName" placeholder="App name (unique on GitHub)" aria-label="App name">
      <button class="primary"${gh.configured ? '' : ' disabled title="TOKEN_KEY and PUBLIC_ORIGIN must be set"'}>Create on GitHub</button>
    </form>`;
  }
  const rows = gh.installations.map((i) => `<div class="row2"><span title="${esc(i.approved ? `Allowed by ${i.approvedBy}, ${ago(i.approvedAt)}` : 'Installed, but agents do not read it until it is allowed')}">${esc(i.account)}
      · ${i.selection === 'all' ? 'all repositories' : 'selected repositories'}${i.suspended ? ' · suspended' : ''}${i.approved ? '' : ' · <b>waiting to be allowed</b>'}</span>
      <button type="button" data-ghinst="${esc(i.id)}" data-allow="${i.approved ? '' : '1'}"${i.approved ? ' class="danger"' : ' class="primary"'}>${i.approved ? 'Revoke' : 'Allow'}</button></div>`).join('');
  return `<div class="setup"><span>GitHub App <a href="${esc(gh.app.htmlUrl)}" target="_blank" rel="noopener">${esc(gh.app.slug)}</a>
    ${gh.app.owner ? `of ${esc(gh.app.owner)}` : ''} · ${gh.installations.length ? 'anyone can install it; agents read only the installations allowed here' : 'not installed anywhere yet'}</span>
    ${installLink(gh.app, gh.installations.length ? 'Install elsewhere or change repositories' : 'Install on repositories', !gh.installations.length)}</div>
    ${rows ? `<div class="per">${rows}</div>` : ''}`;
}

const perChannel = (g) => channelSwitches({
  kind: 'gch', fold: 'per', id: g.server, title: g.server, switches: g.channels, team: g.team, open: state.openGlobal === g.server,
});

function globalRow(g) {
  const b = base();
  const first = g.instances[0];
  const tools = first ? first.tools : [];
  let status = '<span class="src">not checked</span>';
  if (!g.available) status = '<span class="src err">not set up</span>';
  else if (g.instances.some((i) => i.checkError)) status = '<span class="src err">unreachable</span>';
  else if (first && first.checkedAt) status = `<span class="src ok">${tools.length} tool${tools.length === 1 ? '' : 's'}</span>`;
  const names = g.instances.length ? g.instances.map((i) => `mcp__${i.name}`).join(', ') : `mcp__${g.server}`;
  const errors = g.instances.filter((i) => i.checkError).map((i) => `<div class="sub err">${esc(i.name)}: ${esc(i.checkError)}</div>`).join('');
  const on = Boolean(g.team && g.team.enabled);
  const by = g.team && g.team.by ? `Turned ${on ? 'on' : 'off'} for ${esc(b.name)} by ${esc(g.team.by)}, ${esc(ago(g.team.at))}` : '';
  const sw = g.team ? `<span class="state${on ? ' on' : ''}">${on ? 'On' : 'Off'}</span>
    <button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(g.title)} for ${esc(b.name)}"
      title="${mayEdit() ? (on ? `Agents of ${esc(b.name)} use it; turn it off` : `Turn it on for every channel of ${esc(b.name)}`) : `Only ${esc(whoEdits())} change it.`}" data-gteam="${esc(g.server)}"${mayEdit() ? '' : ' disabled'}></button>` : '';
  return `<div class="ch global">
    <div class="who">
      <div class="nm">${esc(g.title)}<span class="src mono">${esc(names)}</span>${status}</div>
      <div class="sub">${esc(g.description)}</div>
      ${g.problem ? `<div class="sub err">${esc(g.problem)}</div>` : ''}${errors}
      ${tools.length ? `<div class="tags">${toolTags(tools)}</div>` : ''}
      <div class="sub by">${[by, first && first.checkedAt && `checked ${esc(ago(first.checkedAt))}`].filter(Boolean).join(' · ')}</div>
    </div>
    <span class="acts">${g.available && mayEdit() ? `<button data-gcheck="${esc(g.server)}">Check</button>` : ''}</span>
    ${sw}
    ${githubSetup(g)}
    ${perChannel(g)}
  </div>`;
}

function mcpForm(s = {}) {
  const set = s.headerNames && s.headerNames.length;
  const auth = s.auth || 'headers';
  const o = s.oauth || {};
  const hide = (kind) => (auth === kind ? '' : ' hidden');
  return `<form class="mcpform" id="mcpForm" autocomplete="off">
    <h3>${s.id ? `Edit ${esc(s.name)}` : 'Add a server'}</h3>
    <label for="mName">Name</label><input id="mName" class="mono" placeholder="docs" value="${esc(s.name || '')}" required pattern="[a-z][a-z0-9_\\-]*" style="max-width:240px">
    <label for="mUrl">URL</label><input id="mUrl" class="mono" placeholder="https://mcp.example.com/mcp" value="${esc(s.url || '')}" required>
    <label for="mDesc">What it is for</label><input id="mDesc" placeholder="Told to the agents, e.g. Product documentation search" value="${esc(s.description || '')}">
    <label for="mAuth">Sign-in</label><select id="mAuth" style="max-width:360px">
      <option value="headers"${auth === 'headers' ? ' selected' : ''}>Request headers: an API key or a token</option>
      <option value="oauth"${auth === 'oauth' ? ' selected' : ''}>OAuth: someone signs in at the server</option></select>
    <label for="mHdrName" data-auth="headers"${hide('headers')}>Header</label><span class="pair" data-auth="headers"${hide('headers')}><input id="mHdrName" class="mono" placeholder="Authorization"><input id="mHdrValue" class="mono" type="password" placeholder="Bearer …"></span>
    <span class="hint" data-auth="headers"${hide('headers')}>${set ? `${esc(s.headerNames.join(', '))} set; fill in a header to replace ${s.headerNames.length === 1 ? 'it' : 'them'}.` : 'An API key or a bearer token. Stored encrypted, never shown again.'}</span>
    <span class="hint wide" data-auth="oauth"${hide('oauth')}>Once it is saved, Connect sends you to the server's sign-in, and the agents then call it as you, with what you may do there. Most servers let opspile register itself; for one that does not, register a client there with the redirect URI <span class="mono">${esc(location.origin)}/api/kb/mcp/oauth/callback</span> and give its id.</span>
    <label for="mClientId" data-auth="oauth"${hide('oauth')}>Client id</label><input id="mClientId" data-auth="oauth" class="mono" placeholder="optional: opspile registers itself" value="${esc(o.clientId || '')}"${hide('oauth')}>
    <label for="mClientSecret" data-auth="oauth"${hide('oauth')}>Client secret</label><input id="mClientSecret" data-auth="oauth" class="mono" type="password" placeholder="${o.clientSecret ? 'set; fill in to replace it' : 'optional, with a client id'}"${hide('oauth')}>
    <label for="mScope" data-auth="oauth"${hide('oauth')}>Scope</label><input id="mScope" data-auth="oauth" class="mono" placeholder="optional: what the server asks for" value="${esc(o.scope || '')}"${hide('oauth')}>
    <label for="mAllow">Only these tools</label><input id="mAllow" class="mono" placeholder="all tools; or comma-separated names" value="${esc(s.allow || '')}">
    <span class="apply"><button class="primary" id="mSave">${s.id ? 'Save' : 'Add'} ${auth === 'oauth' && !o.connected ? 'and connect' : 'and check'}</button>${s.id ? '<button type="button" id="mCancel">Cancel</button>' : ''}
      ${set ? `<button type="button" class="danger" id="mClear" data-auth="headers"${hide('headers')}>Remove the headers</button>` : ''}</span>
  </form>`;
}

/** What the server's sign-in said, when the editor opens after it: once. */
function flashNote() {
  const f = state.flash;
  state.flash = null;
  if (!f) return null;
  if (f.error) return { kind: 'err', text: `The sign-in did not work: ${f.error}` };
  const s = (state.mcp || []).find((x) => String(x.id) === f.connected);
  if (!s) return null;
  if (s.checkError) return { kind: 'warn', text: `Connected ${s.name} as you, but it could not be reached: ${s.checkError}` };
  return { kind: 'ok', text: `Connected ${s.name} as you: ${mcpUsable(s)} tool${mcpUsable(s) === 1 ? '' : 's'} for the agents.` };
}

function renderMcp(shownNote) {
  const note = shownNote || flashNote();
  const b = base();
  const list = state.mcp;
  const whose = b.kind === 'team' ? `the threads of ${b.name}` : `the threads of ${b.name}, in every ops team`;
  const explain = `What the thread agents of these threads can do beyond reading and drafting: opspile's own tools, which
    they call directly, and MCP servers, whose tools they call from code mode scripts, as tools.mcp__<name>__<tool> (only what
    a script outputs reaches the model). Adding or changing a server connects to it and lists its tools. The admin team${b.kind === 'team' ? ` and the managers of ${b.name}` : ''} manage them${mayEdit() ? '' : '; you see them read-only'}.`;
  const editing = state.editing && list ? list.find((x) => x.id === state.editing) : null;
  const globals = state.globals || [];
  const globalNote = b.kind === 'team' ? `opspile's own, set up once for every team: off until they are turned on for ${b.name}, or for one of its channels.`
    : `opspile's own, set up once for every team: turned on for a whole team in its knowledge base, or here for one of ${b.name}'s channels.`;
  $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="title">Tools and MCP servers for ${esc(whose)}</span></div>
    <div class="note${note ? ` ${note.kind}` : state.configured ? '' : ' warn'}" id="note">${note ? esc(note.text)
  : state.configured ? esc(explain) : 'Agents are not configured in this deployment: servers take effect once they are.'}</div>
    <div class="channels">${toolsSection()}${globals.length ? `<h3 class="group">Global MCP servers</h3><div class="sub" style="color:var(--mute);font-size:12px;margin:0 2px 4px">${esc(globalNote)}</div>${globals.map(globalRow).join('')}
      <h3 class="group">${b.kind === 'team' ? 'The team\'s servers' : 'The customer\'s servers'}</h3>` : ''}
    ${list ? list.map(mcpRow).join('') || '<div class="empty">No MCP server yet: agents here use the knowledge bases and GitHub only.</div>'
    : '<div class="empty">Could not list the MCP servers.</div>'}
    ${list && mayEdit() ? mcpForm(editing || {}) : ''}</div>`;
  bindTools();
  bindGlobals();
  bindFinds();
  if (!list || !mayEdit()) return;
  const find = (id) => list.find((x) => String(x.id) === String(id));
  const put = (server) => {
    state.mcp = state.mcp.some((x) => x.id === server.id) ? state.mcp.map((x) => (x.id === server.id ? server : x))
      : [...state.mcp, server].sort((x, y) => x.name.localeCompare(y.name));
    renderFiles();
    refreshBases();
  };
  const reached = (s) => (s.checkError ? { kind: 'warn', text: `${s.name} could not be reached: ${s.checkError}` }
    : { kind: 'ok', text: `${s.name}: ${mcpUsable(s)} tool${mcpUsable(s) === 1 ? '' : 's'} for the agents.` });
  for (const el of $('editor').querySelectorAll('[data-check]')) {
    el.onclick = async () => {
      renderMcp({ kind: '', text: `Connecting to ${find(el.dataset.check).name}…` });
      const { ok, body } = await call('/api/kb/mcp/check', { method: 'POST', body: JSON.stringify({ id: Number(el.dataset.check) }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      put(body.server);
      renderMcp(reached(body.server));
    };
  }
  for (const el of $('editor').querySelectorAll('[data-edit]')) {
    el.onclick = () => { state.editing = Number(el.dataset.edit); renderMcp(); $('mUrl').focus(); };
  }
  // Off to the server's sign-in; it comes back to this page (flashNote).
  const connect = async (s) => {
    const host = (() => { try { return new URL(s.url).host; } catch { return s.url; } })();
    const yes = await ask(
      `Connect ${s.name} as you?`,
      `You sign in at ${host}. From then on the agents of these threads call it as you, with everything you may do there, until someone disconnects it. "Only these tools" limits which of its tools they get.`,
      'Sign in',
    );
    if (!yes) return;
    renderMcp({ kind: '', text: `Finding the sign-in of ${s.name}…` });
    const { ok, body } = await call('/api/kb/mcp/oauth/start', { method: 'POST', body: JSON.stringify({ id: s.id }) });
    if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Could not start the sign-in.' }); return; }
    location.assign(body.authorizationUrl);
  };
  for (const el of $('editor').querySelectorAll('[data-connect]')) {
    el.onclick = () => connect(find(el.dataset.connect));
  }
  for (const el of $('editor').querySelectorAll('[data-disconnect]')) {
    el.onclick = async () => {
      const s = find(el.dataset.disconnect);
      if (!(await ask(`Disconnect ${s.name}?`, 'Its sign-in is revoked where the server allows it, and forgotten. Agents cannot use it until someone connects it again.', 'Disconnect'))) return;
      const { ok, body } = await call('/api/kb/mcp/oauth/disconnect', { method: 'POST', body: JSON.stringify({ id: s.id }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      put(body.server);
      renderMcp({ kind: 'ok', text: `Disconnected ${s.name}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-del]')) {
    el.onclick = async () => {
      const s = find(el.dataset.del);
      if (!(await ask(`Delete the MCP server ${s.name}?`, 'Agents stop using it with their next message. Its credentials are deleted too.', 'Delete'))) return;
      const { ok, body } = await call('/api/kb/mcp', { method: 'DELETE', body: JSON.stringify({ id: s.id }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      state.mcp = state.mcp.filter((x) => x.id !== s.id);
      if (state.editing === s.id) state.editing = null;
      renderFiles();
      refreshBases();
      renderMcp({ kind: 'ok', text: `Deleted ${s.name}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-server]')) {
    el.onclick = async () => {
      const s = find(el.dataset.server);
      const on = !s.enabled;
      const yes = await ask(
        on ? `Turn on ${s.name} for the agents?` : `Turn off ${s.name} for the agents?`,
        on ? 'Agents of these threads can call its tools again, from their next message.' : 'Agents stop using it with their next message. Its settings and credentials stay.',
        on ? 'Turn on' : 'Turn off',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/mcp', { method: 'PUT', body: JSON.stringify({ id: s.id, enabled: on }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      put(body.server);
      renderMcp(on ? reached(body.server) : { kind: 'ok', text: `Agents do not use ${s.name} any more.` });
    };
  }
  const save = async (patch = {}) => {
    const id = editing ? editing.id : null;
    const name = $('mHdrName').value.trim();
    const value = $('mHdrValue').value.trim();
    const auth = $('mAuth').value;
    const secret = $('mClientSecret').value.trim();
    const payload = {
      ...(id ? { id } : { repo: state.repo }),
      name: $('mName').value.trim(),
      url: $('mUrl').value.trim(),
      description: $('mDesc').value.trim(),
      allow: $('mAllow').value.trim(),
      auth,
      ...(auth === 'headers' && (name || value) ? { headers: [{ name, value }] } : {}),
      ...(auth === 'oauth' ? {
        oauth: { clientId: $('mClientId').value.trim(), scope: $('mScope').value.trim(), ...(secret ? { clientSecret: secret } : {}) },
      } : {}),
      ...patch,
    };
    $('note').className = 'note';
    $('note').textContent = id ? 'Saving and checking…' : 'Adding and checking…';
    const repo = state.repo;
    const { ok, body } = await call('/api/kb/mcp', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (state.repo !== repo || state.view !== 'mcp') return;
    if (!ok) {
      $('note').className = 'note err';
      $('note').textContent = body.error || 'Saving failed.';
      return;
    }
    state.editing = null;
    put(body.server);
    const o = body.server.auth === 'oauth' ? body.server.oauth : null;
    if (o && !o.connected) {
      renderMcp({ kind: '', text: `${body.server.name} is saved, not connected yet: Connect signs you in at the server.` });
      connect(body.server);
      return;
    }
    renderMcp(reached(body.server));
  };
  $('mcpForm').onsubmit = (e) => { e.preventDefault(); save(); };
  // Headers or OAuth: only the fields of the one picked.
  $('mAuth').onchange = () => {
    for (const el of $('mcpForm').querySelectorAll('[data-auth]')) el.hidden = el.dataset.auth !== $('mAuth').value;
    const connects = $('mAuth').value === 'oauth' && !(editing && editing.oauth && editing.oauth.connected);
    $('mSave').textContent = `${editing ? 'Save' : 'Add'} ${connects ? 'and connect' : 'and check'}`;
  };
  if ($('mCancel')) $('mCancel').onclick = () => { state.editing = null; renderMcp(); };
  if ($('mClear')) $('mClear').onclick = () => save({ headers: {} });
}

/** The filters of the per-channel lists: they hide the rows that do not match, as you type. */
function bindFinds() {
  for (const el of $('editor').querySelectorAll('[data-find-for]')) {
    el.oninput = () => {
      state.perFilter[el.dataset.findFor] = el.value;
      const q = el.value.trim().toLowerCase();
      let shown = 0;
      for (const row of el.parentElement.querySelectorAll('.row2[data-find]')) {
        row.hidden = Boolean(q) && !row.dataset.find.includes(q);
        if (!row.hidden) shown += 1;
      }
      el.parentElement.querySelector('.none').hidden = shown > 0;
    };
  }
}

/** The handlers of the global servers' switches, checks and GitHub App setup. */
function bindGlobals() {
  const b = base();
  const repo = state.repo;
  const find = (server) => state.globals.find((g) => g.server === server);
  const stale = () => state.repo !== repo || state.view !== 'mcp';
  for (const el of $('editor').querySelectorAll('[data-per]')) {
    el.addEventListener('toggle', () => { state.openGlobal = el.open ? el.dataset.per : null; });
  }
  for (const el of $('editor').querySelectorAll('[data-gteam]')) {
    el.onclick = async () => {
      const g = find(el.dataset.gteam);
      const on = !(g.team && g.team.enabled);
      const yes = await ask(
        on ? `Turn on ${g.title} for ${b.name}?` : `Turn off ${g.title} for ${b.name}?`,
        on ? `The agents of every channel of ${b.name} can use it from their next message, except in channels switched off on their own.`
          : `Agents of ${b.name} stop using it with their next message, except in channels switched on on their own.`,
        on ? 'Turn on' : 'Turn off',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/mcp/global', { method: 'PUT', body: JSON.stringify({ server: g.server, team: b.slug, enabled: on }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Switching failed.' }); return; }
      g.team = body.switch;
      renderFiles();
      refreshBases();
      renderMcp({ kind: 'ok', text: `${g.title} is ${on ? 'on' : 'off'} for ${b.name}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-gch]')) {
    el.onchange = async () => {
      const g = find(el.dataset.gch);
      const c = state.channels.find((x) => x.channelId === el.dataset.channel);
      const enabled = el.value === '' ? null : el.value === 'on';
      const { ok, body } = await call('/api/kb/mcp/global', { method: 'PUT', body: JSON.stringify({ server: g.server, channel: c.channelId, enabled }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Switching failed.' }); return; }
      if (body.switch) g.channels[c.channelId] = body.switch;
      else delete g.channels[c.channelId];
      state.openGlobal = g.server;
      renderFiles();
      refreshBases();
      renderMcp({ kind: 'ok', text: enabled === null ? `${g.title} in ${channelName(c)} follows its team again.` : `${g.title} is ${enabled ? 'on' : 'off'} in ${channelName(c)}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-gcheck]')) {
    el.onclick = async () => {
      const g = find(el.dataset.gcheck);
      renderMcp({ kind: '', text: `Connecting to ${g.title}…` });
      const { ok, body } = await call('/api/kb/mcp/global/check', { method: 'POST', body: JSON.stringify({ server: g.server, repo }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'The check failed.' }); return; }
      if (body.global) state.globals = state.globals.map((x) => (x.server === g.server ? body.global : x));
      const failed = body.checked.filter((x) => x.error);
      renderMcp(failed.length ? { kind: 'warn', text: `${g.title} could not be reached: ${failed.map((x) => x.error).join('; ')}` }
        : { kind: 'ok', text: `${g.title}: ${body.checked.map((x) => `${x.tools} tools on mcp__${x.name}`).join(', ')}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-ghinst]')) {
    el.onclick = async () => {
      const g = find('github');
      const allow = Boolean(el.dataset.allow);
      const inst = g.github.installations.find((i) => String(i.id) === el.dataset.ghinst);
      const yes = await ask(
        allow ? `Allow the installation on ${inst.account}?` : `Revoke the installation on ${inst.account}?`,
        allow ? `Agents of the teams and channels where GitHub is on can then read the repositories it is installed on (${inst.selection === 'all' ? 'all of them' : 'a selection'}).`
          : 'Agents stop reading its repositories with their next message. The app stays installed on GitHub.',
        allow ? 'Allow' : 'Revoke',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/github/installation', { method: 'PUT', body: JSON.stringify({ id: inst.id, approved: allow }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'That did not work.' }); return; }
      await loadMcp(repo);
      if (stale()) return;
      renderFiles();
      renderMcp({ kind: 'ok', text: allow ? `Agents can read what the app is installed on in ${inst.account}. Check lists the tools.` : `Agents no longer read ${inst.account}.` });
    };
  }
  if ($('ghCreate')) {
    $('ghCreate').onsubmit = async (e) => {
      e.preventDefault();
      const { ok, body } = await call('/api/kb/github/manifest', { method: 'POST', body: JSON.stringify({ org: $('ghOrg').value.trim(), name: $('ghName').value.trim() }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Could not start.' }); return; }
      // GitHub's manifest flow: post the manifest to GitHub, which asks to confirm and sends the
      // admin back with a code; opspile keeps the app and goes on to its installation.
      const form = document.createElement('form');
      form.method = 'post';
      form.action = body.action;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = body.manifest;
      form.append(input);
      document.body.append(form);
      form.submit();
    };
  }
}

async function openFile(path, { force = false, nav = 'push' } = {}) {
  if (!force && !(await leave())) return false;
  if (!force) showPane('editor');
  state.view = 'file';
  const b = base();
  const exists = state.files.some((f) => f.path === path);
  if (!exists && !mayEdit()) {
    // Nothing to read: only those who edit it start one.
    state.file = null;
    renderFiles();
    $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="path">${esc(path)}</span></div>
      <div class="empty">${path === SYSTEM_PROMPT ? `No agent instructions yet: ${esc(whoEdits())} write them.` : 'No such file.'}</div>`;
    toUrl(nav);
    return true;
  }
  if (!exists) {
    // Only the system prompt is offered before it exists.
    const draft = path === SYSTEM_PROMPT ? systemPromptTemplate(b) : conceptTemplate(path);
    state.file = { path, hash: null, isNew: true, baseline: draft };
  } else {
    $('editor').innerHTML = '<div class="empty">Loading…</div>';
    const { ok, body } = await call(`/api/kb/file?repo=${encodeURIComponent(state.repo)}&path=${encodeURIComponent(path)}`);
    if (!ok) {
      $('editor').innerHTML = `<div class="empty">${esc(body.error || 'Could not read the file.')}</div>`;
      return true;
    }
    const generated = GENERATED.has(path.split('/').pop());
    state.file = {
      path, hash: body.hash, baseline: body.text, readonly: generated || !mayEdit(), generated,
    };
  }
  renderFiles();
  renderEditor();
  toUrl(nav);
  return true;
}

async function newFile() {
  if (!(await leave())) return;
  showPane('editor');
  state.view = 'file';
  state.file = {
    path: '', hash: null, isNew: true, choosePath: true, baseline: conceptTemplate('new-concept.md'),
  };
  renderFiles();
  renderEditor();
  toUrl();
  $('path').focus();
}

// ---- editor -----------------------------------------------------------------------------

const PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.md$/;
const AUTOSAVE_MS = 1200;

function renderEditor(note) {
  const f = state.file;
  const isPrompt = f.path === SYSTEM_PROMPT;
  let explain = f.readonly ? 'Written by code from the concepts; changes to the concepts update it.' : '';
  if (f.readonly && !f.generated) explain = `Read-only: ${esc(whoEdits())} change it.`;
  if (f.readonly && !f.generated && isPrompt) explain = `Appended to the system prompt of every thread agent of ${esc(base().kind === 'team' ? 'this ops team' : 'this customer')}. ${explain}`;
  if (!f.readonly) {
    explain = isPrompt
      ? `Appended to the system prompt of every thread agent of ${esc(base().kind === 'team' ? 'this ops team' : 'this customer')}, on its next request. Agents cannot change it. Saved as you type.${f.isNew ? ' It does not exist yet: start typing to create it.' : ''}`
      : f.choosePath ? 'Give it a path first.' : '';
  }
  $('editor').innerHTML = `
    <div class="bar">${up('files', 'Files')}
      ${f.choosePath
    ? '<input class="path" id="path" placeholder="path/of/the-concept.md" aria-label="Path">'
    : `<span class="path">${esc(f.path)}</span>`}
      <span class="hash" id="hash"></span>
    </div>
    <div class="note${note ? ` ${note.kind}` : ''}" id="note">${note ? esc(note.text) : explain}</div>
    <div class="text" id="text"></div>
    ${f.readonly || f.isNew ? '' : '<div class="foot"><span style="flex:1"></span><button id="delete" class="danger">Delete</button></div>'}`;
  state.editor = Editor.create($('text'), {
    text: f.baseline,
    readonly: f.readonly,
    label: 'File contents',
    onInput: f.readonly ? undefined : schedule,
    onBlur: f.readonly ? undefined : () => { flush(); },
  });
  showHash();
  if (f.readonly) return;
  if ($('path')) $('path').addEventListener('input', schedule);
  if ($('delete')) $('delete').onclick = remove;
}

function showHash() {
  const f = state.file;
  const el = $('hash');
  if (!el) return;
  el.textContent = f.hash ? f.hash.slice(0, 12) : '';
  el.title = f.hash ? `blob ${f.hash}` : '';
}

function setNote(kind, text, actions = []) {
  const el = $('note');
  if (!el) return;
  el.className = `note ${kind}`;
  el.textContent = text;
  for (const [label, run] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = run;
    el.append(b);
  }
}

/** Saves a pause after the last keystroke. */
function schedule() {
  const f = state.file;
  clearTimeout(state.timer);
  if (f.conflict) return;
  if (!edited()) { setNote('', 'No changes.'); return; }
  setNote('', 'Editing…');
  state.timer = setTimeout(() => { flush(); }, AUTOSAVE_MS);
}

/** Saves now, if there is anything to save; one save at a time, the latest text wins. */
async function flush() {
  clearTimeout(state.timer);
  // eslint-disable-next-line no-await-in-loop -- waits for the save in flight, and any after it
  while (state.saving) await state.saving;
  const f = state.file;
  if (!f || f.readonly || f.conflict || !edited()) return;
  state.saving = commit(f).finally(() => { state.saving = null; });
  await state.saving;
}

async function commit(f) {
  const content = editorText();
  const path = f.choosePath ? $('path').value.trim().replace(/^\/+/, '') : f.path;
  if (!PATH.test(path)) {
    f.problem = 'Give the file a lowercase path that ends in .md, like issues/cdn-purge-delay.md.';
    setNote('warn', f.problem);
    return;
  }
  setNote('', 'Saving…');
  const { status, ok, body } = await call('/api/kb/file', {
    method: 'PUT',
    body: JSON.stringify({ repo: state.repo, path, content, base: f.hash }),
  });
  if (state.file !== f) return;
  if (status === 409) {
    f.conflict = { current: body.current || null };
    f.problem = body.error;
    setNote('warn', `${body.error}. Nothing was saved.`, [
      ['Load their version', () => resolveConflict(f, 'theirs')],
      ['Save mine over it', () => resolveConflict(f, 'mine')],
    ]);
    return;
  }
  if (!ok) {
    f.problem = body.error || `Saving failed (${status}).`;
    setNote('err', `${f.problem} Not saved; fix it and keep typing.`);
    return;
  }
  f.problem = null;
  f.baseline = content;
  if (body.hash) f.hash = body.hash;
  const created = f.isNew;
  f.isNew = false;
  if (f.choosePath) {
    f.choosePath = false;
    f.path = path;
  }
  if (created) {
    // The file is new: list it, and show it as an existing file (path fixed, Delete), in
    // place, so typing goes on undisturbed.
    if ($('path')) {
      const span = document.createElement('span');
      span.className = 'path';
      span.textContent = path;
      $('path').replaceWith(span);
    }
    if (!$('delete')) {
      $('editor').insertAdjacentHTML('beforeend', '<div class="foot"><span style="flex:1"></span><button id="delete" class="danger">Delete</button></div>');
      $('delete').onclick = remove;
    }
    await reloadFiles();
    toUrl('replace');
  }
  showHash();
  setNote('ok', body.unchanged ? 'Saved (nothing changed).' : `Saved · ${String(body.commit).slice(0, 12)}`);
  // Typed on while the save was in flight: save that too.
  if (edited()) schedule();
}

/** After a conflict: take the other version, or save this text over it. */
function resolveConflict(f, keep) {
  const theirs = f.conflict && f.conflict.current;
  f.conflict = null;
  f.problem = null;
  f.hash = theirs ? theirs.hash : null;
  f.isNew = !theirs;
  if (theirs && !state.files.some((x) => x.path === f.path)) reloadFiles();
  if (keep === 'theirs') {
    f.baseline = theirs ? theirs.text : '';
    state.editor.value = f.baseline;
    showHash();
    setNote('', 'Loaded their version.');
    return;
  }
  flush();
}

async function remove() {
  const f = state.file;
  await flush();
  if (!(await ask(`Delete ${f.path}?`, 'It stays in the history of the knowledge base.', 'Delete'))) return;
  setNote('', 'Deleting…');
  const { status, ok, body } = await call('/api/kb/file', {
    method: 'DELETE',
    body: JSON.stringify({ repo: state.repo, path: f.path, base: f.hash }),
  });
  if (!ok) { setNote(status === 409 ? 'warn' : 'err', body.error || `Deleting failed (${status}).`); return; }
  state.file = null;
  await reloadFiles();
  $('editor').innerHTML = `<div class="empty">Deleted ${esc(f.path)} in ${esc(String(body.commit).slice(0, 12))}.</div>`;
  toUrl('replace');
}

async function reloadFiles() {
  refreshBases();
  const { ok, body } = await call(`/api/kb/files?repo=${encodeURIComponent(state.repo)}`);
  if (ok) {
    state.files = body.files;
    state.hasSystemPrompt = body.hasSystemPrompt;
    state.truncated = body.truncated;
  }
  renderFiles();
}

async function showHistory({ force = false, nav = 'push' } = {}) {
  if (!force && state.file && !(await leave())) return false;
  if (!force) showPane('editor');
  state.view = 'history';
  state.file = null;
  renderFiles();
  toUrl(nav);
  $('editor').innerHTML = '<div class="empty">Loading…</div>';
  const { ok, body } = await call(`/api/kb/log?repo=${encodeURIComponent(state.repo)}`);
  if (!ok) { $('editor').innerHTML = `<div class="empty">${esc(body.error || 'Could not read the history.')}</div>`; return true; }
  $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="path">History of ${esc(state.repo)}</span></div>
    <div class="log">${body.commits.map((c) => `<div class="c"><div class="h">${esc(c.hash)} · ${esc(new Date(c.at).toLocaleString())} · ${esc(c.author)}</div>
      <div class="m">${esc(c.message)}</div></div>`).join('') || '<div class="empty">No commits yet.</div>'}</div>`;
  return true;
}

// ---- start ------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    flush();
  }
});
// Leaving the page saves what is pending, without asking: keepalive lets the request finish.
window.addEventListener('pagehide', () => {
  const f = state.file;
  if (!edited() || f.conflict || f.choosePath) return;
  fetch('/api/kb/file', {
    method: 'PUT',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: state.repo, path: f.path, content: editorText(), base: f.hash }),
  });
});
// The one native question: leaving the page (the browser's Back, a reload, closing the tab)
// would lose edits that the keepalive save above cannot save (a conflict, a concept that was
// refused, a new file without a path) or that a save in flight may not include. The switch to
// the inbox asks in the page instead.
window.addEventListener('beforeunload', (e) => {
  const f = state.file;
  if (!edited() || !(f.conflict || f.problem || f.choosePath || state.saving)) return;
  e.preventDefault();
  e.returnValue = '';
});

// Phones: back to the column before (what is open stays open).
document.querySelector('main').addEventListener('click', (e) => {
  const to = e.target.closest('[data-up]');
  if (to) showPane(to.dataset.up);
});

// Back and Forward within the editor: show what the URL names, after the same check as a click.
window.addEventListener('popstate', async () => {
  const q = new URLSearchParams(location.search);
  const repo = q.get('repo');
  const view = ['history', 'agents', 'mcp'].includes(q.get('view')) ? q.get('view') : 'file';
  const path = q.get('path') || SYSTEM_PROMPT;
  let moved;
  if (!repo || !state.bases.some((b) => b.repo === repo)) {
    moved = await leave();
    if (moved) {
      Object.assign(state, { repo: null, file: null, view: 'file' });
      showPane('bases');
      renderBases();
      $('files').innerHTML = '';
      $('editor').innerHTML = '<div class="empty">Pick a knowledge base.</div>';
      toUrl('replace');
    }
  } else if (repo !== state.repo) {
    moved = await openRepo(repo, { path, view, nav: 'replace' });
  } else if (view === 'history') {
    moved = state.view === 'history' || await showHistory({ nav: 'replace' });
  } else if (view === 'agents') {
    moved = state.view === 'agents' || await showAgents({ nav: 'replace' });
  } else if (view === 'mcp') {
    moved = state.view === 'mcp' || await showMcp({ nav: 'replace' });
  } else {
    moved = (state.view === 'file' && state.file?.path === path) || await openFile(path, { nav: 'replace' });
  }
  // Stayed (edits that could not be saved, kept): the URL goes back to what is shown.
  if (moved === false) toUrl('push');
});

(async () => {
  const q = new URLSearchParams(location.search);
  // `back=`, the inbox as it was left, from links made before ui/header.js kept it.
  const back = q.get('back');
  if (back && Header.pageOf(back) === 'inbox') Header.remember(back);
  if (q.has('back')) {
    q.delete('back');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  }
  const me = await call('/api/me');
  if (!me.ok) { $('bases').innerHTML = `<div class="empty">${esc(me.body.error || 'Not signed in.')}</div>`; return; }
  state.me = me.body;
  // Yours (src/settings.js): whether your inbox shows the agent's thinking (renderAgents).
  state.settings = state.me.readonly ? null : state.me.settings || null;
  Header.user(state.me, Header.role(state.me) || (state.me.teams?.length ? 'Read-only' : ''));
  // Team managers see their teams' knowledge bases only, and the other members of a team see
  // its knowledge base read-only (the API lists no others, and says which they change).
  if (!state.me.admin && !state.me.teams?.length) {
    $('bases').innerHTML = '<div class="empty">The agents are for the members of an ops team.</div>';
    $('editor').innerHTML = `<div class="empty"><a href="${esc(Header.href('inbox'))}">Back to the inbox</a></div>`;
    return;
  }
  // The pages (ui/header.js). Leaving saves what is pending and asks, in the page, about edits
  // that cannot be saved; a new tab (⌘-click, middle click) leaves nothing.
  Header.init(state.me, {
    fallback: { inbox: teamInbox },
    go: async (id, url) => {
      if (!(await leave())) return;
      state.file = null; // saved, or discarded on purpose: nothing for pagehide or beforeunload
      location.assign(url);
    },
  });
  const { ok, body } = await call('/api/kb');
  if (!ok) { $('bases').innerHTML = `<div class="empty">${esc(body.error || 'Could not list the knowledge bases.')}</div>`; return; }
  state.bases = body.bases;
  renderBases();
  // `repo` (with `path` or `view`) names one; from the inbox, `org` and `team` say what was on
  // screen there, and the customer's knowledge base wins over the team's.
  const exact = state.bases.find((b) => b.repo === q.get('repo'));
  // Back from an MCP server's sign-in (src/mcpadmin.js): said once on the servers' page.
  if (exact && (q.get('mcp_connected') || q.get('mcp_error'))) {
    state.flash = q.get('mcp_error') ? { error: q.get('mcp_error') } : { connected: q.get('mcp_connected') };
  }
  const pick = exact
    || state.bases.find((b) => b.kind === 'org' && b.slug === q.get('org'))
    || state.bases.find((b) => b.kind === 'team' && b.slug === q.get('team'));
  // `team` with `view` (the inbox's agent: its team's thread agents, at `channel`) names a
  // view of the team's knowledge base too.
  const named = exact || (pick && pick.kind === 'team' && !q.get('org'));
  const view = named && ['history', 'agents', 'mcp'].includes(q.get('view')) ? q.get('view') : undefined;
  state.focusChannel = view === 'agents' ? q.get('channel') : null;
  if (pick) {
    await openRepo(pick.repo, {
      path: exact ? q.get('path') || undefined : undefined,
      view,
      nav: 'replace',
    });
    // A link to a file, the history or the agents opens it; a link to a knowledge base, its files.
    if ((exact && q.get('path')) || ['history', 'agents'].includes(view) || (exact && (q.get('mcp_connected') || q.get('mcp_error')))) showPane('editor');
    $('bases').querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
  } else {
    toUrl('replace');
  }
})();
