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
 * The customer portal's page (src/portal/worker.js serves it; its API is src/portal/api.js).
 * A customer signs in with their work mail address and is in their company's lobby: they say
 * what they use of Adobe's, invite colleagues, and ask for a channel. Once Adobe has opened
 * one, the page is that channel: its threads on the left, the one picked on the right, as the
 * inbox's personal view is for Adobe's people, without the rest.
 *
 * The address keeps what is on screen: `/?c=<channel>&t=<thread>`, which is also what a
 * message's link in the inbox opens.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

/** How often the page asks for what is new while it is on screen. */
const POLL_MS = 15 * 1000;
/** What one reacts with. Adobe's ✅ on a thread's first message says it is resolved. */
const REACTIONS = ['👍', '✅', '🙏', '❤️', '🎉', '👀'];

const state = {
  me: null,
  data: null, // GET /api/me
  channel: null, // the channel on screen
  threads: [],
  thread: null, // the open thread, as GET /api/thread gives it
  sel: null, // its id, or 'new' while a thread is being written
  drafts: new Map(), // what is being written, by thread id ('new' for a new one)
  editing: null, // the message being changed
  error: '',
};

async function call(path, method = 'GET', body = undefined) {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message } };
  }
}

// ---- small things ---------------------------------------------------------------------------

const initials = (name) => String(name || '?').split(/[\s,]+/).filter(Boolean)
  .map((w) => w[0]).join('').slice(0, 2).toUpperCase();
/** One of the avatars' eight colors (ui/spectrum.css), the same for a person every time. */
function hue(id) {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}
const avatar = (who) => `<span class="av" data-hue="${hue(who.id)}" aria-hidden="true">${esc(initials(who.name))}</span>`;

function ago(at) {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const when = (at) => `<time datetime="${esc(at)}" title="${esc(new Date(at).toLocaleString())}">${esc(ago(at))}</time>`;

/** A message's text as the page shows it: markdown, with every image as a link to it. */
function bodyHtml(text) {
  const box = document.createElement('template');
  box.innerHTML = Markdown.render(text);
  for (const img of box.content.querySelectorAll('img')) {
    const a = document.createElement('a');
    a.href = img.getAttribute('src') || '';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = img.getAttribute('alt') || a.href;
    img.replaceWith(a);
  }
  return box.innerHTML;
}

function toUrl() {
  const q = new URLSearchParams();
  if (state.channel) q.set('c', state.channel.id);
  if (state.sel && state.sel !== 'new') q.set('t', state.sel);
  history.replaceState(null, '', q.size ? `/?${q}` : '/');
  // Phones show the threads or the one picked (see the styles).
  document.body.classList.toggle('picked', Boolean(state.sel));
}

// ---- you, at the right of the header ---------------------------------------------------------

function showMe() {
  const { me } = state;
  $('user').hidden = false;
  $('me').textContent = me.name;
  $('userSub').textContent = state.data.lobby?.company || state.data.company || state.data.domain;
  for (const id of ['userAv', 'menuAv']) {
    $(id).textContent = initials(me.name);
    $(id).dataset.hue = hue(me.id);
  }
  $('menuName').textContent = me.name;
  $('menuEmail').textContent = me.email;
  $('menuCompany').hidden = !(state.data.member && state.data.lobby.status === 'open');
}
$('menu').addEventListener('toggle', (e) => $('user').setAttribute('aria-expanded', String(e.newState === 'open')));

// ---- the lobby ---------------------------------------------------------------------------------

const STATUS_NOTE = {
  requested: ['notice', 'We have your request. Somebody at Adobe will open your channel; you find it here then. You can still change what you told us, and invite colleagues.'],
  declined: ['negative', 'We could not open a channel for you.'],
};

/**
 * The technologies in groups, by the product they are part of, in the inbox's order. A product
 * with one technology (Target, Workfront) is no group: those are together, last.
 */
function techGroups(tech) {
  const groups = new Map();
  for (const t of tech) {
    const key = t.product || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const many = [...groups].filter(([product, list]) => product && list.length > 1);
  const single = [...groups].filter(([product, list]) => !product || list.length === 1).flatMap(([, list]) => list);
  return [...many, ...(single.length ? [[many.length ? 'More from Adobe' : 'Adobe', single]] : [])];
}

/**
 * What a lobby says of itself, and who is in it: the page of a lobby without a channel, and
 * the "Your company and colleagues" dialog of one with. Every field saves as it changes.
 */
function lobbyForm(root, { dialog = false } = {}) {
  const { lobby, members, tech, domain, me } = state.data;
  const picked = new Set(lobby.tech);
  const note = STATUS_NOTE[lobby.status];
  const first = me.name.split(' ')[0];
  root.innerHTML = `
    ${dialog ? '' : `<h2 class="hello">Welcome, ${esc(first)}</h2>
      <p class="lead">Tell us what you use of Adobe's, and we open a channel for ${esc(lobby.company)}, with the people at Adobe who know it. Your colleagues join you there.</p>`}
    ${note && !dialog ? `<div class="banner ${note[0]}" role="status">${esc(note[1])}${lobby.reason ? ` <span class="reason">${esc(lobby.reason)}</span>` : ''}</div>` : ''}
    <section class="card"><h3>Your company</h3>
      <div class="pair"><label class="fld grow"><span>Company</span><input id="lbCompany" maxlength="120" value="${esc(lobby.company)}"></label>
      <label class="fld grow"><span>Your name</span><input id="lbName" maxlength="120" value="${esc(me.name)}" autocomplete="name"></label></div></section>
    <section class="card"><h3>What you use</h3>
      <div class="tech">${techGroups(tech).map(([product, list]) => `<fieldset><legend>${esc(product)}</legend>${list.map((t) => `<label class="pick"><input type="checkbox" value="${esc(t.tech)}"${picked.has(t.tech) ? ' checked' : ''}><span>${esc(t.name)}</span></label>`).join('')}</fieldset>`).join('')}</div></section>
    <section class="card"><h3>What you need</h3>
      <label class="fld"><span>What can we help you with? (optional)</span><textarea id="lbNote" rows="3" maxlength="2000">${esc(lobby.note)}</textarea></label></section>
    <section class="card"><h3>Your colleagues</h3>
      <ul class="people" id="lbPeople">${members.map((m) => `<li>${avatar(m)}<span class="nm">${esc(m.name)}</span><span class="sub">${esc(m.email)}</span>
        ${m.joined ? '' : `<span class="tag">invited</span><button type="button" class="link" data-uninvite="${esc(m.id)}">Take back</button>`}</li>`).join('')}</ul>
      <form class="pair" id="lbInvite"><label class="fld grow"><span>Work email of a colleague (@${esc(domain)})</span><input id="lbEmail" type="email" required autocomplete="off"></label>
        <button>Invite</button></form>
      <p class="hint">We send no mail. Tell the colleagues you invite to sign in at <a href="${esc(location.origin)}">${esc(location.host)}</a> with their work address, or <a id="lbMail" href="mailto:">write to them</a>.</p></section>
    <div class="status" id="lbStatus" role="status"></div>
    ${dialog || lobby.status === 'requested' ? '' : `<div class="actions"><button class="primary" id="lbAsk">${lobby.status === 'declined' ? 'Ask again' : 'Request a channel'}</button></div>`}`;
  const status = (text, err = false) => {
    const el = root.querySelector('#lbStatus');
    el.textContent = text;
    el.classList.toggle('err', err);
  };
  const saved = (res) => {
    if (!res.ok) { status(res.body.error || `Could not save (${res.status}).`, true); return false; }
    if (res.body.lobby) state.data.lobby = res.body.lobby;
    status('Saved.');
    return true;
  };
  const invited = members.filter((m) => !m.joined).map((m) => m.email);
  root.querySelector('#lbMail').href = `mailto:${invited.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent('Join us in Adobe Enterprise Support')}&body=${encodeURIComponent(`Sign in at ${location.origin} with your work address.`)}`;
  root.querySelector('#lbCompany').onchange = async (e) => {
    if (saved(await call('/api/lobby', 'PUT', { company: e.target.value }))) showMe();
  };
  root.querySelector('#lbName').onchange = async (e) => {
    const res = await call('/api/profile', 'PUT', { name: e.target.value });
    if (!res.ok) { status(res.body.error || 'Could not save.', true); return; }
    state.me.name = res.body.name;
    const mine = state.data.members.find((m) => m.id === state.me.id);
    if (mine) mine.name = res.body.name;
    showMe();
    status('Saved.');
  };
  root.querySelector('.tech').onchange = async () => {
    const ids = [...root.querySelectorAll('.tech input:checked')].map((i) => i.value);
    saved(await call('/api/lobby', 'PUT', { tech: ids }));
  };
  root.querySelector('#lbNote').onchange = async (e) => saved(await call('/api/lobby', 'PUT', { note: e.target.value }));
  const people = (res) => {
    if (!res.ok) { status(res.body.error || `Failed (${res.status}).`, true); return; }
    state.data.members = res.body.members;
    lobbyForm(root, { dialog });
  };
  root.querySelector('#lbInvite').onsubmit = async (e) => {
    e.preventDefault();
    people(await call('/api/invite', 'POST', { email: root.querySelector('#lbEmail').value }));
  };
  for (const b of root.querySelectorAll('[data-uninvite]')) {
    b.onclick = async () => people(await call('/api/invite', 'DELETE', { user: b.dataset.uninvite }));
  }
  const ask = root.querySelector('#lbAsk');
  if (ask) {
    ask.onclick = async () => {
      ask.disabled = true;
      const res = await call('/api/lobby/request', 'POST', {});
      if (saved(res)) showLobby();
      else ask.disabled = false;
    };
  }
}

function showLobby() {
  document.body.classList.remove('open');
  $('main').innerHTML = '<div class="lobby" id="lobby"></div>';
  lobbyForm($('lobby'));
}

/** "Your company and colleagues", from your menu, once there is a channel. */
function companyDialog() {
  $('menu').hidePopover();
  const dlg = document.createElement('dialog');
  dlg.className = 'company';
  dlg.innerHTML = '<div class="head"><h2>Your company and colleagues</h2><button type="button" class="x" aria-label="Close"><span class="s2-cross" aria-hidden="true"></span></button></div><div class="lobby" id="companyForm"></div>';
  document.body.append(dlg);
  lobbyForm(dlg.querySelector('#companyForm'), { dialog: true });
  dlg.querySelector('.x').onclick = () => dlg.close();
  dlg.addEventListener('close', () => Dialog.remove(dlg));
  dlg.showModal();
}
$('openCompany').onclick = companyDialog;

/** Asks before something is taken away: an alert dialog, its action the one that confirms. */
function confirmFirst(text, action) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.setAttribute('role', 'alertdialog');
    dlg.className = 'confirm';
    dlg.innerHTML = `<p>${esc(text)}</p><div class="actions"><button type="button" value="no">Cancel</button><button type="button" class="danger" value="yes">${esc(action)}</button></div>`;
    document.body.append(dlg);
    for (const b of dlg.querySelectorAll('button')) b.onclick = () => dlg.close(b.value);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'yes');
      Dialog.remove(dlg);
    });
    dlg.showModal();
  });
}

// ---- a channel: its threads, and the one picked ------------------------------------------------

function threadRow(t) {
  const who = t.author.kind === 'customer' ? t.author.name : `${t.author.name} (Adobe)`;
  const replies = t.replies ? ` · ${t.replies} ${t.replies === 1 ? 'reply' : 'replies'}` : '';
  return `<button type="button" class="row${state.sel === t.id ? ' on' : ''}${t.unread ? ' unread' : ''}" data-thread="${esc(t.id)}">
    <span class="top"><span class="name">${esc(t.title)}</span>${t.resolved ? '<span class="tag resolved" title="Adobe marked this resolved">resolved</span>' : ''}${t.unread ? `<span class="dot" title="${t.unread} new"></span>` : ''}</span>
    <span class="sub">${esc(who)}${replies} · ${esc(ago(t.latest))}</span></button>`;
}

function renderThreads() {
  const { channels } = state.data;
  const picker = channels.length > 1
    ? `<label class="fld grow"><span>Channel</span><select id="chPick">${channels.map((c) => `<option value="${esc(c.id)}"${c.id === state.channel.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`
    : `<h2 class="chan" title="${esc(state.channel.topic || '')}">${esc(state.channel.name)}</h2>`;
  $('threads').innerHTML = `<div class="bar">${picker}<button type="button" class="primary" id="newThread">New thread</button></div>
    ${state.error ? `<div class="status err" role="alert">${esc(state.error)}</div>` : ''}
    <div class="rows">${state.threads.map(threadRow).join('') || '<div class="empty">No threads yet. Start one: somebody at Adobe will answer here.</div>'}</div>`;
  if ($('chPick')) {
    $('chPick').onchange = (e) => openChannel(channels.find((c) => c.id === e.target.value));
  }
  $('newThread').onclick = () => select('new');
  for (const b of $('threads').querySelectorAll('[data-thread]')) b.onclick = () => select(b.dataset.thread);
}

async function loadThreads() {
  const res = await call(`/api/threads?channel=${encodeURIComponent(state.channel.id)}`);
  state.error = res.ok ? '' : res.body.error || `Could not load (${res.status}).`;
  if (res.ok) state.threads = res.body.threads;
  renderThreads();
}

function reactionChips(m) {
  const chips = m.reactions.map((r) => `<button type="button" class="chip" aria-pressed="${r.mine}" data-react="${esc(r.emoji)}" data-on="${esc(m.id)}" title="${esc(r.names.join(', '))}">${esc(r.emoji)} <span>${r.count}</span></button>`).join('');
  return `<div class="reactions">${chips}<button type="button" class="chip add" data-pick aria-expanded="false" aria-label="React" title="React">+</button>
    <div class="picker s2-float s2-up" role="menu" hidden>${REACTIONS.map((e) => `<button type="button" class="item" role="menuitem" data-react="${esc(e)}" data-on="${esc(m.id)}">${esc(e)}</button>`).join('')}</div></div>`;
}

/** The reactions to pick from, of one message at a time; a click anywhere else closes them. */
function closePickers(but = null) {
  for (const p of document.querySelectorAll('.reactions .picker:not([hidden])')) {
    if (p !== but) {
      p.hidden = true;
      p.previousElementSibling.setAttribute('aria-expanded', 'false');
    }
  }
}
document.addEventListener('click', (e) => {
  const add = e.target.closest?.('[data-pick]');
  const picker = add ? add.nextElementSibling : null;
  closePickers(picker);
  if (picker) {
    picker.hidden = !picker.hidden;
    add.setAttribute('aria-expanded', String(!picker.hidden));
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePickers(); });

function messageHtml(m) {
  const adobe = m.author.kind !== 'customer';
  if (m.deleted) return `<li class="msg gone" id="${esc(m.id)}"><span class="sub">This message was deleted.</span></li>`;
  const editing = state.editing === m.id;
  return `<li class="msg${m.mine ? ' mine' : ''}" id="${esc(m.id)}">${avatar(m.author)}
    <div class="what"><div class="by"><span class="nm">${esc(m.author.name)}</span>${adobe ? '<span class="tag adobe">Adobe</span>' : ''}${when(m.at)}${m.editedAt ? '<span class="sub">edited</span>' : ''}
      ${m.mine && !editing ? `<span class="own"><button type="button" class="link" data-edit="${esc(m.id)}">Edit</button><button type="button" class="link" data-delete="${esc(m.id)}">Delete</button></span>` : ''}</div>
    ${editing ? `<form class="edit" data-save="${esc(m.id)}"><label class="fld"><span>Your message</span><textarea rows="4" maxlength="8000" required>${esc(m.body)}</textarea></label>
        <div class="actions"><button type="button" data-cancel>Cancel</button><button class="primary">Save</button></div></form>`
    : `<div class="body">${bodyHtml(m.body)}</div>${reactionChips(m)}`}</div></li>`;
}

/** The field a message is written in, and what sends it: Enter with Ctrl or ⌘, or the button. */
function composer(key, label, action) {
  return `<form class="composer" id="composer"><label class="fld"><span>${esc(label)}</span>
    <textarea id="text" rows="${key === 'new' ? 8 : 3}" maxlength="8000" required>${esc(state.drafts.get(key) || '')}</textarea></label>
    <div class="actions"><span class="status err" id="sendStatus" role="alert"></span><button class="primary" id="send">${esc(action)}</button></div></form>`;
}

function wireComposer(key, send) {
  const text = $('text');
  text.oninput = () => state.drafts.set(key, text.value);
  text.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); }
  };
  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    $('send').disabled = true;
    const res = await send(text.value);
    if (!res.ok) {
      $('send').disabled = false;
      $('sendStatus').textContent = res.body.error || `Could not send (${res.status}).`;
      return;
    }
    state.drafts.delete(key);
    await Promise.all([loadThreads(), select(res.body.root, { keep: false })]);
  };
}

const back = '<button type="button" class="back" id="back" aria-label="Back to the threads"><span class="s2-chevron" aria-hidden="true"></span></button>';

function renderPane({ keep = true } = {}) {
  const pane = $('pane');
  if (!state.sel) {
    pane.innerHTML = '<div class="empty pick">Pick a thread, or start a new one.</div>';
    return;
  }
  if (state.sel === 'new') {
    pane.innerHTML = `<div class="title">${back}<h2>New thread in ${esc(state.channel.name)}</h2></div>
      <div class="scroll">${composer('new', 'What is it about? The first line is the thread\'s title.', 'Start thread')}</div>`;
    wireComposer('new', (text) => call('/api/post', 'POST', { channel: state.channel.id, text }));
    $('back').onclick = () => select(null);
    $('text').focus();
    return;
  }
  const t = state.thread;
  if (!t) { pane.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const scroll = pane.querySelector('.scroll');
  const atEnd = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  const at = scroll ? scroll.scrollTop : 0;
  const typing = document.activeElement === $('text') ? [$('text').selectionStart, $('text').selectionEnd] : null;
  pane.innerHTML = `<div class="title">${back}<h2>${esc(t.title)}</h2>${t.resolved ? '<span class="tag resolved" title="Adobe marked this resolved. Write again if it is not.">resolved</span>' : ''}</div>
    <div class="scroll"><ol class="messages">${t.messages.map(messageHtml).join('')}</ol></div>
    ${composer(t.id, 'Reply', 'Send')}`;
  const now = pane.querySelector('.scroll');
  now.scrollTop = keep && !atEnd ? at : now.scrollHeight;
  if (location.hash && !keep) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  $('back').onclick = () => select(null);
  wireComposer(t.id, (text) => call('/api/post', 'POST', { channel: state.channel.id, thread: t.id, text }));
  if (typing) { $('text').focus(); $('text').setSelectionRange(...typing); }
  const act = async (res) => {
    if (!res.ok) { $('sendStatus').textContent = res.body.error || `Failed (${res.status}).`; return; }
    await Promise.all([loadThread(), loadThreads()]);
  };
  for (const b of pane.querySelectorAll('[data-react]')) {
    b.onclick = async () => {
      const mine = b.classList.contains('chip') && b.getAttribute('aria-pressed') === 'true';
      act(await call('/api/react', 'POST', {
        channel: state.channel.id, id: b.dataset.on, emoji: b.dataset.react, remove: mine,
      }));
    };
  }
  for (const b of pane.querySelectorAll('[data-edit]')) {
    b.onclick = () => { state.editing = b.dataset.edit; renderPane(); };
  }
  for (const b of pane.querySelectorAll('[data-delete]')) {
    b.onclick = async () => {
      if (!await confirmFirst('Delete this message? Adobe sees that it was deleted.', 'Delete')) return;
      act(await call('/api/delete', 'POST', { channel: state.channel.id, id: b.dataset.delete }));
    };
  }
  for (const f of pane.querySelectorAll('form.edit')) {
    f.querySelector('[data-cancel]').onclick = () => { state.editing = null; renderPane(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const res = await call('/api/edit', 'POST', {
        channel: state.channel.id, id: f.dataset.save, text: f.querySelector('textarea').value,
      });
      if (res.ok) state.editing = null;
      act(res);
    };
  }
}

async function loadThread({ keep = true } = {}) {
  const id = state.sel;
  if (!id || id === 'new') return;
  const res = await call(`/api/thread?channel=${encodeURIComponent(state.channel.id)}&thread=${encodeURIComponent(id)}`);
  if (state.sel !== id) return;
  if (!res.ok) {
    state.thread = null;
    $('pane').innerHTML = `<div class="empty">${esc(res.body.error || 'Could not load this thread.')}</div>`;
    return;
  }
  // What is being edited or typed stays as it is while nothing changed.
  const same = state.thread && JSON.stringify(state.thread) === JSON.stringify(res.body.thread);
  state.thread = res.body.thread;
  if (!same) renderPane({ keep });
  const row = state.threads.find((t) => t.id === id);
  if (row && row.unread) { row.unread = 0; renderThreads(); }
}

async function select(id, { keep = false } = {}) {
  if (state.sel !== id) { state.thread = null; state.editing = null; }
  state.sel = id;
  toUrl();
  renderThreads();
  renderPane({ keep });
  await loadThread({ keep });
}

async function openChannel(channel, thread = null) {
  state.channel = channel;
  state.threads = [];
  state.thread = null;
  state.sel = thread;
  document.body.classList.add('open');
  $('main').innerHTML = '<section id="threads" aria-label="Threads"></section><section id="pane" aria-label="Thread"></section>';
  Swap.watch($('pane'), () => state.sel);
  toUrl();
  renderThreads();
  renderPane();
  await Promise.all([loadThreads(), loadThread({ keep: false })]);
}

// ---- start ---------------------------------------------------------------------------------------

function notice(title, text) {
  document.body.classList.remove('open');
  $('main').innerHTML = `<div class="lobby"><h2 class="hello">${esc(title)}</h2><p class="lead">${text}</p></div>`;
}

async function start() {
  const res = await call('/api/me');
  if (!res.ok) {
    if (res.body.closed) {
      notice('Not open to you yet', `Enterprise Support's portal is not open to your company yet. You are signed in as ${esc(res.body.email)}. <a href="/cdn-cgi/access/logout">Log out</a>`);
    } else {
      notice('Something went wrong', esc(res.body.error || `The portal answered ${res.status}.`));
    }
    return;
  }
  state.data = res.body;
  state.me = res.body.me;
  showMe();
  if (!res.body.member) {
    const here = res.body.colleagues;
    notice(`${esc(res.body.company || res.body.domain)} is here already`, here.length
      ? `Ask a colleague to invite you, then come back: ${here.map((c) => `<a href="mailto:${esc(c.email)}">${esc(c.name)}</a>`).join(', ')}.`
      : 'Ask the colleague who told you about this portal to invite you, then come back.');
    return;
  }
  if (res.body.lobby.status !== 'open' || !res.body.channels.length) {
    showLobby();
    return;
  }
  const q = new URLSearchParams(location.search);
  const channel = res.body.channels.find((c) => c.id === q.get('c')) || res.body.channels[0];
  await openChannel(channel, q.get('t'));
}

/** What is new, while the page is on screen: the channel once it is opened, then its threads. */
async function poll() {
  if (document.visibilityState !== 'visible' || !state.data?.member) return;
  if (!state.channel) {
    const res = await call('/api/me');
    if (res.ok && res.body.member && res.body.lobby.status !== state.data.lobby.status) start();
    return;
  }
  // Not while a message is being changed: its field would be drawn again.
  if (state.editing) return;
  await Promise.all([loadThreads(), loadThread()]);
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
window.addEventListener('opspile:signedin', () => (state.data ? poll() : start()));

start();
