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
 * The agent of a team or a customer, as the global `Agent`: its thread agents per channel, its
 * tools and MCP servers, its extraction rules (a team's), and its knowledge base (pile 3): the
 * files, and an editor that saves as you type: a pause in typing commits the file as the
 * signed-in person. The Teams and Customers pages (ui/admin.js) show it, one section of the
 * team's or the customer's page each (`show`), in the `#files` and `#editor` they make for it;
 * they keep the address (`onUrl`) and redraw what counts it (`onChange`). The admin team edits
 * every knowledge base, team managers their teams' and those of the customers their teams own;
 * the other members of those teams see them, their agents and their tools read-only,
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
  me: null, bases: [], repo: null, files: null, hasSystemPrompt: false, file: null, view: 'file', turn: 0, loads: {},
  channels: null, configured: true, teamDefault: null, mcp: null, globals: null, tools: null, perFilter: {}, openPer: new Set(),
  extraction: null,
  // Saves started (a listing read meanwhile may predate one), and when the files were listed.
  saves: 0,
  listedAt: 0,
  // The computer's secret being added ('new') or edited (its id), or null.
  secretEditing: null,
};
/** What the page around it does: keeps the address, and redraws what counts the agent. */
const host = {
  onUrl: () => {}, onChange: () => {}, onOpen: () => {}, onWrite: () => {},
};
const VIEWS = ['file', 'history', 'agents', 'mcp', 'extraction'];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => state.bases.find((b) => b.repo === state.repo);
/** Whether you change the open knowledge base, its agents and their tools; else you only look. */
const mayEdit = () => Boolean(base()?.may);
/**
 * Whether you write file `path` of the open knowledge base: its agent instructions are
 * `mayEdit`'s, every other file everyone's on its team (`write`, src/kbaccess.js `mayWrite`).
 */
// Its agent instructions and its Clef areas are the managers' (src/agent/kbwrite.js `pathOwner`).
const managed = (path) => path === SYSTEM_PROMPT || String(path || '').startsWith('areas/');
const mayWrite = (path) => (managed(path) ? mayEdit() : Boolean(base()?.write ?? base()?.may));
/** Who writes the files of the open knowledge base, for the read-only. */
const whoWrites = (path) => (managed(path) ? whoEdits() : (base()?.kind === 'team' ? `the people of ${base().name}` : 'the customer\'s ops teams'));
/** Who changes the open knowledge base, for the read-only. */
const whoEdits = () => (base()?.kind === 'team' ? `the admin team and the managers of ${base().name}` : 'the admin team and the managers of the customer\'s ops teams');

async function call(path, options = {}) {
  // A change: what the page read ahead of its team or customer is old now.
  const change = Boolean(options.method && options.method !== 'GET');
  if (change) host.onWrite();
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : {},
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  } finally {
    if (change) host.onWrite();
  }
}

// ---- prefetch ---------------------------------------------------------------------------
// Reading one file takes the Worker about a second (the head, a tree per directory, the blob,
// one after the other), so the files of the open knowledge base are fetched ahead, by the blob
// hashes of the listing, in batches (/api/kb/blobs, all of a batch's blobs read at once), and
// opening one shows it at once. A blob's text never changes: kept by its hash, it is never
// stale for that hash; the listing says which hash a path has.

const BLOB_BATCH = 25;
const BLOB_PARALLEL = 2;
/** Blob hash → its text (string), or the read in flight (a promise of the text or null). */
const blobs = new Map();

/** Reads `hashes` of `repo` in one request; each hash's entry then holds its text, or none. */
function fetchBlobs(repo, hashes) {
  const read = call(`/api/kb/blobs?repo=${encodeURIComponent(repo)}&hashes=${hashes.join(',')}`)
    .catch(() => ({ ok: false }));
  for (const h of hashes) {
    const one = read.then(({ ok, body }) => {
      const text = ok && typeof body.blobs?.[h] === 'string' ? body.blobs[h] : null;
      if (text === null) blobs.delete(h);
      else blobs.set(h, text);
      return text;
    });
    blobs.set(h, one);
  }
  return read;
}

/** The text of a blob, if it is here already; else undefined. */
function blobNow(hash) {
  const v = blobs.get(hash);
  return typeof v === 'string' ? v : undefined;
}

/** The text of a file of the listing by its hash: kept, in flight, or read now; null if not. */
function blobText(repo, hash) {
  if (!hash) return Promise.resolve(null);
  if (!blobs.has(hash)) fetchBlobs(repo, [hash]);
  return Promise.resolve(blobs.get(hash));
}

/** Fetches the files of the listing not here yet, BLOB_PARALLEL batches at a time. */
function prefetchFiles(repo) {
  const queue = [...new Set((state.files || []).map((f) => f.hash).filter((h) => h && !blobs.has(h)))];
  const next = async () => {
    while (queue.length && state.repo === repo) {
      const batch = queue.splice(0, BLOB_BATCH).filter((h) => !blobs.has(h));
      // eslint-disable-next-line no-await-in-loop -- one batch after the other, per lane
      if (batch.length) await fetchBlobs(repo, batch);
    }
  };
  for (let i = 0; i < BLOB_PARALLEL; i += 1) next();
}

/** A file's listing entry has a new hash and text (saved here): keep both. */
function keepFile(path, hash, text) {
  if (!hash) return;
  if (typeof text === 'string') blobs.set(hash, text);
  const f = (state.files || []).find((x) => x.path === path);
  if (f) f.hash = hash;
}

function systemPromptTemplate(b) {
  const who = b.kind === 'team' ? `the ops team ${b.name}` : `the customer ${b.name}`;
  return `---\ntype: System Prompt\ntitle: Agent instructions for ${who}\ndescription: Appended to the system prompt of every thread agent that uses this knowledge base.\n---\n\n`
    + `<!-- Instructions for the agents of every thread of ${who}, in Markdown: how to address people, what to\n`
    + '     always check, what never to promise, who to ask. Comments like this one are not sent to the agents. -->\n\n';
}

/** A new diagram (`.dot`, src/dot.js): what it shows, its title, a node style, two nodes. */
function diagramTemplate(path) {
  const name = path.split('/').pop().replace(/\.dot$/, '') || 'diagram';
  const title = name.replace(/[-_]+/g, ' ');
  return `// One sentence that says what this diagram shows.\ndigraph ${/^[a-z_][a-z0-9_]*$/.test(name.replace(/-/g, '_')) ? name.replace(/-/g, '_') : 'diagram'} {\n  label="${title}";\n`
    + '  node [shape=box, fixedsize=true, width=1.2, height=0.6];\n\n'
    + '  visitor [fmc=person, label="Visitor", width=0.85, height=0.85];\n'
    + '  // Defaults in braces hold only there: the channels\' sizes are not the boxes\'.\n'
    + '  { node [fmc=channel, label="", width=0.16, height=0.16, request=true]; req; }\n'
    + '  site [label="Site"];\n'
    + '  content [fmc=storage, style=rounded, label="Content"];\n\n'
    + '  visitor -> req -> site [dir=none];\n'
    + '  site -> content [dir=back];\n}\n';
}
const isDiagram = (path) => /\.dot$/.test(String(path || ''));

function conceptTemplate(path) {
  if (isDiagram(path)) return diagramTemplate(path);
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
    dlg.className = 'ask';
    dlg.setAttribute('aria-label', question);
    dlg.innerHTML = `<form method="dialog"><p><b>${esc(question)}</b></p>${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
      <div class="apply"><button value="no">Cancel</button><button value="yes" class="primary">${esc(yes)}</button></div></form>`;
    dlg.addEventListener('cancel', () => { dlg.returnValue = 'no'; });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); Dialog.remove(dlg); });
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
 * The page keeps the address of what is open (`where`), so reloads and the browser's Back and
 * Forward land where they were. Going to another file is a new history entry (`push`);
 * settling the address of the same view is not.
 */
function toUrl(mode = 'push') {
  host.onUrl(mode);
}

/** "12 entries, 2 tools" for a row's title and its count. */
function activity(b) {
  const parts = [b.entries === null || b.entries === undefined ? 'entries not counted yet' : `${b.entries} entr${b.entries === 1 ? 'y' : 'ies'}`];
  if (b.tools) parts.push(`${b.tools} tool${b.tools === 1 ? '' : 's'} on`);
  return parts.join(', ');
}

/**
 * Phones show one column of a knowledge base at a time: its `files` or the `editor`, each with
 * a way back to the other (see the styles).
 */
const showPane = (pane) => { if ($('agent')) $('agent').dataset.pane = pane; };
const UP = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
/** Back to the files, on a phone: only where they are beside the editor. */
const up = (pane, label) => ($('files') ? `<button class="up" data-up="${pane}">${UP}${label}</button>` : '');

/** What counts the agent changed (its switches, servers, rules): the page redraws it. */
const counted = () => host.onChange();

/**
 * Starts on another knowledge base: forgets what was read of the last one. What is read of it
 * is read once (`loads`), until `fresh` asks for it again.
 */
function reset(repo) {
  Object.assign(state, {
    repo,
    file: null,
    files: null,
    filesError: null,
    channels: null,
    mcp: null,
    globals: null,
    tools: null,
    extraction: null,
    secretEditing: null,
    editing: null,
    loads: {},
  });
}

/**
 * How long what was read of the agent (`loadMeta`) is shown again without reading it again:
 * going from one of its sections to another shows them at once. What is changed here changes
 * it in place; what others change shows after this long, or when the team or customer is picked.
 */
const META_MAX_AGE = 60000;

/**
 * Its channels, tools, MCP servers and extraction rules: what the page counts. Kept for
 * META_MAX_AGE only when every read succeeded: after a failure (a 503, D1 overloaded), the next
 * section shown reads them again.
 */
function loadMeta(repo) {
  if (state.loads.meta && Date.now() - state.loads.metaAt > META_MAX_AGE) state.loads.meta = null;
  if (state.loads.meta) return state.loads.meta;
  state.loads.metaAt = Date.now();
  const read = Promise.all([
    loadChannels(repo),
    loadMcp(repo),
    loadTools(repo),
    loadExtraction(repo),
  ]).then((oks) => {
    if (oks.includes(false) && state.loads.meta === read) state.loads.metaAt = 0;
    if (state.repo === repo) counted();
  });
  state.loads.meta = read;
  return read;
}

/** Its files, listed once; then the ones not here yet are fetched ahead (see prefetch). */
function loadFiles(repo) {
  if (state.loads.files) return state.loads.files;
  const read = call(`/api/kb/files?repo=${encodeURIComponent(repo)}`).then(({ ok, body }) => {
    if (state.repo !== repo) return;
    if (!ok) {
      state.filesError = body.error || 'Could not list the files.';
      // Not kept: the knowledge base shown next lists them again.
      if (state.loads.files === read) state.loads.files = null;
      return;
    }
    state.filesError = null;
    state.files = body.files;
    state.hasSystemPrompt = body.hasSystemPrompt;
    state.truncated = body.truncated;
    state.listedAt = Date.now();
  });
  state.loads.files = read;
  return read;
}

/**
 * Reads what the page counts of a knowledge base's agent (`Agent.tags`), without showing it:
 * its team's or customer's page is open on another section. `fresh` reads it again.
 */
function load(repo, { fresh = false } = {}) {
  if (repo !== state.repo) reset(repo);
  else if (fresh) state.loads.meta = null;
  return loadMeta(repo);
}

/**
 * Reads ahead what showing the agent of `repo` needs, not shown yet: what it counts, the
 * listing of its knowledge base and the agent instructions, which the knowledge base opens at.
 */
function preload(repo) {
  if (repo !== state.repo) reset(repo);
  // What is old is read again, but not under a view that shows it: `show` reads it, and draws it.
  if (!state.loads.meta || !$('editor')) loadMeta(repo);
  loadFiles(repo).then(() => {
    const f = state.repo === repo && (state.files || []).find((x) => x.path === SYSTEM_PROMPT);
    if (f && f.hash && !blobs.has(f.hash)) blobText(repo, f.hash);
  });
}

/**
 * Shows a view of the agent of `repo` in the `#files` (the knowledge base's views only) and
 * `#editor` the page made for it: `file` (`path`, else the agent instructions), `history`,
 * `agents` (`channel` marked), `mcp` (what a server's sign-in said, `flash`) or `extraction`.
 * The page asked `leave` first: what was open is saved, or given up.
 */
async function show(repo, {
  view = 'file', path = null, nav = 'replace', fresh = false, channel = null, flash = null,
} = {}) {
  if (repo !== state.repo) reset(repo);
  else if (fresh) state.loads.meta = null;
  const turn = ++state.turn;
  const stale = () => turn !== state.turn || state.repo !== repo;
  state.view = VIEWS.includes(view) ? view : 'file';
  state.file = null;
  state.focusChannel = state.view === 'agents' ? channel : null;
  if (flash) state.flash = flash;
  // Another file, view or knowledge base fades in (ui/app.js).
  Swap.watch($('editor'), () => `${state.repo}|${state.view}|${state.view === 'file' ? (state.file ? state.file.path : state.opening?.path) : ''}`);
  const kb = state.view === 'file' || state.view === 'history';
  showPane(kb && !path && state.view === 'file' ? 'files' : 'editor');
  $('editor').innerHTML = '<div class="empty">Loading…</div>';
  if (kb) renderFiles();
  await (kb ? Promise.all([loadMeta(repo), loadFiles(repo)]) : loadMeta(repo));
  if (stale()) return;
  if (kb) {
    renderFiles();
    if (!state.files) {
      $('editor').innerHTML = `<div class="empty">${esc(state.filesError)}</div>`;
      return;
    }
  }
  if (state.view === 'history') showHistory({ force: true, nav });
  else if (state.view === 'agents') showAgents({ force: true, nav });
  else if (state.view === 'mcp') showMcp({ force: true, nav });
  else if (state.view === 'extraction') showExtraction({ force: true, nav });
  else openFile(path || SYSTEM_PROMPT, { force: true, nav });
  // After the open file's own read, so that one goes first.
  if (kb) prefetchFiles(repo);
}

// ---- files ------------------------------------------------------------------------------

function renderFiles() {
  if (!$('files')) return;
  if (!state.files) {
    $('files').innerHTML = `<div class="empty">${esc(state.filesError || 'Loading…')}</div>`;
    return;
  }
  const others = state.files.filter((f) => f.path !== SYSTEM_PROMPT);
  const rows = [];
  let lastDir = null;
  for (const f of others) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (dir !== lastDir && dir) rows.push(`<div class="row dir">${esc(dir)}/</div>`);
    lastDir = dir;
    const name = f.path.slice(dir ? dir.length + 1 : 0);
    rows.push(`<div class="row${dir ? ' nested' : ''}${state.file?.path === f.path ? ' on' : ''}" data-path="${esc(f.path)}">
      <span>${esc(name)}</span>${GENERATED.has(name) ? '<span class="tag">generated</span>' : ''}</div>`);
  }
  $('files').innerHTML = `<div class="row${state.file?.path === SYSTEM_PROMPT ? ' on' : ''}" data-path="${SYSTEM_PROMPT}">
      <span>${SYSTEM_PROMPT}</span><span class="tag${state.hasSystemPrompt ? '' : ' missing'}">${state.hasSystemPrompt ? 'agent instructions' : 'not written yet'}</span></div>
    <h2>Files</h2>
    ${rows.join('') || '<div class="empty pad">Empty so far.</div>'}
    ${state.truncated ? '<div class="empty pad">Only the first 400 entries are shown.</div>' : ''}
    <div class="tools">${mayWrite() ? '<button id="new">New file</button>' : ''}<button id="history"${state.view === 'history' ? ' class="primary"' : ''}>History</button></div>
    ${mayWrite() ? '' : `<div class="empty ro pad">Read-only. Only ${esc(whoWrites())} can change this.</div>`}`;
  for (const el of $('files').querySelectorAll('[data-path]')) {
    el.onclick = () => openFile(el.dataset.path);
    // Pointing at a file not fetched yet reads it now, ahead of the prefetch's turn.
    el.onpointerenter = () => {
      const f = state.files.find((x) => x.path === el.dataset.path);
      if (f?.hash && !blobs.has(f.hash)) blobText(state.repo, f.hash);
    };
  }
  if ($('new')) $('new').onclick = newFile;
  $('history').onclick = () => showHistory();
}

// ---- thread agents ----------------------------------------------------------------------

/** The channels this knowledge base learns from, with their agents; null when unknown. */
async function loadChannels(repo) {
  const { ok, body } = await call(`/api/kb/channels?repo=${encodeURIComponent(repo)}`);
  if (state.repo !== repo) return true;
  state.channels = ok ? body.channels : null;
  state.configured = ok ? body.configured : true;
  state.teamDefault = ok ? body.teamDefault || null : null;
  return ok;
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
  counted();
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

/** The thread agents, a switch per channel (see `show`). */
function showAgents({ nav = 'replace' } = {}) {
  state.view = 'agents';
  state.file = null;
  toUrl(nav);
  renderAgents();
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
        <div class="sub">${d.enabled ? 'Every channel has an agent unless switched off below, new channels too.'
    : 'Only channels switched on below have an agent.'}</div>
        ${by ? `<div class="sub by">${by}</div>` : ''}
      </div>
      <span class="state${d.enabled ? ' on' : ''}">${d.enabled ? 'On' : 'Off'}</span>
      <button class="switch" role="switch" aria-checked="${d.enabled}" aria-label="Thread agents by default in ${esc(b.name)}"
        title="${d.may ? `Turn agents by default ${d.enabled ? 'off' : 'on'}` : `Only the admin team and the managers of ${esc(b.name)} can change this.`}" id="teamDefault"${d.may ? '' : ' disabled'}></button>
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
  return { on: typeof own === 'boolean' ? own : s.traces === true, own: typeof own === 'boolean' };
}

/** The switch above the channels: the agent's thinking, for you, in every channel. */
function tracesRow() {
  if (!state.settings) return '';
  const on = state.settings.traces === true;
  const set = Object.keys(state.settings.channelTraces || {}).length;
  return `<div class="ch default mine">
      <div class="who">
        <div class="nm">Agent reasoning</div>
        <div class="sub">${on ? 'Shown under threads in your inbox.' : 'Hidden in your inbox.'}${set ? ` ${set} channel${set === 1 ? ' overrides' : 's override'} this.` : ''}</div>
        <div class="sub by">Only affects your inbox.</div>
      </div>
      <span class="state${on ? ' on' : ''}">${on ? 'Shown' : 'Hidden'}</span>
      <button class="switch" role="switch" aria-checked="${on}" aria-label="Show agent reasoning in your inbox" id="tracesAll"
        title="${on ? 'Hide agent reasoning' : 'Show agent reasoning'}"></button>
    </div>`;
}

/** A channel's own choice, in its row: as everywhere, shown, or hidden (where it has an agent, or a choice). */
function tracesSelect(c) {
  if (!state.settings || c.kind !== 'channel') return '';
  const { own, on } = tracesIn(c.channelId);
  if (!c.agent.enabled && !own) return '';
  const all = state.settings.traces === true ? 'shown' : 'hidden';
  const value = own ? (on ? 'on' : 'off') : '';
  return `<label class="sub mine">Agent reasoning
      <select data-traces="${esc(c.channelId)}" aria-label="Agent reasoning in ${esc(channelName(c))}">
        <option value=""${value === '' ? ' selected' : ''}>Default (${all})</option>
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
      const on = state.settings.traces !== true;
      saveTraces({ traces: on }, on ? 'Agent reasoning shown.' : 'Agent reasoning hidden.');
    };
  }
  for (const el of $('editor').querySelectorAll('[data-traces]')) {
    el.onchange = () => {
      const c = state.channels.find((x) => x.channelId === el.dataset.traces);
      const on = el.value === '' ? null : el.value === 'on';
      saveTraces({ channelTraces: { [c.channelId]: on } }, on === null
        ? `Agent reasoning in ${channelName(c)} uses your default.`
        : `Agent reasoning ${on ? 'shown' : 'hidden'} in ${channelName(c)}.`);
    };
  }
}

function renderAgents(note) {
  const b = base();
  const list = state.channels;
  const whose = b.kind === 'team' ? `the channels of ${b.name}` : `the channels of ${b.name}, in every ops team`;
  const explain = `Thread agents draft replies for the team and never post.${mayEdit() ? '' : ' Read-only.'}`;
  const rows = (list || []).map((c) => {
    const a = c.agent;
    const alert = c.kind !== 'channel';
    let by = '';
    if (a.set && a.by) by = `Turned ${a.enabled ? 'on' : 'off'} by ${esc(a.by)}, ${esc(ago(a.at))}`;
    else if (a.via === 'team') by = `On by default for ${esc(c.teamName)}`;
    else if (a.enabled) by = 'On by default (AGENT_CHANNELS)';
    const why = alert ? 'Alert channels have no thread agents.'
      : c.may ? `Turn the agent ${a.enabled ? 'off' : 'on'}` : `Only the admin team and the managers of ${c.teamName} can change this.`;
    return `<div class="ch" data-row="${esc(c.channelId)}">
      <div class="who">
        <div class="nm">${esc(channelName(c))}<span class="src">${esc(SOURCES[c.source] || c.source)}</span>${alert ? '<span class="src">alerts</span>' : ''}</div>
        <div class="sub">${esc([b.kind === 'org' ? c.teamName : c.org, `${c.threads} thread${c.threads === 1 ? '' : 's'}`, c.latest && `last ${ago(c.latest)}`].filter(Boolean).join(', '))}</div>
        ${by ? `<div class="sub by">${by}</div>` : ''}
        ${tracesSelect(c)}
      </div>
      <span class="state${a.enabled ? ' on' : ''}">${a.enabled ? 'On' : 'Off'}</span>
      <button class="switch" role="switch" aria-checked="${a.enabled}" aria-label="Thread agent in ${esc(channelName(c))}" title="${esc(why)}"
        data-channel="${esc(c.channelId)}"${c.may ? '' : ' disabled'}></button>
    </div>`;
  }).join('');
  $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="heading">Thread agents in ${esc(whose)}</span></div>
    <div class="note${note ? ` ${note.kind}` : state.configured ? '' : ' warn'}" id="note">${note ? esc(note.text)
  : state.configured ? explain : 'Agents are not configured in this deployment.'}</div>
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
  counted();
  renderAgents({
    kind: 'ok',
    text: on ? `Thread agent on in ${name}.` : `Thread agent off in ${name}. Existing drafts stay.`,
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
  counted();
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
  if (state.repo !== repo) return true;
  state.mcp = ok ? body.servers : null;
  state.globals = ok ? body.globals || [] : null;
  return ok;
}

/** Whether a global server is on somewhere here: for the team, or in any of these channels. */
const globalOn = (g) => Boolean((g.team && g.team.enabled) || Object.values(g.channels).some((c) => c.enabled));

/** Whether a server is on somewhere here: for all its channels, or in one. */
const serverOn = (s) => Boolean(s.enabled || Object.values(s.channels || {}).some((c) => c.enabled));

const mcpUsable = (s) => {
  const allowed = String(s.allow || '').split(/[\s,]+/).filter(Boolean);
  return allowed.length ? s.tools.filter((t) => allowed.includes(t.name)).length : s.tools.length;
};

/** "2 servers", or "none", next to "MCP servers". */
function mcpTag() {
  if (!state.mcp) return '<span class="tag missing">unknown</span>';
  const on = state.mcp.filter(serverOn).length + (state.globals || []).filter(globalOn).length;
  return on ? `<span class="tag agent">${on} server${on === 1 ? '' : 's'}</span>` : '<span class="tag missing">none</span>';
}

/** The tools and MCP servers (see `show`). */
function showMcp({ nav = 'replace' } = {}) {
  state.view = 'mcp';
  state.file = null;
  state.editing = null;
  toUrl(nav);
  // Arriving: the list from its top (renderMcp keeps it where it is otherwise).
  $('editor').replaceChildren();
  renderMcp();
}

/** How an OAuth server is signed in, for its row. */
function oauthCreds(o) {
  if (o.connected) return `OAuth: connected by ${o.by}, ${ago(o.at)}; the agents act as them`;
  return o.by ? `OAuth: connected by ${o.by}, no longer works` : 'OAuth: not connected';
}

/**
 * The per-channel switches of a team's or a customer's own server: a channel switched on its
 * own wins over the server's switch, which the others follow.
 */
const serverPerChannel = (s) => channelSwitches({
  kind: 'sch',
  id: String(s.id),
  title: s.name,
  switches: s.channels || {},
  team: { enabled: s.enabled },
  follow: 'As the server',
  may: mayEdit(),
});

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
  const b = base();
  const by = s.updatedBy && `changed by ${s.updatedBy}`;
  return `<div class="ch global">
    <div class="head">
      <div class="nm">${esc(s.name)}<span class="src mono">mcp__${esc(s.name.replace(/[^a-z0-9_]/g, '_'))}</span>${status}</div>
      ${mayEdit() ? `<span class="acts">${signIn}${checkable ? `<button data-check="${s.id}">Check</button>` : ''}<button data-edit="${s.id}">Edit</button><button class="danger" data-del="${s.id}">Delete</button></span>` : ''}
      <span class="state${s.enabled ? ' on' : ''}">${s.enabled ? 'On' : 'Off'}</span>
      <button class="switch" role="switch" aria-checked="${s.enabled}" aria-label="Agents use ${esc(s.name)}" title="${mayEdit() ? (s.enabled ? 'Turn off' : `Turn on for every channel of ${esc(b.name)}`) : `Only ${esc(whoEdits())} can change this.`}" data-server="${s.id}"${mayEdit() ? '' : ' disabled'}></button>
    </div>
    <div class="who">
      <div class="sub">${esc([s.description, s.url].filter(Boolean).join(', '))}</div>
      ${oauth && oauth.error ? `<div class="sub err">${esc(oauth.error)}</div>` : ''}
      ${s.checkError ? `<div class="sub err">${esc(s.checkError)}</div>` : ''}
      ${tools ? `<div class="tags">${tools}</div>` : ''}
      <div class="sub by">${esc([creds, s.checkedAt && `checked ${ago(s.checkedAt)}`, by].filter(Boolean).join(', '))}</div>
    </div>
    ${serverPerChannel(s)}
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
  if (state.repo !== repo) return true;
  state.tools = ok ? body.tools : null;
  return ok;
}

const toolOn = (t) => Boolean((t.team && t.team.enabled) || Object.values(t.channels).some((c) => c.enabled));

/** "2 tools" next to "Tools and MCP servers", when any is on; their names on hover. */
function toolsTag() {
  const on = (state.tools || []).filter(toolOn);
  return on.length ? `<span class="tag agent" title="${esc(on.map((t) => t.names.join(', ')).join(', '))}">${on.length} tool${on.length === 1 ? '' : 's'}</span>` : '';
}

const switchable = () => (state.channels || []).filter((c) => c.kind === 'channel');
const switchValue = (sw) => (sw ? (sw.enabled ? 'on' : 'off') : '');
const switchedBy = (sw) => (sw && sw.by ? `Turned ${sw.enabled ? 'on' : 'off'} by ${sw.by}, ${ago(sw.at)}` : '');
const perSummary = (switches) => {
  const set = switchable().filter((c) => switches[c.channelId]).length;
  return `Per channel${set ? ` (${set} set)` : ''}`;
};

/**
 * The per-channel switches of a tool or a global server: the channels switched on their own
 * first, then by name, with a filter when there are many. In a customer's knowledge base they
 * are all there is (no team switch above them), so they are shown; in a team's they fold.
 * `kind` names the select (`tch`, `gch`, `sch`); `follow` is what a channel without its own
 * switch follows, and `may` whether `me` changes them.
 */
function channelSwitches({
  kind, id, title, switches, team, works = () => true, unworkable, follow = 'Team default', may = true,
}) {
  const b = base();
  const list = switchable();
  if (!list.length) return '';
  const key = `${kind}:${id}`;
  const q = (state.perFilter[key] || '').trim().toLowerCase();
  const label = (c) => `${channelName(c)}${b.kind === 'org' ? `, ${c.teamName}` : ''}`;
  const plain = (c) => channelName(c).replace(/^#/, '');
  const sorted = [...list].sort((x, y) => Number(Boolean(switches[y.channelId])) - Number(Boolean(switches[x.channelId]))
    || plain(x).localeCompare(plain(y)));
  const teamState = team ? (team.enabled ? 'on' : 'off') : null;
  const rows = sorted.map((c) => {
    const ok = works(c);
    const sw = switches[c.channelId];
    const value = switchValue(sw);
    const where = SOURCES[c.source] || c.source;
    const na = unworkable || `not on ${where}`;
    const tip = ok ? switchedBy(sw) : na;
    const hidden = q && !label(c).toLowerCase().includes(q);
    return `<div class="row2" data-find="${esc(label(c).toLowerCase())}"${hidden ? ' hidden' : ''}><span title="${esc(tip)}">${esc(label(c))}${ok ? '' : ` <i class="na">${esc(na)}</i>`}</span>
      <select data-${kind}="${esc(id)}" data-channel="${esc(c.channelId)}" aria-label="${esc(title)} in ${esc(channelName(c))}"${c.may && ok && may ? '' : ' disabled'}>
        <option value=""${value === '' ? ' selected' : ''}>${esc(follow)}${teamState ? ` (${teamState})` : ''}</option>
        <option value="on"${value === 'on' ? ' selected' : ''}>On</option>
        <option value="off"${value === 'off' ? ' selected' : ''}>Off</option>
      </select></div>`;
  }).join('');
  const matches = sorted.filter((c) => !q || label(c).toLowerCase().includes(q)).length;
  const find = list.length >= 6 ? `<label class="s2-search find"><input type="search" data-find-for="${esc(key)}" value="${esc(state.perFilter[key] || '')}"
    aria-label="Filter the channels of ${esc(title)}"></label>` : '';
  const none = `<div class="none"${matches ? ' hidden' : ''}>No channel matches.</div>`;
  if (b.kind === 'org') return `<div class="per flat">${find}${rows}${none}</div>`;
  return `<details class="per"${state.openPer.has(key) ? ' open' : ''} data-fold="${esc(key)}"><summary>${perSummary(switches)}</summary>${find}${rows}${none}</details>`;
}

/** The per-channel switches of a tool; channels on a platform it does not work on are left off. */
const toolPerChannel = (t) => channelSwitches({
  kind: 'tch',
  id: t.tool,
  title: t.title,
  switches: t.channels,
  // An internal tool has no team switch to follow.
  team: t.team || (t.internal ? { enabled: false } : null),
  works: (c) => t.may && (!t.platforms || t.platforms.includes(c.source)),
  unworkable: t.may ? null : 'only the admin team can change this',
});

function toolRow(t) {
  const b = base();
  const on = Boolean(t.team && t.team.enabled);
  const by = t.team && t.team.by ? `Turned ${on ? 'on' : 'off'} for ${esc(b.name)} by ${esc(t.team.by)}, ${esc(ago(t.team.at))}` : '';
  const platforms = t.platforms ? `<span class="src">${esc(t.platforms.map((p) => SOURCES[p] || p).join(', '))} only</span>` : '';
  const sw = t.team ? `<span class="state${on ? ' on' : ''}">${on ? 'On' : 'Off'}</span>
    <button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(t.title)} for ${esc(b.name)}"
      title="${mayEdit() ? (on ? 'Turn off' : `Turn on for every channel of ${esc(b.name)}`) : `Only ${esc(whoEdits())} can change this.`}" data-tteam="${esc(t.tool)}"${mayEdit() ? '' : ' disabled'}></button>` : '';
  return `<div class="ch global">
    <div class="head">
      <div class="nm">${esc(t.title)}<span class="src mono">${esc(t.names.join(', '))}</span>${platforms}${t.problem ? '<span class="src err">not set up</span>' : ''}</div>
      ${sw}
    </div>
    <div class="who">
      <div class="sub">${esc(t.description)}</div>
      ${t.note ? `<div class="sub">${esc(t.note)}</div>` : ''}
      ${t.problem ? `<div class="sub err">${esc(t.problem)}</div>` : ''}
      ${by ? `<div class="sub by">${by}</div>` : ''}
    </div>
    ${t.tool === 'computer' ? shellBlock(t) + secretsBlock(t) : ''}
    ${toolPerChannel(t)}
  </div>`;
}

// ---- the computer's image ------------------------------------------------------------------
//
// The programs of a team's agents' computers, GNU bash on the SLICC kernel
// (src/agent/kernel.js): its image (src/agent/image.js), a stack of layers, one of those in the
// deployment's images bucket.
// In a team's knowledge base, in the Computer tool's row, for the admin team to choose;
// everyone else sees what it is.

const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** The image picker of the team's computers, with what the chosen image is; '' outside a team. */
function shellBlock(t) {
  if (!t.image) return '';
  const b = base();
  if (!t.images.length) return '<div class="shell"><div class="sub err">No images uploaded yet (npm run computer:images). Commands fail until one is.</div></div>';
  const now = t.images.find((i) => i.name === t.image.image);
  const options = t.images.map((i) => `<option value="${esc(i.name)}"${i === now ? ' selected' : ''}>${esc(i.title)}</option>`).join('');
  const gone = now ? '' : `<option value="" selected>${esc(t.image.image)} (not there)</option>`;
  const by = t.image.by ? `<div class="sub by">Chosen by ${esc(t.image.by)}, ${esc(ago(t.image.at))}</div>` : '';
  return `<div class="shell">
    <label class="sub mine">Image
      <select data-image aria-label="The image of the computers of ${esc(b.name)}"
        title="${t.mayImage ? '' : 'Only the admin team can change this.'}"${t.mayImage ? '' : ' disabled'}>${gone}${options}</select>
    </label>
    <div class="sub${now ? '' : ' err'}">${esc(now ? `${now.description} Layers: ${now.layers.join(', ')} (${megabytes(now.bytes)}), mounted read-only at /opt/image.` : `Image ${t.image.image} is missing. Commands fail until another is chosen.`)}</div>
    ${by}
  </div>`;
}

/** The handler of the computer's image picker. */
function bindShell(computer, stale) {
  const b = base();
  const image = $('editor').querySelector('[data-image]');
  if (image) {
    image.onchange = async () => {
      const chosen = computer.images.find((i) => i.name === image.value);
      const { ok, body } = chosen ? await call('/api/kb/tools', { method: 'PUT', body: JSON.stringify({ tool: 'computer', team: b.slug, image: chosen.name }) }) : { ok: false, body: {} };
      if (stale()) return;
      if (!ok) {
        renderMcp({ kind: 'err', text: body.error || 'Choosing the image failed.' });
        return;
      }
      computer.image = body.image;
      renderMcp({ kind: 'ok', text: `Image set to ${chosen.title}.` });
    };
  }
}

// ---- the computer's secrets -----------------------------------------------------------------
//
// API keys and tokens of this team or customer for the agents' shells (src/agent/secrets.js),
// over /api/kb/tools/secrets (src/secretadmin.js), in the Computer tool's row. The shell has
// `$NAME`, a placeholder; the Worker's gateway puts the value in, only in HTTPS requests to the
// secret's hosts. A value is sent once; only names and hosts come back.

function secretForm(s) {
  return `<form class="mcpform" id="secretForm" autocomplete="off">
    <h3>${s.id ? `Edit ${esc(s.name)}` : 'Add a secret'}</h3>
    <label for="sName">Variable</label><input id="sName" class="mono short" value="${esc(s.name || '')}" required pattern="[A-Z][A-Z0-9_]+">
    <span class="hint">Capitals, digits and underscores, such as ACME_API_KEY.</span>
    <label for="sValue">Value</label><input id="sValue" class="mono" type="password"${s.id ? '' : ' required'}>
    <span class="hint">${s.id ? 'Leave empty to keep the current value. ' : ''}Stored encrypted and never shown again, not even to agents.</span>
    <label for="sHosts">Sent only to</label><input id="sHosts" class="mono" value="${esc((s.hosts || []).join(', '))}" required>
    <span class="hint">HTTPS hosts, separated by commas. *.example.com matches every subdomain.</span>
    <label for="sDesc">Description</label><input id="sDesc" value="${esc(s.description || '')}">
    <span class="hint">Shown to the agents, such as "The ticket API, as a bearer token".</span>
    <span class="apply"><button class="primary">${s.id ? 'Save' : 'Add'}</button><button type="button" id="sCancel">Cancel</button></span>
  </form>`;
}

/** The computer's secrets: one row each, and the form to add or change one. */
function secretsBlock(t) {
  const b = base();
  const list = t.secrets || [];
  const whose = b.kind === 'team' ? `${b.name}'s agents` : `the agents of ${b.name}'s threads`;
  const rows = list.map((s) => `<div class="srow"><span class="what" title="${esc(s.updatedBy ? `Changed by ${s.updatedBy}, ${ago(s.updatedAt)}` : '')}"><b class="mono">$${esc(s.name)}</b>
      to ${esc(s.hosts.join(', '))}${s.description ? `: ${esc(s.description)}` : ''}</span>
    ${mayEdit() ? `<span class="acts"><button type="button" data-sedit="${s.id}">Edit</button><button type="button" class="danger" data-sdel="${s.id}">Delete</button></span>` : ''}</div>`).join('');
  const editing = state.secretEditing === 'new' ? {} : list.find((s) => s.id === state.secretEditing);
  let form = '';
  if (mayEdit()) form = editing ? secretForm(editing) : '<div class="srow"><span class="acts"><button type="button" id="sNew">Add a secret</button></span></div>';
  return `<div class="secrets">
    <div class="sub">API keys for ${esc(whose)}, used in the shell as $NAME. Agents never see the values.</div>
    ${rows || '<div class="none">No secrets yet.</div>'}
    ${form}
  </div>`;
}

/** The handlers of the computer's secrets. */
function bindSecrets(computer, stale) {
  const repo = state.repo;
  const edit = (id, focus) => { state.secretEditing = id; renderMcp(); $(focus).focus(); };
  if ($('sNew')) $('sNew').onclick = () => edit('new', 'sName');
  for (const el of $('editor').querySelectorAll('[data-sedit]')) {
    el.onclick = () => edit(Number(el.dataset.sedit), 'sValue');
  }
  for (const el of $('editor').querySelectorAll('[data-sdel]')) {
    el.onclick = async () => {
      const s = computer.secrets.find((x) => x.id === Number(el.dataset.sdel));
      if (!(await ask(`Delete the secret ${s.name}?`, `Agents can no longer use $${s.name}. The value is deleted.`, 'Delete'))) return;
      const { ok, body } = await call('/api/kb/tools/secrets', { method: 'DELETE', body: JSON.stringify({ id: s.id }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Deleting failed.' }); return; }
      computer.secrets = body.secrets;
      if (state.secretEditing === s.id) state.secretEditing = null;
      renderMcp({ kind: 'ok', text: `Deleted ${s.name}.` });
    };
  }
  if (!$('secretForm')) return;
  $('sCancel').onclick = () => { state.secretEditing = null; renderMcp(); };
  $('secretForm').onsubmit = async (e) => {
    e.preventDefault();
    const id = state.secretEditing === 'new' ? null : state.secretEditing;
    const value = $('sValue').value.trim();
    const payload = {
      ...(id ? { id } : { repo }),
      name: $('sName').value.trim(),
      hosts: $('sHosts').value.trim(),
      description: $('sDesc').value.trim(),
      ...(value ? { value } : {}),
    };
    const { ok, body } = await call('/api/kb/tools/secrets', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (stale()) return;
    // The form stays as it is, its value too, to be corrected.
    if (!ok) { showNote({ kind: 'err', text: body.error || 'Saving failed.' }); return; }
    computer.secrets = body.secrets;
    state.secretEditing = null;
    renderMcp({ kind: 'ok', text: `${body.secret.name} ${id ? 'saved' : 'added'}.` });
  };
}

const TOOL_CONFIRM = {
  post_message: {
    on: (where) => `Agents of ${where} can post replies in their threads themselves, as the bot, without a person reading them first. They still keep drafts for anything a person should review.`,
    off: (where) => `Agents of ${where} only keep drafts again, from their next message.`,
  },
  extraction_rules: {
    on: (where) => `Agents of ${where} can add, change and delete the extraction rules and the tech stack of their team, which apply to every channel of the team from the next labeling of a thread.`,
    off: (where) => `Agents of ${where} stop changing extraction rules. The rules they saved stay.`,
  },
  computer: {
    on: (where) => `Agents of ${where} have a bash shell with a working directory of their own per thread (Cloudflare Computer), and curl, which reaches the internet without a filter.`,
    off: (where) => `Agents of ${where} lose their shell. The files they made stay in their threads.`,
  },
  org_threads: {
    on: (where) => `Agents of ${where} can list and read the other channels of their thread's customer, on every platform, never another customer's, and what they read can reach their drafts, notes, the customer's knowledge base and their posts.`,
    off: (where) => `Agents of ${where} stop reading the customer's other channels at once. What they read before stays in their transcripts.`,
  },
  any_thread: {
    on: (where) => `Agents of ${where} can read any thread of the inbox, of any channel, team or customer, and find any customer's channels, and what they read can reach their drafts, notes, knowledge bases and their other tools.`,
    off: (where) => `Agents of ${where} stop reading other channels' threads at once. What they read before stays in their transcripts.`,
  },
  membership: {
    on: (where) => `Agents of ${where} can file add-user and remove-user requests that people make in their threads with the admins' bot: admin-bot on Teams, AEM Ops Automation in #general on Slack. Nobody is added until the request is approved.`,
    off: (where) => `Agents of ${where} stop filing membership requests. Requests they filed stay with the admins.`,
  },
  web_search: {
    on: (where) => `Agents of ${where} can search the public web. Their queries go to an outside search provider (Microsoft Web IQ, or one through AI Gateway); they are told to keep the customer's name, people and hosts out of them.`,
    off: (where) => `Agents of ${where} stop searching the web.`,
  },
  resolve: {
    on: (where) => `Agents of ${where} can mark their threads resolved in the inbox, as a ✅ on the first message counts, without anything posted in the channel. A customer's next message opens a thread again, and so does the ✅ button.`,
    off: (where) => `Agents of ${where} stop resolving threads. Threads they resolved stay resolved until a customer writes again.`,
  },
  label: {
    on: (where) => `Agents of ${where} can correct the kind, urgency and next actor of their threads.`,
    off: (where) => `Agents of ${where} stop labeling threads. Labels they set stay.`,
  },
};

/** The built-in tools, as the first group of the tools and MCP servers page. */
function toolsSection() {
  const b = base();
  if (!state.tools) return '<div class="empty">Could not list the agent tools.</div>';
  const note = b.kind === 'team' ? `On or off for every channel of ${b.name}. A channel's own setting wins.`
    : 'Turned on per team in Teams, or here per channel.';
  return `<h3 class="group">Tools</h3><div class="sub intro">${esc(note)}</div>${state.tools.map(toolRow).join('')}`;
}

/** The handlers of the built-in tools' switches. */
function bindTools() {
  const b = base();
  if (!state.tools) return;
  const repo = state.repo;
  const find = (tool) => state.tools.find((t) => t.tool === tool);
  const stale = () => state.repo !== repo || state.view !== 'mcp';
  if (find('computer')) bindSecrets(find('computer'), stale);
  if (find('computer')) bindShell(find('computer'), stale);
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
      counted();
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
        el.value = switchValue(t.channels[c.channelId]);
        return;
      }
      const { ok, body } = await call('/api/kb/tools', { method: 'PUT', body: JSON.stringify({ tool: t.tool, channel: c.channelId, enabled }) });
      if (stale()) return;
      if (!ok) {
        el.value = switchValue(t.channels[c.channelId]);
        showNote({ kind: 'err', text: body.error || 'Switching failed.' });
        return;
      }
      if (body.switch) t.channels[c.channelId] = body.switch;
      else delete t.channels[c.channelId];
      counted();
      refreshBases();
      channelSwitched(el, t.channels, { kind: 'ok', text: enabled === null ? `${t.title} in ${channelName(c)} uses the team default.` : `${t.title} is ${enabled ? 'on' : 'off'} in ${channelName(c)}.` });
    };
  }
}

// ---- extraction rules -------------------------------------------------------------------
//
// A team's extraction rules and tech stack (src/extract.js), over /api/kb/extraction
// (src/extractadmin.js): regular expressions or scripts that find facts in the threads of the
// team's channels (every channel, for the admin team), and the technologies Clef asks about.
// The admin team's apply too, and show below the team's own, read-only.

async function loadExtraction(repo) {
  const b = state.bases.find((x) => x.repo === repo);
  if (!b || b.kind !== 'team') { state.extraction = null; return true; }
  const { ok, body } = await call(`/api/kb/extraction?repo=${encodeURIComponent(repo)}`);
  if (state.repo !== repo) return true;
  state.extraction = ok ? body : null;
  return ok;
}

/** "5 rules, 3 tech" next to "Extraction rules". */
function extractionTag() {
  const x = state.extraction;
  if (!x) return '<span class="tag missing">unknown</span>';
  const rules = x.rules.filter((r) => r.enabled).length;
  const tech = x.tech.filter((t) => t.enabled).length;
  if (!rules && !tech) return `<span class="tag missing">${x.global ? 'none' : 'admin team\'s'}</span>`;
  return `<span class="tag agent">${[rules && `${rules} rule${rules === 1 ? '' : 's'}`, tech && `${tech} tech`].filter(Boolean).join(', ')}</span>`;
}

/** A team's extraction rules and tech stack (see `show`). */
function showExtraction({ nav = 'replace' } = {}) {
  state.view = 'extraction';
  state.file = null;
  state.editRule = null;
  state.editTech = null;
  toUrl(nav);
  renderExtraction();
}

const mayRules = () => Boolean(state.extraction?.may);
const ruleWhat = (r) => (r.kind === 'script' ? 'script' : r.target === 'tech' ? `detects ${r.field}` : `→ ${r.field}`);
/** What the inbox calls a fact's field, as its rule has it (`label`, src/extract.js). */
const ruleLabel = (r) => (r.target === 'fact' && r.field && r.label ? r.label : '');

function ruleRow(r, own) {
  const edit = own && mayRules();
  const detail = r.kind === 'script' ? `${r.script.split('\n').length} lines of JavaScript`
    : [r.pattern, r.flags && `flags ${r.flags}`, r.value && `value ${r.value}`, r.transform, r.exclude && `not ${r.exclude}`].filter(Boolean).join(', ');
  const by = r.by ? `Changed by ${r.by}, ${ago(r.at)}` : '';
  return `<div class="ch rule${r.enabled ? '' : ' off'}">
    <div class="who">
      <div class="nm">${esc(r.name)}<span class="src mono">${esc(ruleWhat(r))}</span>${ruleLabel(r) ? `<span class="src" title="Label">${esc(r.label)}</span>` : ''}</div>
      <div class="sub pat mono">${esc(detail)}</div>
      ${by ? `<div class="sub by">${esc(by)}</div>` : ''}
    </div>
    ${edit ? `<span class="acts"><button data-redit="${r.id}">Edit</button><button class="danger" data-rdel="${r.id}">Delete</button></span>` : ''}
    <span class="state${r.enabled ? ' on' : ''}">${r.enabled ? 'On' : 'Off'}</span>
    ${own ? `<button class="switch" role="switch" aria-checked="${r.enabled}" aria-label="Run ${esc(r.name)}" data-ron="${r.id}"${edit ? '' : ' disabled'}></button>` : '<span class="switch-gap"></span>'}
  </div>`;
}

function techRow(t, own) {
  const x = state.extraction;
  const mine = own ? null : x.tech.find((y) => y.tech === t.tech);
  // Compiled from a team's catalog (src/catalog.js): its file is where it changes.
  const filed = Boolean(t.path);
  const edit = own && mayRules() && !filed;
  const by = t.by ? `Changed by ${t.by}, ${ago(t.at)}` : '';
  const replaced = mine ? `<div class="sub">${mine.enabled ? `Replaced for ${esc(base().name)}` : `Turned off for ${esc(base().name)}`}</div>` : '';
  const kept = filed ? `<div class="sub">${own ? `In <button class="link" data-topen="${esc(t.path)}">${esc(t.path)}</button>` : `In kb-team-${esc(t.team)} at <span class="mono">${esc(t.path)}</span>. To override, write the same path in this knowledge base.`}</div>` : '';
  const local = !own && !mine && mayRules() && !filed ? `<span class="acts"><button data-tlocal="${esc(t.tech)}">Change for ${esc(base().name)}</button><button data-toff="${esc(t.tech)}">Turn off here</button></span>` : '';
  return `<div class="ch rule${t.enabled ? '' : ' off'}${mine ? ' replaced' : ''}">
    <div class="who">
      <div class="nm">${esc(t.name)}<span class="src mono">${esc(t.tech)}</span>${t.product ? `<span class="src" title="Product">${esc(t.product)}</span>` : ''}${t.layer ? `<span class="src" title="Stack layer">${esc(layerName(t.layer))}</span>` : ''}</div>
      <div class="sub">${esc(t.description)}</div>
      ${replaced}
      ${kept}
      ${by ? `<div class="sub by">${esc(by)}</div>` : ''}
    </div>
    ${edit ? `<span class="acts"><button data-tedit="${esc(t.tech)}">Edit</button><button class="danger" data-tdel="${esc(t.tech)}">Delete</button></span>` : local}
    <span class="state${t.enabled ? ' on' : ''}">${t.enabled ? 'On' : 'Off'}</span>
    ${own && !filed ? `<button class="switch" role="switch" aria-checked="${t.enabled}" aria-label="Detect ${esc(t.name)}" data-ton="${esc(t.tech)}"${edit ? '' : ' disabled'}></button>` : '<span class="switch-gap"></span>'}
  </div>`;
}

function ruleForm(r = {}) {
  const kind = r.kind || 'regex';
  const hide = (k) => (kind === k ? '' : ' hidden');
  // The label is a fact's: hidden for a rule that detects a technology.
  const fact = kind === 'regex' && (r.target || 'fact') === 'fact';
  const hideFact = fact ? '' : ' hidden';
  const opt = (v, cur, label) => `<option value="${v}"${v === (cur || '') ? ' selected' : ''}>${label}</option>`;
  return `<form class="mcpform" id="ruleForm" autocomplete="off">
    <h3>${r.id ? `Edit ${esc(r.name)}` : 'Add a rule'}</h3>
    <label for="rName">Name</label><input id="rName" value="${esc(r.name || '')}" required>
    <span class="hint">Such as "Order ids".</span>
    <label for="rKind">Kind</label><select id="rKind" class="long">${opt('regex', kind, 'Regular expression')}${opt('script', kind, 'Script: JavaScript, without network access')}</select>
    <label for="rTarget" data-kind="regex"${hide('regex')}>Finds</label><select id="rTarget" data-kind="regex" class="long"${hide('regex')}>${opt('fact', r.target || 'fact', 'A fact (field and value)')}${opt('tech', r.target, 'A technology the customer uses')}</select>
    <label for="rField" data-kind="regex"${hide('regex')}>Field or tech id</label><input id="rField" data-kind="regex" class="mono short" value="${esc(r.field || '')}"${hide('regex')}>
    <span class="hint" data-kind="regex"${hide('regex')}>Such as site, ticket or akamai.</span>
    <label for="rLabel" data-kind="regex" data-target="fact"${hideFact}>Label</label><input id="rLabel" data-kind="regex" data-target="fact" class="long" maxlength="40" value="${esc(r.label || '')}"${hideFact}>
    <span class="hint" data-kind="regex" data-target="fact"${hideFact}>Shown next to the value in search results, such as Order id. Defaults to the field.</span>
    <label for="rPattern" data-kind="regex"${hide('regex')}>Pattern</label><input id="rPattern" data-kind="regex" class="mono" value="${esc(r.pattern || '')}"${hide('regex')}>
    <span class="hint" data-kind="regex"${hide('regex')}>Such as <span class="mono">\\bORD-(\\d{6})\\b</span>.</span>
    <label for="rFlags" data-kind="regex"${hide('regex')}>Flags</label><input id="rFlags" data-kind="regex" class="mono short" value="${esc(r.flags || '')}"${hide('regex')}>
    <span class="hint" data-kind="regex"${hide('regex')}>Any of i, m, s and u.</span>
    <label for="rValue" data-kind="regex"${hide('regex')}>Value</label><input id="rValue" data-kind="regex" class="mono long" value="${esc(r.value || '')}"${hide('regex')}>
    <span class="hint" data-kind="regex"${hide('regex')}><span class="mono">$0</span> is the match, <span class="mono">$1</span>, <span class="mono">$2</span>… the groups.</span>
    <label for="rTransform" data-kind="regex"${hide('regex')}>Case</label><select id="rTransform" data-kind="regex" class="short"${hide('regex')}>${opt('', r.transform, 'As written')}${opt('lower', r.transform, 'lower case')}${opt('upper', r.transform, 'UPPER CASE')}</select>
    <label for="rExclude" data-kind="regex"${hide('regex')}>Not (optional)</label><input id="rExclude" data-kind="regex" class="mono" value="${esc(r.exclude || '')}"${hide('regex')}>
    <span class="hint" data-kind="regex"${hide('regex')}>Values matching this regular expression are dropped.</span>
    <label for="rScript" data-kind="script"${hide('script')}>Script</label><textarea id="rScript" data-kind="script" class="mono" rows="9"${hide('script')}>${esc(r.script || '')}</textarea>
    <span class="hint" data-kind="script"${hide('script')}>A module whose default export takes the thread, <span class="mono">{ text, messages: [{ at, author, staff, bot, text }], channel, platform, customer }</span>, and returns what it finds: <span class="mono">[{ field: 'order', value: '123456' }, { tech: 'akamai' }]</span>.</span>
    ${kind === 'script' && !state.extraction.scripts ? '<span class="hint" data-kind="script">Scripts do not run in this deployment (no LOADER binding).</span>' : ''}
    <label for="rSample">Test on a message</label><textarea id="rSample" class="mono" rows="3">${esc(state.sample || '')}</textarea>
    <span class="hint" id="rFound"></span>
    <span class="apply"><button class="primary" id="rSave">${r.id ? 'Save' : 'Add'}</button><button type="button" id="rTest">Test</button>${r.id ? '<button type="button" id="rCancel">Cancel</button>' : ''}</span>
  </form>`;
}

/** A layer of the stack (src/stack.js LAYERS) by its name, and what is in it. */
const layerName = (id) => (state.extraction?.layers || []).find((l) => l.id === id)?.name || id;
const layerHint = (id) => {
  const l = (state.extraction?.layers || []).find((x) => x.id === id);
  return l ? `${l.name}: ${l.hint}.` : '';
};

/** The products and categories the tech stacks name, for the form's suggestions. */
function products() {
  const x = state.extraction;
  const all = [...(x?.tech || []), ...(x?.inherited?.tech || [])].map((t) => t.product).filter(Boolean);
  return [...new Set(all)].sort((a, b) => a.localeCompare(b));
}

/** A tech stack by product (those of none last), then by name. */
const byProduct = (list) => [...list].sort((a, b) => (a.product ? 0 : 1) - (b.product ? 0 : 1)
  || String(a.product || '').localeCompare(String(b.product || '')) || a.name.localeCompare(b.name));

function techForm(t = {}) {
  const editing = Boolean(t.tech && state.extraction.tech.some((y) => y.tech === t.tech));
  return `<form class="mcpform" id="techForm" autocomplete="off">
    <h3>${editing ? `Edit ${esc(t.name)}` : t.tech ? `Change ${esc(t.name)} for ${esc(base().name)}` : 'Add a technology'}</h3>
    <label for="tId">Id</label><input id="tId" class="mono short" value="${esc(t.tech || '')}" required pattern="[a-z][a-z0-9_]*"${t.tech ? ' readonly' : ''}>
    <span class="hint">Lowercase letters, digits and underscores, such as akamai.</span>
    <label for="tName">Name</label><input id="tName" value="${esc(t.name || '')}" required class="long">
    <span class="hint">Such as Akamai.</span>
    <label for="tDesc">Description</label><input id="tDesc" value="${esc(t.description || '')}" required>
    <span class="hint">What the customer uses, such as "Akamai as CDN".</span>
    <label for="tProduct">Part of</label><input id="tProduct" list="tProducts" value="${esc(t.product || '')}" class="long">
    <datalist id="tProducts">${products().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <span class="hint">An Adobe product as named on <a href="https://business.adobe.com/products.html" target="_blank" rel="noopener">Adobe's product list</a>, or a category.</span>
    <label for="tLayer">Layer</label><select id="tLayer"><option value="">None</option>${(state.extraction.layers || []).map((l) => `<option value="${esc(l.id)}"${l.id === t.layer ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
    <span class="hint">${esc(layerHint(t.layer))}</span>
    <label for="tAliases">Also called</label><input id="tAliases" value="${esc(t.aliases || '')}" class="long">
    <span class="hint">Other names, separated by commas, such as EdgeWorkers, Property Manager.</span>
    <span class="apply"><button class="primary" id="tSave">${editing ? 'Save' : 'Add'}</button>${t.tech ? '<button type="button" id="tCancel">Cancel</button>' : ''}</span>
  </form>`;
}

function renderExtraction(note) {
  const b = base();
  const x = state.extraction;
  if (!x) {
    $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="heading">Extraction rules</span></div><div class="empty">Could not load the rules.</div>`;
    return;
  }
  const where = x.global ? 'every channel' : `the channels of ${b.name}`;
  const explain = `Rules find facts such as sites, tickets or error codes in threads, and detect technologies.${x.global ? ' They apply to every team.' : ''}${mayRules() ? '' : ` Only ${whoEdits()} can change them.`}`;
  const editing = state.editRule ? x.rules.find((r) => r.id === state.editRule) : null;
  const inherited = x.inherited;
  const techEditing = state.editTech ? (x.tech.find((t) => t.tech === state.editTech) || inherited?.tech.find((t) => t.tech === state.editTech)) : null;
  $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="heading">Extraction rules and tech stack for ${esc(where)}</span></div>
    <div class="note${note ? ` ${note.kind}` : ''}" id="note">${esc(note ? note.text : explain)}</div>
    <div class="channels">
      <h3 class="group">Rules</h3>
      ${x.rules.map((r) => ruleRow(r, true)).join('') || `<div class="empty">${x.global ? 'No rules.' : `No rules of ${esc(b.name)}'s own yet.`}</div>`}
      ${inherited ? `<details class="inherited"><summary>The admin team's rules, for every channel (${inherited.rules.length})</summary>${inherited.rules.map((r) => ruleRow(r, false)).join('')}</details>` : ''}
      ${mayRules() ? ruleForm(editing || {}) : ''}
      <h3 class="group">Tech stack</h3>
      ${byProduct(x.tech).map((t) => techRow(t, true)).join('') || `<div class="empty">${x.global ? 'No technologies.' : `No technologies of ${esc(b.name)}'s own yet.`}</div>`}
      ${inherited ? `<details class="inherited"${state.editTech && !x.tech.some((t) => t.tech === state.editTech) ? ' open' : ''}><summary>The admin team's tech stack, for every channel (${inherited.tech.length})</summary>${byProduct(inherited.tech).map((t) => techRow(t, false)).join('')}</details>` : ''}
      ${mayRules() ? techForm(techEditing || {}) : ''}
    </div>`;
  bindExtraction();
}

function bindExtraction() {
  const x = state.extraction;
  // A technology of the team's catalog: its file, in the knowledge base.
  for (const el of $('editor').querySelectorAll('[data-topen]')) {
    el.onclick = () => host.onOpen('file', el.dataset.topen);
  }
  if (!mayRules()) return;
  const repo = state.repo;
  const stale = () => state.repo !== repo || state.view !== 'extraction';
  const reload = async (text) => {
    await loadExtraction(repo);
    if (stale()) return;
    counted();
    renderExtraction(text && { kind: 'ok', text });
  };
  const send = async (method, path, body) => {
    const r = await call(`/api/kb/extraction${path}`, { method, body: JSON.stringify({ repo, ...body }) });
    if (!r.ok && !stale()) renderExtraction({ kind: 'err', text: r.body.error || 'Something went wrong. Try again.' });
    return r.ok ? r.body : null;
  };
  const rule = (id) => x.rules.find((r) => r.id === Number(id));
  const tech = (id) => x.tech.find((t) => t.tech === id) || x.inherited?.tech.find((t) => t.tech === id);
  for (const el of $('editor').querySelectorAll('[data-ron]')) {
    el.onclick = async () => {
      const r = rule(el.dataset.ron);
      if (await send('POST', '/rule', { id: r.id, enabled: !r.enabled })) reload(`${r.name} is ${r.enabled ? 'off' : 'on'}.`);
    };
  }
  for (const el of $('editor').querySelectorAll('[data-redit]')) {
    el.onclick = () => { state.editRule = Number(el.dataset.redit); renderExtraction(); $('rName').focus(); };
  }
  for (const el of $('editor').querySelectorAll('[data-rdel]')) {
    el.onclick = async () => {
      const r = rule(el.dataset.rdel);
      if (!(await ask(`Delete the rule ${r.name}?`, 'Facts already found stay until threads are labeled again.', 'Delete'))) return;
      if (await send('DELETE', '/rule', { id: r.id })) { state.editRule = null; reload(`Deleted ${r.name}.`); }
    };
  }
  for (const el of $('editor').querySelectorAll('[data-ton]')) {
    el.onclick = async () => {
      const t = tech(el.dataset.ton);
      if (await send('POST', '/tech', { ...t, enabled: !t.enabled })) reload(`${t.name} is ${t.enabled ? 'off' : 'on'}.`);
    };
  }
  for (const el of $('editor').querySelectorAll('[data-tedit], [data-tlocal]')) {
    el.onclick = () => { state.editTech = el.dataset.tedit || el.dataset.tlocal; renderExtraction(); $('tName').focus(); };
  }
  for (const el of $('editor').querySelectorAll('[data-toff]')) {
    el.onclick = async () => {
      const t = tech(el.dataset.toff);
      if (await send('POST', '/tech', { tech: t.tech, name: t.name, description: t.description, enabled: false })) reload(`${t.name} is off in ${base().name}'s channels.`);
    };
  }
  for (const el of $('editor').querySelectorAll('[data-tdel]')) {
    el.onclick = async () => {
      const t = tech(el.dataset.tdel);
      if (!(await ask(`Delete ${t.name}?`, 'Threads already tagged keep the tag.', 'Delete'))) return;
      if (await send('DELETE', '/tech', { tech: t.tech })) { state.editTech = null; reload(`Deleted ${t.name}.`); }
    };
  }
  const form = $('ruleForm');
  const given = () => {
    const kind = $('rKind').value;
    return kind === 'script' ? { name: $('rName').value.trim(), kind, script: $('rScript').value }
      : {
        name: $('rName').value.trim(), kind, target: $('rTarget').value, field: $('rField').value.trim(),
        label: $('rTarget').value === 'fact' ? $('rLabel').value.trim() : '',
        pattern: $('rPattern').value, flags: $('rFlags').value.trim(), value: $('rValue').value.trim(),
        transform: $('rTransform').value, exclude: $('rExclude').value,
      };
  };
  // What shows is the kind's, and of a regular expression's, the label only for a fact.
  const shown = () => {
    for (const el of form.querySelectorAll('[data-kind]')) {
      el.hidden = el.dataset.kind !== $('rKind').value
        || Boolean(el.dataset.target && el.dataset.target !== $('rTarget').value);
    }
  };
  $('rKind').onchange = shown;
  $('rTarget').onchange = shown;
  $('rTest').onclick = async () => {
    state.sample = $('rSample').value;
    $('rFound').textContent = 'Testing…';
    const r = await call('/api/kb/extraction/test', { method: 'POST', body: JSON.stringify({ repo, rule: { name: 'test', ...given() }, text: state.sample }) });
    if (stale()) return;
    const g = given();
    const named = (f) => (g.label && f.field === g.field ? g.label : f.field);
    const found = r.ok ? [...r.body.facts.map((f) => `${named(f)}: ${f.value}`), ...r.body.tech.map((t) => `tech: ${t}`)] : null;
    $('rFound').innerHTML = !r.ok ? `<span class="err">${esc(r.body.error)}</span>`
      : found.length ? `<span class="tags">${found.map((f) => `<span class="src">${esc(f)}</span>`).join('')}</span>` : 'Nothing found.';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { ...(state.editRule ? { id: state.editRule } : {}), ...given() };
    const r = await send('POST', '/rule', body);
    if (r) { state.editRule = null; reload(`Saved ${r.rule.name}.`); }
  };
  if ($('rCancel')) $('rCancel').onclick = () => { state.editRule = null; renderExtraction(); };
  $('techForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await send('POST', '/tech', {
      tech: $('tId').value.trim(), name: $('tName').value.trim(), description: $('tDesc').value.trim(), product: $('tProduct').value.trim(), aliases: $('tAliases').value.trim(), layer: $('tLayer').value, enabled: true,
    });
    if (r) { state.editTech = null; reload(`Saved ${r.tech.name}.`); }
  };
  if ($('tCancel')) $('tCancel').onclick = () => { state.editTech = null; renderExtraction(); };
}

// ---- global MCP servers ---------------------------------------------------------------
//
// opspile's own servers (src/agent/globals.js): GitHub (read-only, as the opspile GitHub App),
// FluffyJaws (as the person the admin team connected, or a service app) and Slack channel
// management (the slack-automation relay; the admin team switches it, on Slack channels only).
// Set up once; on or off for a team here (new teams start with GitHub on), or for one channel
// (a channel's switch wins over its team's). The browser is the computer's (its image).

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
      <span class="what">Create a read-only GitHub App. Without an organization, the app belongs to your account. The name must be unique on GitHub.</span>
      <label class="fld"><span>Organization (optional)</span><input id="ghOrg" class="mono"></label>
      <label class="fld"><span>App name</span><input id="ghName"></label>
      <button class="primary"${gh.configured ? '' : ' disabled title="TOKEN_KEY and PUBLIC_ORIGIN must be set"'}>Create on GitHub</button>
    </form>`;
  }
  const rows = gh.installations.map((i) => `<div class="row2"><span title="${esc(i.approved ? `Allowed by ${i.approvedBy}, ${ago(i.approvedAt)}` : 'Agents cannot read this installation until it is allowed')}">${esc(i.account)}
      (${i.selection === 'all' ? 'all repositories' : 'selected repositories'}${i.suspended ? ', suspended' : ''})${i.approved ? '' : ' <b>waiting to be allowed</b>'}</span>
      <button type="button" data-ghinst="${esc(i.id)}" data-allow="${i.approved ? '' : '1'}"${i.approved ? ' class="danger"' : ' class="primary"'}>${i.approved ? 'Revoke' : 'Allow'}</button></div>`).join('');
  return `<div class="setup"><span>GitHub App <a href="${esc(gh.app.htmlUrl)}" target="_blank" rel="noopener">${esc(gh.app.slug)}</a>
    ${gh.app.owner ? `of ${esc(gh.app.owner)}` : ''}${gh.installations.length ? '. Agents read only installations allowed here.' : ', not installed yet'}</span>
    ${installLink(gh.app, gh.installations.length ? 'Install elsewhere or change repositories' : 'Install on repositories', !gh.installations.length)}</div>
    ${rows ? `<div class="per">${rows}</div>` : ''}`;
}

// A server the admin team alone switches (`may: false` for others), or on some platforms only.
const perChannel = (g) => channelSwitches({
  kind: 'gch',
  id: g.server,
  title: g.server,
  switches: g.channels,
  team: g.team,
  works: (c) => g.may !== false && (!g.platforms || g.platforms.includes(c.source)),
  unworkable: g.may === false ? 'only the admin team can change this' : null,
});

/**
 * FluffyJaws' credential: whose identity the agents use there (everyone sees it, since turning it
 * on gives a team's agents what that person sees), and for the admin team, Connect and Disconnect.
 */
function fluffySetup(g) {
  const fj = g.fluffyjaws;
  if (!fj || !fj.mode) return '';
  if (fj.mode === 'service') {
    return '<div class="setup"><span>Agents use a FluffyJaws service app, not a person\'s identity.</span></div>';
  }
  const who = fj.actsAsName && fj.actsAs ? `${fj.actsAsName} (${fj.actsAs})` : fj.actsAs || 'the person who connected it';
  const text = fj.connected
    ? `Agents act as <b>${esc(who)}</b> at FluffyJaws, with what they may see there. Connected by ${esc(fj.by || 'someone')}, ${esc(ago(fj.at))}.`
    : `Agents act as whoever on the admin team connects FluffyJaws.${fj.mayConnect ? '' : ' Not connected yet.'}`;
  const acts = fj.mayConnect ? `<button type="button" data-fjconnect="${esc(g.server)}"${fj.connected ? '' : ' class="primary"'}>${fj.connected ? 'Connect again' : 'Connect as you'}</button>
    ${fj.connected ? `<button type="button" class="danger" data-fjdisconnect="${esc(g.server)}">Disconnect</button>` : ''}` : '';
  return `<div class="setup"><span${acts ? ' class="what"' : ''}>${text}</span>${acts}</div>`;
}

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
  const may = mayEdit() && g.may !== false;
  const only = g.may === false ? 'Only the admin team can change this.' : `Only ${esc(whoEdits())} can change this.`;
  const sw = g.team ? `<span class="state${on ? ' on' : ''}">${on ? 'On' : 'Off'}</span>
    <button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(g.title)} for ${esc(b.name)}"
      title="${may ? (on ? 'Turn off' : `Turn on for every channel of ${esc(b.name)}`) : only}" data-gteam="${esc(g.server)}"${may ? '' : ' disabled'}></button>` : '';
  return `<div class="ch global">
    <div class="head">
      <div class="nm">${esc(g.title)}<span class="src mono">${esc(names)}</span>${status}</div>
      <span class="acts">${g.available && mayEdit() ? `<button data-gcheck="${esc(g.server)}">Check</button>` : ''}</span>
      ${sw}
    </div>
    <div class="who">
      <div class="sub">${esc(g.description)}</div>
      ${g.problem ? `<div class="sub err">${esc(g.problem)}</div>` : ''}${errors}
      ${tools.length ? `<div class="tags">${toolTags(tools)}</div>` : ''}
      <div class="sub by">${[by, first && first.checkedAt && `checked ${esc(ago(first.checkedAt))}`].filter(Boolean).join(', ')}</div>
    </div>
    ${githubSetup(g)}
    ${fluffySetup(g)}
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
    <label for="mName">Name</label><input id="mName" class="mono short" value="${esc(s.name || '')}" required pattern="[a-z][a-z0-9_\\-]*">
    <span class="hint">Lowercase, such as docs. Agents call the tools as <span class="mono">tools.mcp__docs__…</span></span>
    <label for="mUrl">URL</label><input id="mUrl" class="mono" value="${esc(s.url || '')}" required>
    <label for="mDesc">Description</label><input id="mDesc" value="${esc(s.description || '')}">
    <span class="hint">Shown to the agents, such as "Product documentation search".</span>
    <label for="mAuth">Sign-in</label><select id="mAuth" class="long">
      <option value="headers"${auth === 'headers' ? ' selected' : ''}>Request headers: an API key or a token</option>
      <option value="oauth"${auth === 'oauth' ? ' selected' : ''}>OAuth: someone signs in at the server</option></select>
    <label for="mHdrName" data-auth="headers"${hide('headers')}>Header name</label><input id="mHdrName" data-auth="headers" class="mono short"${hide('headers')}>
    <span class="hint" data-auth="headers"${hide('headers')}>Mostly Authorization.</span>
    <label for="mHdrValue" data-auth="headers"${hide('headers')}>Header value</label><input id="mHdrValue" data-auth="headers" class="mono" type="password"${hide('headers')}>
    <span class="hint" data-auth="headers"${hide('headers')}>${set ? `${esc(s.headerNames.join(', '))} set. Fill in a header to replace.` : 'Usually "Bearer" and the token. Stored encrypted, never shown again.'}</span>
    <span class="hint wide" data-auth="oauth"${hide('oauth')}>Agents call the server as you once you connect. If the server needs a registered client, use the redirect URI <span class="mono">${esc(location.origin)}/api/kb/mcp/oauth/callback</span>.</span>
    <label for="mClientId" data-auth="oauth"${hide('oauth')}>Client id (optional)</label><input id="mClientId" data-auth="oauth" class="mono" value="${esc(o.clientId || '')}"${hide('oauth')}>
    <label for="mClientSecret" data-auth="oauth"${hide('oauth')}>Client secret (optional)</label><input id="mClientSecret" data-auth="oauth" class="mono" type="password"${hide('oauth')}>
    <span class="hint" data-auth="oauth"${hide('oauth')}>${o.clientSecret ? 'Leave empty to keep the current secret.' : 'Only with a client id.'}</span>
    <label for="mScope" data-auth="oauth"${hide('oauth')}>Scope (optional)</label><input id="mScope" data-auth="oauth" class="mono" value="${esc(o.scope || '')}"${hide('oauth')}>
    
    <label for="mAllow">Only these tools (optional)</label><input id="mAllow" class="mono" value="${esc(s.allow || '')}">
    <span class="hint">Tool names, separated by commas. Leave empty for all tools.</span>
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
  if (f.global) {
    const g = (state.globals || []).find((x) => x.server === f.global);
    if (!g || !g.fluffyjaws) return null;
    const i = g.instances[0];
    if (!i || i.checkError) return { kind: 'warn', text: `Connected ${g.title}, but the server could not be reached${i ? `: ${i.checkError}` : '.'}` };
    return { kind: 'ok', text: `Connected ${g.title} as ${g.fluffyjaws.actsAs || 'you'}, with ${i.tools.length} tool${i.tools.length === 1 ? '' : 's'}.` };
  }
  const s = (state.mcp || []).find((x) => String(x.id) === f.connected);
  if (!s) return null;
  if (s.checkError) return { kind: 'warn', text: `Connected ${s.name} as you, but the server could not be reached: ${s.checkError}` };
  return { kind: 'ok', text: `Connected ${s.name} as you, with ${mcpUsable(s)} tool${mcpUsable(s) === 1 ? '' : 's'}.` };
}

/**
 * Runs `change`, which may replace the list or resize the note above it, with the list staying
 * where it is on the screen.
 */
function holdList(change) {
  const list = () => $('editor').querySelector('.channels');
  const before = list();
  // What scrolls it: the page's section it is in.
  let scroller = before && before.parentElement;
  while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const top = before && before.getBoundingClientRect().top;
  change();
  const after = list();
  if (before && after && scroller) scroller.scrollTop += after.getBoundingClientRect().top - top;
}

const showNote = (note) => holdList(() => {
  $('note').className = `note ${note.kind}`;
  $('note').textContent = note.text;
});

/**
 * A channel's switch was saved: only its row and the count above it change, so the row is not
 * sorted away from under you (that waits for the next time the list is rendered).
 */
function channelSwitched(el, switches, note) {
  if (!el.isConnected) { renderMcp(note); return; }
  el.closest('.row2').firstElementChild.title = switchedBy(switches[el.dataset.channel]);
  const summary = el.closest('details')?.querySelector('summary');
  if (summary) summary.textContent = perSummary(switches);
  showNote(note);
}

function renderMcp(shownNote) {
  const note = shownNote || flashNote();
  const b = base();
  const list = state.mcp;
  const whose = b.kind === 'team' ? `the threads of ${b.name}` : `the threads of ${b.name}, in every ops team`;
  const explain = `Built-in tools and MCP servers for the thread agents.${mayEdit() ? '' : ' Read-only.'}`;
  const editing = state.editing && list ? list.find((x) => x.id === state.editing) : null;
  const globals = state.globals || [];
  const globalNote = b.kind === 'team' ? `Shared by every team. On or off for ${b.name}, or per channel.`
    : 'Shared by every team. Turned on per team in Teams, or here per channel.';
  holdList(() => {
    $('editor').innerHTML = `<div class="bar">${up('files', 'Files')}<span class="heading">Tools and MCP servers for ${esc(whose)}</span></div>
    <div class="note${note ? ` ${note.kind}` : state.configured ? '' : ' warn'}" id="note">${note ? esc(note.text)
  : state.configured ? esc(explain) : 'Agents are not configured in this deployment.'}</div>
    <div class="channels">${toolsSection()}${globals.length ? `<h3 class="group">Global MCP servers</h3><div class="sub intro">${esc(globalNote)}</div>${globals.map(globalRow).join('')}
      <h3 class="group">${b.kind === 'team' ? 'The team\'s servers' : 'The customer\'s servers'}</h3>` : ''}
    ${list ? list.map(mcpRow).join('') || '<div class="empty">No MCP servers yet.</div>'
    : '<div class="empty">Could not list the MCP servers.</div>'}
    ${list && mayEdit() ? mcpForm(editing || {}) : ''}</div>`;
  });
  bindTools();
  bindGlobals();
  bindFinds();
  if (!list || !mayEdit()) return;
  const find = (id) => list.find((x) => String(x.id) === String(id));
  const put = (server) => {
    state.mcp = state.mcp.some((x) => x.id === server.id) ? state.mcp.map((x) => (x.id === server.id ? server : x))
      : [...state.mcp, server].sort((x, y) => x.name.localeCompare(y.name));
    counted();
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
    const site = (() => { try { return new URL(s.url).host; } catch { return s.url; } })();
    const yes = await ask(
      `Connect ${s.name} as you?`,
      `You sign in at ${site}. Agents then call ${s.name} as you, with your permissions, until someone disconnects it.`,
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
      if (!(await ask(`Disconnect ${s.name}?`, 'The sign-in is revoked. Agents cannot use the server until someone connects again.', 'Disconnect'))) return;
      const { ok, body } = await call('/api/kb/mcp/oauth/disconnect', { method: 'POST', body: JSON.stringify({ id: s.id }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      put(body.server);
      renderMcp({ kind: 'ok', text: `Disconnected ${s.name}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-del]')) {
    el.onclick = async () => {
      const s = find(el.dataset.del);
      if (!(await ask(`Delete the MCP server ${s.name}?`, 'Agents stop using the server. The credentials are deleted too.', 'Delete'))) return;
      const { ok, body } = await call('/api/kb/mcp', { method: 'DELETE', body: JSON.stringify({ id: s.id }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      state.mcp = state.mcp.filter((x) => x.id !== s.id);
      if (state.editing === s.id) state.editing = null;
      counted();
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
        on ? 'Channels switched off on their own stay off.'
          : 'Channels switched on on their own stay on. Settings and credentials are kept.',
        on ? 'Turn on' : 'Turn off',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/mcp', { method: 'PUT', body: JSON.stringify({ id: s.id, enabled: on }) });
      if (!ok) { renderMcp({ kind: 'err', text: body.error }); return; }
      put(body.server);
      renderMcp(on ? reached(body.server) : { kind: 'ok', text: `${s.name} is off.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-sch]')) {
    el.onchange = async () => {
      const s = find(el.dataset.sch);
      const c = state.channels.find((x) => x.channelId === el.dataset.channel);
      const enabled = el.value === '' ? null : el.value === 'on';
      const repo = state.repo;
      const { ok, body } = await call('/api/kb/mcp/channel', { method: 'PUT', body: JSON.stringify({ id: s.id, channel: c.channelId, enabled }) });
      if (state.repo !== repo || state.view !== 'mcp') return;
      if (!ok) {
        el.value = switchValue(s.channels[c.channelId]);
        showNote({ kind: 'err', text: body.error || 'Switching failed.' });
        return;
      }
      // Kept in place, so that the row is not sorted away from under you (channelSwitched).
      Object.assign(s, body.server);
      counted();
      refreshBases();
      channelSwitched(el, s.channels, { kind: 'ok', text: enabled === null ? `${s.name} in ${channelName(c)} follows the server's switch again.` : `${s.name} is ${enabled ? 'on' : 'off'} in ${channelName(c)}.` });
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

/**
 * The per-channel lists: which are unfolded, and their filters, which hide the rows that do not
 * match, as you type.
 */
function bindFinds() {
  for (const el of $('editor').querySelectorAll('[data-fold]')) {
    el.addEventListener('toggle', () => state.openPer[el.open ? 'add' : 'delete'](el.dataset.fold));
  }
  for (const el of $('editor').querySelectorAll('[data-find-for]')) {
    el.oninput = () => {
      state.perFilter[el.dataset.findFor] = el.value;
      const q = el.value.trim().toLowerCase();
      // The input is in its label (s2-search): the rows are the list's, around it.
      const per = el.closest('.per');
      let shown = 0;
      for (const row of per.querySelectorAll('.row2[data-find]')) {
        row.hidden = Boolean(q) && !row.dataset.find.includes(q);
        if (!row.hidden) shown += 1;
      }
      per.querySelector('.none').hidden = shown > 0;
    };
  }
}

/** The handlers of the global servers' switches, checks and GitHub App setup. */
function bindGlobals() {
  const b = base();
  const repo = state.repo;
  const find = (server) => state.globals.find((g) => g.server === server);
  const stale = () => state.repo !== repo || state.view !== 'mcp';
  for (const el of $('editor').querySelectorAll('[data-gteam]')) {
    el.onclick = async () => {
      const g = find(el.dataset.gteam);
      const on = !(g.team && g.team.enabled);
      const kind = g.platforms ? `${g.platforms.map((p) => SOURCES[p] || p).join(' and ')} channel` : 'channel';
      const yes = await ask(
        on ? `Turn on ${g.title} for ${b.name}?` : `Turn off ${g.title} for ${b.name}?`,
        on ? `For every ${kind} of ${b.name}. Channels switched off on their own stay off.`
          : 'Channels switched on on their own stay on.',
        on ? 'Turn on' : 'Turn off',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/mcp/global', { method: 'PUT', body: JSON.stringify({ server: g.server, team: b.slug, enabled: on }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Switching failed.' }); return; }
      g.team = body.switch;
      counted();
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
      if (!ok) {
        el.value = switchValue(g.channels[c.channelId]);
        showNote({ kind: 'err', text: body.error || 'Switching failed.' });
        return;
      }
      if (body.switch) g.channels[c.channelId] = body.switch;
      else delete g.channels[c.channelId];
      counted();
      refreshBases();
      channelSwitched(el, g.channels, { kind: 'ok', text: enabled === null ? `${g.title} in ${channelName(c)} uses the team default.` : `${g.title} is ${enabled ? 'on' : 'off'} in ${channelName(c)}.` });
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
        allow ? `Agents where GitHub is on can read ${inst.selection === 'all' ? 'all repositories' : 'the selected repositories'} of ${inst.account}.`
          : `Agents stop reading ${inst.account}'s repositories. The app stays installed on GitHub.`,
        allow ? 'Allow' : 'Revoke',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/github/installation', { method: 'PUT', body: JSON.stringify({ id: inst.id, approved: allow }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Something went wrong. Try again.' }); return; }
      await loadMcp(repo);
      if (stale()) return;
      counted();
      renderMcp({ kind: 'ok', text: allow ? `Allowed ${inst.account}.` : `Revoked ${inst.account}.` });
    };
  }
  for (const el of $('editor').querySelectorAll('[data-fjconnect]')) {
    el.onclick = async () => {
      const g = find(el.dataset.fjconnect);
      const yes = await ask(
        `Connect ${g.title} as you?`,
        `You sign in at ${g.title}'s Okta. Agents where ${g.title} is on then act as you, seeing what you see.`,
        'Sign in',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/mcp/global/connect', { method: 'POST', body: JSON.stringify({ server: g.server, repo }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Could not start the sign-in.' }); return; }
      location.href = body.authorizationUrl;
    };
  }
  for (const el of $('editor').querySelectorAll('[data-fjdisconnect]')) {
    el.onclick = async () => {
      const g = find(el.dataset.fjdisconnect);
      const yes = await ask(
        `Disconnect ${g.title}?`,
        `The sign-in of ${g.fluffyjaws.actsAs || 'the connected person'} is revoked. Agents cannot use ${g.title} until someone connects again.`,
        'Disconnect',
      );
      if (!yes) return;
      const { ok, body } = await call('/api/kb/mcp/global/disconnect', { method: 'POST', body: JSON.stringify({ server: g.server, repo }) });
      if (stale()) return;
      if (!ok) { renderMcp({ kind: 'err', text: body.error || 'Something went wrong. Try again.' }); return; }
      if (body.global) state.globals = state.globals.map((x) => (x.server === g.server ? body.global : x));
      renderMcp({ kind: 'ok', text: `${g.title} is disconnected.` });
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
  const listed = state.files.find((f) => f.path === path);
  const exists = Boolean(listed);
  const opening = { path };
  state.opening = opening;
  // Another file, or another view, was opened while this one was read: that one shows.
  const overtaken = () => state.opening !== opening || state.view !== 'file';
  if (!exists && !mayWrite(path)) {
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
    // Fetched ahead (see prefetch) by the hash of the listing; else read by its path.
    let read = { hash: listed.hash, text: blobNow(listed.hash) };
    if (read.text === undefined) {
      $('editor').innerHTML = '<div class="empty">Loading…</div>';
      read.text = await blobText(state.repo, listed.hash);
      if (read.text === null) {
        const { ok, body } = await call(`/api/kb/file?repo=${encodeURIComponent(state.repo)}&path=${encodeURIComponent(path)}`);
        if (overtaken()) return true;
        if (!ok) {
          $('editor').innerHTML = `<div class="empty">${esc(body.error || 'Could not read the file.')}</div>`;
          return true;
        }
        read = body;
      }
      if (overtaken()) return true;
    }
    const generated = GENERATED.has(path.split('/').pop());
    state.file = {
      path, hash: read.hash, baseline: read.text, readonly: generated || !mayWrite(path), generated,
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

const PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.(md|dot)$/;
const AUTOSAVE_MS = 1200;

function renderEditor(note) {
  const f = state.file;
  const dot = isDiagram(f.choosePath ? f.dotPath : f.path);
  const isPrompt = f.path === SYSTEM_PROMPT;
  let explain = f.readonly ? 'Generated. Read-only.' : '';
  if (f.readonly && !f.generated) explain = `Read-only. Only ${esc(whoWrites(f.path))} can change this file.`;
  if (f.readonly && !f.generated && isPrompt) explain = `Added to every thread agent's instructions. ${explain}`;
  if (!f.readonly) {
    explain = isPrompt
      ? `Added to every thread agent's instructions. Agents cannot edit this file.${f.isNew ? ' Start typing to create it.' : ''}`
      : f.choosePath ? 'Enter a path first.' : '';
  }
  $('editor').innerHTML = `
    <div class="bar">${up('files', 'Files')}
      ${f.choosePath
    ? '<label class="newpath"><span>Path</span><input class="path" id="path" aria-describedby="pathHint"></label><span class="hint" id="pathHint">Ending in .md or .dot, such as playbooks/cdn-purge.md</span>'
    : `<span class="path">${esc(f.path)}</span>`}
      <span class="hash" id="hash"></span>
    </div>
    <div class="note${note ? ` ${note.kind}` : ''}" id="note">${note ? esc(note.text) : explain}</div>
    ${dot ? '<div class="dotpane"><div class="text" id="text"></div><div class="dotview" id="dotview" role="img" aria-label="The diagram, drawn"></div></div>' : '<div class="text" id="text"></div>'}
    ${f.readonly || f.isNew ? '' : '<div class="foot"><span class="fill"></span><button id="delete" class="danger">Delete</button></div>'}`;
  state.editor = Editor.create($('text'), {
    text: f.baseline,
    readonly: f.readonly,
    label: dot ? 'The diagram, in DOT' : 'File contents',
    language: dot ? 'dot' : 'markdown',
    onInput: () => {
      if (dot) drawSoon();
      if (!f.readonly) schedule();
    },
    onBlur: f.readonly ? undefined : () => { flush(); },
  });
  showHash();
  if (dot) drawDiagram();
  if (f.readonly) return;
  if ($('path')) {
    $('path').value = f.pathDraft || '';
    if (f.pathDraft != null) {
      $('path').focus();
      $('path').setSelectionRange(f.pathDraft.length, f.pathDraft.length);
    }
    $('path').addEventListener('input', () => {
      // A new file becomes a diagram, or a concept again, by its name: the template follows.
      const draft = $('path').value;
      if (isDiagram(draft) !== isDiagram(f.dotPath)) {
        const untouched = !edited();
        f.pathDraft = draft;
        f.dotPath = isDiagram(draft) ? draft : '';
        if (untouched) f.baseline = conceptTemplate(isDiagram(draft) ? draft : 'new-concept.md');
        const text = untouched ? f.baseline : editorText();
        renderEditor();
        if (!untouched) state.editor.value = text;
        return;
      }
      f.pathDraft = draft;
      schedule();
    });
  }
  if ($('delete')) $('delete').onclick = remove;
}

// ---- diagrams --------------------------------------------------------------------------

/*
 * A `.dot` file is drawn beside its text, a moment after the text changes: by the renderer
 * Worker (POST /api/diagram, src/diagrams.js: Graphviz on the server, and the FMC drawing of
 * src/fmc.js), or, where there is none (503), by the page itself, as the inbox draws a stack
 * (/inbox/fmc.js, imported then). What Graphviz cannot draw it says under the last drawing.
 */
const RENDERER = '/inbox/fmc.js';
const DRAW_MS = 250;
let renderer = null;
let onServer = true;
/** `{ svg, width, height, ms }` of `dot`, or throws what is wrong with it. */
async function drawn(dot, title) {
  if (onServer) {
    const res = await call('/api/diagram', { method: 'POST', body: JSON.stringify({ dot, title }) });
    if (res.ok) return res.body;
    if (res.status !== 503 && res.status !== 404) throw new Error(res.body.error || `Drawing failed (${res.status}).`);
    // No renderer here: the page draws from now on. One too slow for it: this one only.
    if (res.status === 404 || res.body.error === 'no renderer here') onServer = false;
  }
  renderer = renderer || import(RENDERER);
  return (await renderer).render(dot, { title });
}
let drawTimer = 0;
let drawTurn = 0;
function drawSoon() {
  clearTimeout(drawTimer);
  drawTimer = setTimeout(drawDiagram, DRAW_MS);
}
async function drawDiagram() {
  const view = $('dotview');
  const text = editorText();
  if (!view || text === null) return;
  const turn = ++drawTurn;
  if (!view.firstChild) view.innerHTML = '<div class="dotnote">Drawing…</div>';
  try {
    const r = await drawn(text, state.file?.path || '');
    if (turn !== drawTurn || !$('dotview')) return;
    view.innerHTML = `${r.svg}<div class="dotnote">Drawn in ${r.ms.toFixed(0)} ms</div>`;
    view.classList.remove('stale');
  } catch (e) {
    if (turn !== drawTurn || !$('dotview')) return;
    if (String(e.message || e).includes('Failed to fetch')) renderer = null;
    const svg = view.querySelector('svg');
    view.classList.toggle('stale', Boolean(svg));
    const note = `<div class="dotnote err">${esc(String(e.message || e).split('\n')[0] || 'Graphviz cannot draw this.')}</div>`;
    view.innerHTML = `${svg ? svg.outerHTML : ''}${note}`;
  }
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

/**
 * Where the open file stands: `clean`, `editing`, `saving`, or what keeps it from being saved:
 * `conflict` (a newer version), `unnamed` (a new file without a path) or `problem` (refused).
 */
function fileState(f = state.file) {
  if (!edited()) return 'clean';
  if (f.conflict) return 'conflict';
  if (f.choosePath) return 'unnamed';
  if (state.saving) return 'saving';
  return f.problem ? 'problem' : 'editing';
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
    f.problem = 'Give the file a lowercase path that ends in .md (a concept, like issues/cdn-purge-delay.md) or .dot (a diagram).';
    setNote('warn', f.problem);
    return;
  }
  setNote('', 'Saving…');
  state.saves += 1;
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
      ['Overwrite with mine', () => resolveConflict(f, 'mine')],
    ]);
    return;
  }
  if (!ok) {
    f.problem = body.error || `Saving failed (${status}).`;
    setNote('err', `${f.problem} Not saved.`);
    return;
  }
  f.problem = null;
  f.baseline = content;
  if (body.hash) f.hash = body.hash;
  // The listing has the hash it was read at: the next opening shows this text, not that one;
  // a stack drawing whose Tech the catalog set (src/stacktech.js) is what was saved instead.
  keepFile(path, body.hash, typeof body.content === 'string' ? body.content : content);
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
      $('editor').insertAdjacentHTML('beforeend', '<div class="foot"><span class="fill"></span><button id="delete" class="danger">Delete</button></div>');
      $('delete').onclick = remove;
    }
    await reloadFiles();
    toUrl('replace');
  } else {
    // A save writes index.md and log.md too: their new hashes, to show them as they are now.
    relist();
  }
  showHash();
  if (body.filled && body.filled.length) {
    const set = body.filled.map((x) => `${x.part}: ${x.tech}`).join(', ');
    setNote('ok', `Saved ${String(body.commit).slice(0, 12)}. Tech set from the catalog: ${set}.`, [
      ['Show what was saved', () => openFile(path, { force: true, nav: 'replace' })],
    ]);
  } else {
    setNote('ok', body.unchanged ? 'Saved (nothing changed).' : `Saved ${String(body.commit).slice(0, 12)}`);
  }
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
  if (theirs && !(state.files || []).some((x) => x.path === f.path)) reloadFiles();
  if (theirs) keepFile(f.path, theirs.hash, theirs.text);
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
  if (!(await ask(`Delete ${f.path}?`, 'The file stays in the knowledge base history.', 'Delete'))) return;
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
  await relist();
}

/**
 * The listing again, and the files whose hash changed fetched ahead. A save while it was read
 * may be newer than it, so then it is dropped (that save lists again); the open file stays.
 */
async function relist() {
  const { repo, saves } = state;
  const { ok, body } = await call(`/api/kb/files?repo=${encodeURIComponent(repo)}`);
  if (state.repo !== repo) return;
  if (ok && state.saves === saves) {
    state.files = body.files;
    state.hasSystemPrompt = body.hasSystemPrompt;
    state.truncated = body.truncated;
    state.listedAt = Date.now();
    prefetchFiles(repo);
  }
  renderFiles();
}

/**
 * The knowledge base's agent changed `repo` (an answer in its sidebar, ui/kbchat.js): the
 * listing again; the open file, unless you are editing it, as it is now (or gone), and the
 * history, if that is open.
 */
async function changed(repo) {
  if (repo !== state.repo || !state.files) return;
  const open = state.view === 'file' && state.file && !state.file.isNew ? state.file : null;
  await relist();
  if (state.repo !== repo) return;
  if (state.view === 'history' && $('editor')) {
    showHistory({ force: true, nav: 'replace' });
    return;
  }
  if (!open || state.file !== open || edited()) return;
  const now = state.files.find((f) => f.path === open.path);
  if (!now) openFile(SYSTEM_PROMPT, { force: true, nav: 'replace' });
  else if (now.hash !== open.hash) openFile(open.path, { force: true, nav: 'replace' });
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
    <div class="log">${body.commits.map((c) => `<div class="c"><div class="h">${esc(c.hash)}, ${esc(new Date(c.at).toLocaleString())}, ${esc(c.author)}</div>
      <div class="m">${esc(c.message)}</div></div>`).join('') || '<div class="empty">No commits yet.</div>'}</div>`;
  return true;
}

// ---- start ------------------------------------------------------------------------------

// Back to the page after a while: agents and other people may have changed files meanwhile,
// and the prefetched files are those of the listing, so list them again.
const RELIST_MS = 30 * 1000;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.repo && state.listedAt
    && Date.now() - state.listedAt > RELIST_MS) relist();
});

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.file) {
    e.preventDefault();
    flush();
  }
});
// Leaving the page saves what is pending, without asking: keepalive lets the request finish.
window.addEventListener('pagehide', () => {
  const f = state.file;
  if (['clean', 'conflict', 'unnamed'].includes(fileState(f))) return;
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
// refused, a new file without a path) or that a save in flight may not include. Going to
// another page or section asks in the page instead (`leave`).
window.addEventListener('beforeunload', (e) => {
  if (['clean', 'editing'].includes(fileState())) return;
  e.preventDefault();
  e.returnValue = '';
});

// Phones: back to the column before (what is open stays open).
document.querySelector('main').addEventListener('click', (e) => {
  const to = e.target.closest('[data-up]');
  if (to) showPane(to.dataset.up);
});

window.Agent = {
  /** Who you are (/api/me), and the knowledge bases you may see (/api/kb), kept in place. */
  init(me, bases, {
    onUrl, onChange, onOpen, onWrite = () => {},
  } = {}) {
    state.me = me;
    state.bases = bases;
    // Yours (src/settings.js): whether your inbox shows the agent's thinking (renderAgents).
    state.settings = me.readonly ? null : me.settings || null;
    Object.assign(host, {
      onUrl, onChange, onOpen, onWrite,
    });
  },
  load,
  preload,
  /** Something changed: what was read of the agent is read again when it is shown next. */
  stale() {
    if (state.loads.meta) state.loads.metaAt = 0;
  },
  show,
  changed,
  /**
   * Before anything else is shown where the agent is: saves what is pending, and asks only
   * about edits that could not be saved. False when you stay.
   */
  leave() {
    // Asked once, however many ways out were taken meanwhile (a tab clicked twice).
    state.leaving = state.leaving || (async () => {
      if (!(await leave())) return false;
      // Saved, or given up on purpose: nothing for pagehide or beforeunload, and what was on
      // its way to the screen does not come.
      state.file = null;
      state.turn += 1;
      return true;
    })().finally(() => { state.leaving = null; });
    return state.leaving;
  },
  /** What is open, for the address: the view, and the file's path. */
  where: () => ({
    repo: state.repo,
    view: state.view,
    path: state.view === 'file' && state.file && !state.file.isNew ? state.file.path : null,
  }),
  /** The badges of the views of `repo`'s agent, once they are read (`load`); else none. */
  tags(repo) {
    if (repo !== state.repo || !state.channels) return {};
    return { agents: agentsTag(), mcp: `${toolsTag()}${mcpTag()}`, extraction: state.extraction ? extractionTag() : '' };
  },
  activity,
};
