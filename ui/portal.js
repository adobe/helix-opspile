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
 * what they use of Adobe's, upload their picture and their company's logo, invite colleagues,
 * and ask for a channel. Once Adobe has opened one, the page is that channel: its threads on
 * the left, the one picked on the right, as the inbox's personal view is for Adobe's people,
 * without the rest.
 *
 * Writing is as in the inbox: markdown with Slack's formatting shortcuts and a toolbar for
 * them (ui/writing.js), `@` for the people of the channel, `:` for emoji, files attached,
 * pasted or dropped, with a preview of what will be sent. Messages show their author's
 * picture, their images and their files.
 *
 * The address keeps what is on screen: `/?c=<channel>&t=<thread>`.
 */

// Emoji by the names Slack, GitHub, Discord and Teams give them: src/portal/page.js fills
// them in where the page is served.
const EMOJI = /* PORTAL_EMOJI */ { names: {}, skin: [], aliases: {} };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

/** How often the page asks for what is new while it is on screen. */
const POLL_MS = 15 * 1000;
/** The channel's people are asked for again when the list is this old. */
const PEOPLE_MS = 60 * 1000;
/** What a message's file may weigh, and how many it carries (src/portal/files.js). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
/** The images the page shows in a message; any other file is a card to download. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
/** What one reacts with first. Adobe's ✅ on a thread's first message says it is resolved. */
const REACTIONS = ['+1', 'white_check_mark', 'pray', 'heart', 'tada', 'eyes'];
/** The emoji the picker starts with, by name. */
const COMMON = [
  '+1', 'pray', 'tada', 'white_check_mark', 'eyes', 'heart', 'joy', 'smile', 'thinking_face',
  'rocket', 'fire', '100', 'wave', 'raised_hands', 'clap', 'ok_hand', 'slightly_smiling_face',
  'grin', 'sob', 'warning', 'bulb', 'bug', 'hourglass_flowing_sand', 'question',
];
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';

const state = {
  me: null,
  data: null, // GET /api/me
  channel: null, // the channel on screen
  threads: [],
  thread: null, // the open thread, as GET /api/thread gives it
  sel: null, // its id, or 'new' while a thread is being written
  people: [], // who can be mentioned in the channel
  peopleAt: 0,
  drafts: new Map(), // what is being written, by thread id ('new' for a new one)
  uploads: new Map(), // the files being attached to it, by the same key
  editing: null, // the message being changed
  suggest: null, // the composer's open suggestions: { kind, from, items, at }
  error: '',
};
let uploadSeq = 0;

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

/** A request whose body is a file's bytes: an upload, a picture, a logo. */
async function send(path, method, blob) {
  try {
    const res = await fetch(path, {
      method, headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob,
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
/**
 * Someone's face: their picture over their initials, which stay where there is no picture
 * (the portal answers 404 then, and the image goes).
 */
const avatar = (who, cls = '') => `<span class="av ${cls}" data-hue="${hue(who.id)}" aria-hidden="true">${esc(initials(who.name))}${who.avatar
  ? `<img src="${esc(who.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;

function ago(at) {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const when = (at) => `<time datetime="${esc(at)}" title="${esc(new Date(at).toLocaleString())}">${esc(ago(at))}</time>`;
const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---- emoji and mentions -----------------------------------------------------------------------

const emojiName = Markdown.emojiLookup(EMOJI.names, EMOJI.aliases, EMOJI.skin);
/** The character of an emoji name (`tada`, `+1::skin-tone-3`), or undefined. */
function emojiChar(name) {
  const [base, tone] = String(emojiName(name) || '').split('::skin-tone-');
  const c = EMOJI.names[base];
  if (!c || !tone) return c;
  const [first, ...rest] = [...c];
  if (rest[0] === '\uFE0F') rest.shift();
  return [first, String.fromCodePoint(0x1f3fb + Number(tone) - 2), ...rest].join('');
}
/** Plain text with its `:names:` as emoji (a thread's title). */
const emojify = (text) => String(text || '').replace(/:([a-z0-9_+-]+(?:::skin-tone-[2-6])?):/g, (m, n) => emojiChar(n) || m);

/** The people of the channel by name, and the pattern that finds their `@Name` in a message. */
let mentionNames = null;
const personNamed = (name) => state.people.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
function setPeople(people) {
  state.people = people;
  state.peopleAt = Date.now();
  mentionNames = Markdown.mentionPattern(people.map((p) => p.name));
}

/**
 * A message's text as the page shows it: markdown, with its mentions marked (one of the
 * reader stands out), its `:names:` as emoji, and every image in the text as a link to it:
 * the images a message shows are the files it carries.
 */
function bodyHtml(text) {
  const box = document.createElement('template');
  box.innerHTML = Markdown.render(text, {
    mentions: mentionNames,
    kindOf: (name) => (personNamed(name)?.kind === 'staff' ? 'adobe' : undefined),
    emoji: (name) => { const c = emojiChar(name); return c ? esc(c) : undefined; },
  });
  for (const img of box.content.querySelectorAll('img')) {
    const a = document.createElement('a');
    a.href = img.getAttribute('src') || '';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = img.getAttribute('alt') || a.href;
    img.replaceWith(a);
  }
  for (const el of box.content.querySelectorAll('.mention')) {
    if (el.textContent.slice(1).toLowerCase() === state.me.name.toLowerCase()) el.classList.add('me');
  }
  return box.innerHTML;
}

// ---- files ------------------------------------------------------------------------------------

/** An image of a message, as large as the thread shows it: its space is there before it loads. */
function shot(f) {
  const scale = f.width && f.height ? Math.min(1, 320 / f.height, 520 / f.width) : 0;
  const size = scale ? ` width="${Math.max(1, Math.round(f.width * scale))}" height="${Math.max(1, Math.round(f.height * scale))}"` : '';
  return `<button type="button" class="shot" data-zoom="${esc(f.url)}" data-name="${esc(f.name)}" aria-label="Show ${esc(f.name)} larger"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"${size}></button>`;
}

/** A file that is no image: what it is, its name to download it by, and a player where it plays. */
function fileCard(f) {
  const { kind, label, ext } = Markdown.fileKind(f.name);
  let player = '';
  if (kind === 'video' && /^video\//.test(f.type)) player = `<video class="player" controls playsinline preload="none" src="${esc(f.url)}" aria-label="Play ${esc(f.name)}"></video>`;
  else if (kind === 'audio' && /^audio\//.test(f.type)) player = `<audio class="player" controls preload="none" src="${esc(f.url)}" aria-label="Play ${esc(f.name)}"></audio>`;
  return `<div class="file">${player}<span class="file-ico" aria-hidden="true">${esc((ext || 'file').slice(0, 4).toUpperCase())}</span>
    <span class="file-nm"><a class="file-name" href="${esc(f.url)}" download="${esc(f.name)}" title="Download ${esc(f.name)}">${esc(f.name)}</a><span class="sub">${esc(label)} · ${esc(bytes(f.size))}</span></span></div>`;
}

function filesHtml(files) {
  const images = files.filter((f) => IMAGE.test(f.type));
  const rest = files.filter((f) => !IMAGE.test(f.type));
  return `${images.length ? `<div class="gallery">${images.map(shot).join('')}</div>` : ''}${rest.length ? `<div class="files">${rest.map(fileCard).join('')}</div>` : ''}`;
}

/** An image of a message, as large as the window: a click, or Escape, closes it. */
function lightbox(url, name) {
  const dlg = document.createElement('dialog');
  dlg.className = 'lightbox';
  dlg.innerHTML = `<img src="${esc(url)}" alt="${esc(name)}">
    <div class="bar"><a href="${esc(url)}" download="${esc(name)}">Download</a><button type="button" aria-label="Close"><span class="s2-cross" aria-hidden="true"></span></button></div>`;
  document.body.append(dlg);
  dlg.addEventListener('click', (e) => { if (!e.target.closest('a')) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

/**
 * An image file as a smaller one, drawn by the browser: a picture as a square of `size`
 * pixels (`cover`), a logo within it. A PNG where that is small enough (a logo's see-through
 * parts stay), else a JPEG.
 */
async function resized(file, size, cover) {
  const img = new Image();
  const src = URL.createObjectURL(file);
  try {
    img.src = src;
    await img.decode();
  } finally {
    URL.revokeObjectURL(src);
  }
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) throw new Error('not an image the browser can read');
  const scale = cover ? size / Math.min(w, h) : Math.min(1, size / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = cover ? size : Math.round(w * scale);
  canvas.height = cover ? size : Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, (canvas.width - w * scale) / 2, (canvas.height - h * scale) / 2, w * scale, h * scale);
  const blob = (type, quality) => new Promise((resolve) => { canvas.toBlob(resolve, type, quality); });
  const png = cover ? null : await blob('image/png');
  return png && png.size <= 400 * 1024 ? png : blob('image/jpeg', 0.88);
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
    $(id).innerHTML = `${esc(initials(me.name))}${me.avatar ? `<img src="${esc(me.avatar)}" alt="" onerror="this.remove()">` : ''}`;
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

/** A picture and the buttons that change it: yours (`avatar`) or your company's (`logo`). */
function pictureField(what, { src, text, hueOf, has }) {
  const label = what === 'avatar' ? 'picture' : 'logo';
  return `<div class="pic ${what}"><span class="av big${what === 'logo' ? ' square' : ''}" data-hue="${hueOf}" aria-hidden="true">${esc(text)}${src ? `<img src="${esc(src)}" alt="" onerror="this.remove()">` : ''}</span>
    <span class="pic-act"><button type="button" data-upload="${what}">${has ? `Change ${label}` : `Upload ${label}`}</button>${has ? `<button type="button" class="link" data-clear="${what}">Remove</button>` : ''}
    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-file="${what}" hidden></span></div>`;
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
      <div class="pair top">${pictureField('logo', {
    src: lobby.logo, text: initials(lobby.company), hueOf: hue(domain), has: Boolean(lobby.logo),
  })}
      <label class="fld grow"><span>Company</span><input id="lbCompany" maxlength="120" value="${esc(lobby.company)}"></label></div></section>
    <section class="card"><h3>You</h3>
      <div class="pair top">${pictureField('avatar', {
    src: me.avatar, text: initials(me.name), hueOf: hue(me.id), has: Boolean(me.picture),
  })}
      <label class="fld grow"><span>Your name</span><input id="lbName" maxlength="120" value="${esc(me.name)}" autocomplete="name"></label></div>
      <p class="hint">Your picture and name are what Adobe and your colleagues see beside what you write. Without a picture of your own, the one Gravatar has for your address shows.</p></section>
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
  /** Your picture, as it is now, wherever the page shows you. */
  const pictured = (body) => {
    Object.assign(state.me, { avatar: body.avatar, picture: body.picture });
    const mine = state.data.members.find((m) => m.id === state.me.id);
    if (mine) Object.assign(mine, { avatar: body.avatar });
    showMe();
    if (state.channel) { state.peopleAt = 0; refresh(); }
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
  // A picture or a logo: made small in the browser, then kept by the portal.
  for (const b of root.querySelectorAll('[data-upload]')) {
    b.onclick = () => root.querySelector(`[data-file="${b.dataset.upload}"]`).click();
  }
  for (const input of root.querySelectorAll('[data-file]')) {
    input.onchange = async () => {
      const [file] = input.files;
      if (!file) return;
      const what = input.dataset.file;
      status('Uploading…');
      let res;
      try {
        res = await send(`/api/${what}`, 'PUT', await resized(file, what === 'avatar' ? 256 : 512, what === 'avatar'));
      } catch (e) {
        status(`Could not read that image (${e.message}).`, true);
        return;
      }
      if (!res.ok) { status(res.body.error || `Could not upload (${res.status}).`, true); return; }
      if (what === 'avatar') pictured(res.body); else state.data.lobby = res.body.lobby;
      lobbyForm(root, { dialog });
    };
  }
  for (const b of root.querySelectorAll('[data-clear]')) {
    b.onclick = async () => {
      const what = b.dataset.clear;
      const res = await call(`/api/${what}`, 'DELETE', {});
      if (!res.ok) { status(res.body.error || `Failed (${res.status}).`, true); return; }
      if (what === 'avatar') pictured(res.body); else state.data.lobby = res.body.lobby;
      lobbyForm(root, { dialog });
    };
  }
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
  dlg.addEventListener('close', () => { Dialog.remove(dlg); renderThreads(); });
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

// ---- a channel: its threads ---------------------------------------------------------------------

function threadRow(t) {
  const who = t.author.kind === 'customer' ? t.author.name : `${t.author.name} (Adobe)`;
  const replies = t.replies ? ` · ${t.replies} ${t.replies === 1 ? 'reply' : 'replies'}` : '';
  return `<button type="button" class="row${state.sel === t.id ? ' on' : ''}${t.unread ? ' unread' : ''}" data-thread="${esc(t.id)}">
    <span class="top"><span class="name">${esc(emojify(t.title))}</span>${t.mentioned ? '<span class="tag you" title="Someone mentioned you here">@ you</span>' : ''}${t.resolved ? '<span class="tag resolved" title="Adobe marked this resolved">resolved</span>' : ''}${t.unread ? `<span class="dot" title="${t.unread} new"></span>` : ''}</span>
    <span class="sub">${esc(who)}${replies} · ${esc(ago(t.latest))}</span></button>`;
}

function renderThreads() {
  if (!$('threads')) return;
  const { channels, lobby, domain } = state.data;
  const logo = `<span class="av square" data-hue="${hue(domain)}" aria-hidden="true">${esc(initials(lobby.company))}${lobby.logo ? `<img src="${esc(lobby.logo)}" alt="" onerror="this.remove()">` : ''}</span>`;
  const picker = channels.length > 1
    ? `<label class="fld grow"><span>Channel</span><select id="chPick">${channels.map((c) => `<option value="${esc(c.id)}"${c.id === state.channel.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`
    : `<h2 class="chan" title="${esc(state.channel.topic || '')}">${esc(state.channel.name)}</h2>`;
  $('threads').innerHTML = `<div class="bar">${logo}${picker}<button type="button" class="primary" id="newThread">New thread</button></div>
    ${state.error ? `<div class="status err" role="alert">${esc(state.error)}</div>` : ''}
    <div class="rows">${state.threads.map(threadRow).join('') || '<div class="empty">No threads yet. Start one: somebody at Adobe will answer here.</div>'}</div>`;
  if ($('chPick')) {
    $('chPick').onchange = (e) => openChannel(channels.find((c) => c.id === e.target.value));
  }
}

async function loadThreads() {
  const channel = encodeURIComponent(state.channel.id);
  const [res, people] = await Promise.all([
    call(`/api/threads?channel=${channel}`),
    Date.now() - state.peopleAt > PEOPLE_MS ? call(`/api/people?channel=${channel}`) : null,
  ]);
  if (people && people.ok) setPeople(people.body.people);
  state.error = res.ok ? '' : res.body.error || `Could not load (${res.status}).`;
  if (res.ok) state.threads = res.body.threads;
  renderThreads();
}

// ---- the thread picked: its messages ------------------------------------------------------------

function reactionChips(m) {
  const chips = m.reactions.map((r) => `<button type="button" class="chip" aria-pressed="${r.mine}" data-react="${esc(r.emoji)}" data-on="${esc(m.id)}" title="${esc(r.names.join(', '))}">${esc(r.emoji)} <span>${r.count}</span></button>`).join('');
  return `<div class="reactions">${chips}<button type="button" class="chip add" data-pick="${esc(m.id)}" aria-haspopup="true" aria-expanded="false" aria-label="React" title="React">+</button></div>`;
}

function messageHtml(m) {
  const adobe = m.author.kind !== 'customer';
  if (m.deleted) return `<li class="msg gone" id="${esc(m.id)}"><span class="sub">This message was deleted.</span></li>`;
  const editing = state.editing === m.id;
  return `<li class="msg${m.mine ? ' mine' : ''}${m.mentionsMe ? ' names-me' : ''}" id="${esc(m.id)}">${avatar(m.author)}
    <div class="what"><div class="by"><span class="nm">${esc(m.author.name)}</span>${adobe ? '<span class="tag adobe">Adobe</span>' : ''}${when(m.at)}${m.editedAt ? '<span class="sub">edited</span>' : ''}
      ${m.mine && !editing ? `<span class="own"><button type="button" class="link" data-edit="${esc(m.id)}">Edit</button><button type="button" class="link" data-delete="${esc(m.id)}">Delete</button></span>` : ''}</div>
    ${editing ? `<form class="edit" data-save="${esc(m.id)}"><label class="fld"><span>Your message</span><textarea rows="4" maxlength="8000">${esc(m.body)}</textarea></label>
        <div class="actions"><button type="button" data-cancel>Cancel</button><button class="primary">Save</button></div></form>`
    : `${m.body ? `<div class="body">${bodyHtml(m.body)}</div>` : ''}${filesHtml(m.files || [])}${reactionChips(m)}`}</div></li>`;
}

// ---- writing ------------------------------------------------------------------------------------

const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// The formatting ui/writing.js writes, with the keys that do the same.
const FORMATS = [
  ['bold', 'Bold', `${MOD}B`, '<b>B</b>'],
  ['italic', 'Italic', `${MOD}I`, '<i>I</i>'],
  ['strike', 'Strikethrough', `${MOD}⇧X`, '<s>S</s>'],
  ['code', 'Code', `${MOD}⇧C`, ICON('M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5')],
  ['link', 'Link', `${MOD}⇧U`, ICON('M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7')],
  ['bullet', 'Bulleted list', `${MOD}⇧8`, ICON('M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01')],
  ['number', 'Numbered list', `${MOD}⇧7`, ICON('M7 4h7M7 8h7M7 12h7M2 3l1.2-.6V6M2 10.2c.4-.6 2.2-.6 2 .6-.1.7-1.3 1.2-2 2.2h2.2')],
  ['quote', 'Quote', `${MOD}⇧9`, ICON('M3 3v10M6.5 5h7M6.5 8h7M6.5 11h4')],
];
const TOOLS = `${FORMATS.map(([kind, label, keys, glyph]) => `<button type="button" class="tool" data-format="${kind}" title="${label} (${keys})" aria-label="${label}">${glyph}</button>`).join('')}
  <span class="gap"></span>
  <button type="button" class="tool" data-tool="mention" title="Mention someone (@)" aria-label="Mention someone"><b>@</b></button>
  <button type="button" class="tool" data-tool="emoji" title="Emoji (:)" aria-label="Emoji" aria-haspopup="true" aria-expanded="false">${ICON('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM5.5 9.5c.6 1 1.5 1.5 2.5 1.5s1.9-.5 2.5-1.5M6 6.5h.01M10 6.5h.01')}</button>
  <button type="button" class="tool" data-tool="attach" title="Attach files" aria-label="Attach files">${ICON('M13 7.5 7.8 12.7a3.1 3.1 0 0 1-4.4-4.4l5.6-5.6a2.1 2.1 0 0 1 2.9 2.9l-5.5 5.6a1 1 0 0 1-1.5-1.5l5-5')}</button>
  <button type="button" class="tool text" data-tool="preview" aria-pressed="false" title="See it as it will be sent">Preview</button>`;

/** The field a message is written in, with its toolbar, its files and what sends it. */
function composer(key, label, action) {
  return `<form class="composer" id="composer" data-key="${esc(key)}">
    <ul class="suggest s2-float s2-up" id="suggest" role="listbox" aria-label="Suggestions" hidden></ul>
    <div class="tools" role="toolbar" aria-label="Formatting">${TOOLS}</div>
    <label class="fld"><span>${esc(label)}</span>
    <textarea id="text" rows="${key === 'new' ? 8 : 3}" maxlength="8000" role="combobox" aria-autocomplete="list" aria-controls="suggest" aria-expanded="false">${esc(state.drafts.get(key) || '')}</textarea></label>
    <div class="preview body" id="preview" hidden></div>
    <div class="tray" id="tray" hidden></div>
    <input type="file" id="files" multiple hidden>
    <div class="actions"><span class="status err" id="sendStatus" role="alert"></span><button class="primary" id="send">${esc(action)}</button></div></form>`;
}

/** The files being attached to what is written at `key`: each with how far its upload is. */
function renderTray(key) {
  const tray = $('tray');
  if (!tray || $('composer').dataset.key !== key) return;
  const list = state.uploads.get(key) || [];
  tray.hidden = !list.length;
  tray.innerHTML = list.map((u) => `<span class="chip up ${u.status}"${u.error ? ` title="${esc(u.error)}"` : ''}>${u.thumb ? `<img src="${esc(u.thumb)}" alt="">` : `<span class="file-ico" aria-hidden="true">${esc((Markdown.fileKind(u.name).ext || 'file').slice(0, 4).toUpperCase())}</span>`}
    <span class="file-nm"><span class="file-name">${esc(u.name)}</span><span class="sub">${esc(u.status === 'error' ? u.error : (u.status === 'uploading' ? 'Uploading…' : bytes(u.size)))}</span></span>
    <button type="button" class="x" data-drop="${u.n}" aria-label="Remove ${esc(u.name)}"><span class="s2-cross" aria-hidden="true"></span></button></span>`).join('');
  if ($('send')) $('send').disabled = list.some((u) => u.status === 'uploading');
}

/** Attaches files to what is written at `key`: each is uploaded at once, for the message. */
function addFiles(key, files) {
  const list = state.uploads.get(key) || state.uploads.set(key, []).get(key);
  for (const file of files) {
    uploadSeq += 1;
    const u = {
      n: uploadSeq, name: file.name || 'file', size: file.size, type: file.type, status: 'uploading', thumb: IMAGE.test(file.type) ? URL.createObjectURL(file) : null,
    };
    if (list.length >= MAX_FILES) Object.assign(u, { status: 'error', error: `Up to ${MAX_FILES} files a message` });
    else if (file.size > MAX_FILE_BYTES) Object.assign(u, { status: 'error', error: `Up to ${bytes(MAX_FILE_BYTES)} a file` });
    else if (!file.size) Object.assign(u, { status: 'error', error: 'The file is empty' });
    list.push(u);
    if (u.status === 'uploading') {
      const q = new URLSearchParams({ channel: state.channel.id, name: u.name });
      send(`/api/upload?${q}`, 'POST', file).then((res) => {
        Object.assign(u, res.ok ? { status: 'done', id: res.body.file.id }
          : { status: 'error', error: res.body.error || `Could not upload (${res.status})` });
        renderTray(key);
      });
    }
  }
  renderTray(key);
}

/**
 * What is being typed at the caret that suggestions answer: a mention (`@` and the start of
 * the words of a name), or an emoji's name (`:` and two letters or more).
 */
function suggestFor(box) {
  if (box.selectionStart !== box.selectionEnd) return null;
  const before = box.value.slice(0, box.selectionStart);
  const at = /(?:^|[\s(>])@([^\s@][^@\n]{0,40})?$/.exec(before);
  const q = at ? at[1] || '' : null;
  if (q !== null && !/\s$/.test(q)) {
    const typed = q.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = state.people.filter((p) => p.id !== state.me.id)
      .map((p) => ({ ...p, here: true, staff: p.kind === 'staff' }));
    // Every word typed starts a word of the name: what follows a name written out is no name.
    const named = (p) => typed.every((w) => p.name.toLowerCase().split(/\s+/).some((n) => n.startsWith(w)));
    const items = Markdown.suggestMentions({ accounts: pool.filter(named) }, q)
      .map((r) => pool.find((p) => p.id === r.id));
    if (items.length) return { kind: 'mention', from: before.length - q.length - 1, items };
  }
  const colon = /(?:^|[\s(>]):([a-z0-9_+-]{2,30})$/i.exec(before);
  if (colon) {
    const items = Markdown.matchEmoji(EMOJI.names, EMOJI.aliases, colon[1], 8)
      .map((name) => ({ name, char: emojiChar(name) })).filter((e) => e.char);
    if (items.length) return { kind: 'emoji', from: before.length - colon[1].length - 1, items };
  }
  return null;
}

function renderSuggest() {
  const ul = $('suggest');
  const box = $('text');
  if (!ul || !box) return;
  const s = state.suggest;
  ul.hidden = !s;
  box.setAttribute('aria-expanded', String(Boolean(s)));
  if (!s) { box.removeAttribute('aria-activedescendant'); return; }
  ul.innerHTML = s.items.map((item, i) => `<li role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === s.at}">${s.kind === 'mention'
    ? `${avatar(item)}<span class="nm">${esc(item.name)}</span>${item.kind === 'staff' ? '<span class="tag adobe">Adobe</span>' : ''}`
    : `<span class="glyph" aria-hidden="true">${esc(item.char)}</span><span class="nm">:${esc(item.name)}:</span>`}</li>`).join('');
  box.setAttribute('aria-activedescendant', `sg-${s.at}`);
}

function updateSuggest() {
  const next = $('text') ? suggestFor($('text')) : null;
  state.suggest = next ? { ...next, at: 0 } : null;
  renderSuggest();
}

/** Takes suggestion `i`: the name typed becomes the person's `@Name`, or the emoji itself. */
function takeSuggestion(i) {
  const s = state.suggest;
  const box = $('text');
  if (!s || !box || !s.items[i]) return;
  const insert = s.kind === 'mention' ? `@${s.items[i].name} ` : `${s.items[i].char} `;
  const at = s.from + insert.length;
  Writing.applyText(box, {
    from: s.from, to: box.selectionStart, insert, start: at, end: at,
  });
  state.suggest = null;
  renderSuggest();
}

/** Puts `text` where the caret of the text box is. */
function insertAtCaret(box, text) {
  const at = box.selectionStart + text.length;
  Writing.applyText(box, {
    from: box.selectionStart, to: box.selectionEnd, insert: text, start: at, end: at,
  });
}

/**
 * The emoji to pick from, under `anchor`: the usual ones (`first`, by name), and those whose
 * name has what is typed in its search field. `pick(character)` gets the one picked; a click
 * elsewhere, or Escape, closes it.
 */
function emojiPicker(anchor, first, pick) {
  const open = document.querySelector('.picker');
  const again = open && open.previousElementSibling === anchor;
  closePicker();
  if (again) return;
  const panel = document.createElement('div');
  panel.className = 'picker s2-float s2-up';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Emoji');
  const grid = (names) => names.map((n) => [n, emojiChar(n)]).filter(([, c]) => c)
    .map(([n, c]) => `<button type="button" class="item" data-emoji="${esc(c)}" title=":${esc(n)}:">${esc(c)}</button>`).join('');
  panel.innerHTML = `<label class="s2-search"><input type="search" aria-label="Find an emoji" autocomplete="off"></label><div class="grid">${grid(first)}</div>`;
  anchor.after(panel);
  anchor.setAttribute('aria-expanded', 'true');
  const input = panel.querySelector('input');
  input.oninput = () => {
    const q = input.value.trim().replace(/^:|:$/g, '');
    const found = q ? Markdown.matchEmoji(EMOJI.names, EMOJI.aliases, q, 40) : first;
    panel.querySelector('.grid').innerHTML = grid(found) || '<span class="sub">No emoji by that name.</span>';
  };
  panel.onclick = (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    closePicker();
    pick(b.dataset.emoji);
  };
  panel.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closePicker(); anchor.focus(); }
    if (e.key === 'Enter' && e.target === input) { e.preventDefault(); panel.querySelector('[data-emoji]')?.click(); }
  };
  // A phone's keyboard would cover the emoji: the search field takes the focus where it does not.
  if (matchMedia('(hover: hover)').matches) input.focus();
}
function closePicker() {
  const open = document.querySelector('.picker');
  if (!open) return;
  open.previousElementSibling?.setAttribute('aria-expanded', 'false');
  open.remove();
}

/** Shows what is written as it will be sent, or the text box again. */
function togglePreview(button) {
  const on = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(on));
  button.textContent = on ? 'Write' : 'Preview';
  $('preview').hidden = !on;
  $('text').closest('.fld').hidden = on;
  if (on) $('preview').innerHTML = bodyHtml($('text').value) || '<span class="sub">Nothing to preview yet.</span>';
  else $('text').focus();
}

/** Sends what is written at the composer's key, with the files uploaded for it. */
async function submitComposer(form) {
  const { key } = form.dataset;
  const text = $('text').value;
  const list = state.uploads.get(key) || [];
  const status = (s) => { $('sendStatus').textContent = s; };
  if (list.some((u) => u.status === 'error')) { status('A file did not upload: remove it, or attach it again.'); return; }
  if (list.some((u) => u.status === 'uploading')) return;
  if (!text.trim() && !list.length) { $('text').focus(); return; }
  $('send').disabled = true;
  status('');
  const res = await call('/api/post', 'POST', {
    channel: state.channel.id, thread: key === 'new' ? undefined : key, text, files: list.map((u) => u.id),
  });
  if (!res.ok) {
    $('send').disabled = false;
    status(res.body.error || `Could not send (${res.status}).`);
    return;
  }
  state.drafts.delete(key);
  for (const u of list) if (u.thumb) URL.revokeObjectURL(u.thumb);
  state.uploads.delete(key);
  if (key === 'new') {
    await Promise.all([loadThreads(), select(res.body.root)]);
    return;
  }
  // The same thread: the box is empty again, and what was sent is under the others.
  $('text').value = '';
  if (!$('preview').hidden) togglePreview(form.querySelector('[data-tool="preview"]'));
  renderTray(key);
  $('send').disabled = false;
  await refresh({ toEnd: true });
  $('text')?.focus();
}

// ---- the thread picked: its pane ----------------------------------------------------------------

const back = '<button type="button" class="back" id="back" aria-label="Back to the threads"><span class="s2-chevron" aria-hidden="true"></span></button>';

/** The thread's messages and its title, drawn again; what is being written stays as it is. */
function renderMessages({ toEnd = false } = {}) {
  const t = state.thread;
  const scroll = $('pane').querySelector('.scroll');
  if (!t || !scroll) return;
  const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  const at = scroll.scrollTop;
  closePicker();
  $('paneTitle').innerHTML = `<h2>${esc(emojify(t.title))}</h2>${t.resolved ? '<span class="tag resolved" title="Adobe marked this resolved. Write again if it is not.">resolved</span>' : ''}`;
  scroll.innerHTML = `<ol class="messages">${t.messages.map(messageHtml).join('')}</ol>`;
  scroll.scrollTop = toEnd || atEnd ? scroll.scrollHeight : at;
}

/** The pane of what is picked: nothing, a new thread being written, or a thread. */
function renderPane() {
  const pane = $('pane');
  state.suggest = null;
  if (!state.sel) {
    pane.dataset.for = '';
    pane.innerHTML = '<div class="empty pick">Pick a thread, or start a new one.</div>';
    return;
  }
  if (pane.dataset.for === state.sel) return;
  pane.dataset.for = state.sel;
  if (state.sel === 'new') {
    pane.innerHTML = `<div class="title">${back}<span class="fill"><h2>New thread in ${esc(state.channel.name)}</h2></span></div>
      <div class="scroll">${composer('new', 'What is it about? The first line is the thread\'s title.', 'Start thread')}</div>`;
    renderTray('new');
    $('text').focus();
    return;
  }
  pane.innerHTML = `<div class="title">${back}<span class="fill" id="paneTitle"></span></div>
    <div class="scroll"><div class="empty">Loading…</div></div>
    ${composer(state.sel, 'Reply', 'Send')}`;
  renderTray(state.sel);
  if (state.thread) renderMessages({ toEnd: true });
}

async function loadThread({ toEnd = false } = {}) {
  const id = state.sel;
  if (!id || id === 'new') return;
  const res = await call(`/api/thread?channel=${encodeURIComponent(state.channel.id)}&thread=${encodeURIComponent(id)}`);
  if (state.sel !== id) return;
  if (!res.ok) {
    state.thread = null;
    $('pane').dataset.for = '';
    $('pane').innerHTML = `<div class="empty">${esc(res.body.error || 'Could not load this thread.')}</div>`;
    return;
  }
  // Nothing is drawn again while nothing changed: a menu that is open, a video that plays, stay.
  const same = state.thread && JSON.stringify(state.thread) === JSON.stringify(res.body.thread);
  const first = !state.thread;
  state.thread = res.body.thread;
  if (!same) renderMessages({ toEnd: toEnd || first });
  if (first && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  const row = state.threads.find((t) => t.id === id);
  if (row && (row.unread || row.mentioned)) { row.unread = 0; row.mentioned = false; renderThreads(); }
}

/** The channel as it is now: its threads, and the one picked. */
const refresh = (options) => Promise.all([loadThreads(), loadThread(options)]);

async function select(id) {
  if (state.sel !== id) { state.thread = null; state.editing = null; }
  state.sel = id;
  toUrl();
  renderThreads();
  renderPane();
  await loadThread({ toEnd: true });
}

async function openChannel(channel, thread = null) {
  state.channel = channel;
  state.threads = [];
  state.thread = null;
  state.sel = thread;
  state.peopleAt = 0;
  document.body.classList.add('open');
  $('main').innerHTML = '<section id="threads" aria-label="Threads"></section><section id="pane" aria-label="Thread"></section>';
  Swap.watch($('pane'), () => state.sel);
  toUrl();
  renderThreads();
  renderPane();
  await refresh({ toEnd: true });
}

// ---- what the channel's page does when it is clicked, typed in or dropped on -----------------

/** A change to a message of the open thread, then the thread as it is after it. */
async function act(res) {
  if (!res.ok) { if ($('sendStatus')) $('sendStatus').textContent = res.body.error || `Failed (${res.status}).`; return; }
  await refresh();
}
const react = (id, emoji, remove = false) => call('/api/react', 'POST', {
  channel: state.channel.id, id, emoji, remove,
}).then(act);

$('main').addEventListener('click', async (e) => {
  const on = (sel) => e.target.closest?.(sel);
  if (!on('.picker, [data-pick], [data-tool="emoji"]')) closePicker();
  const row = on('[data-thread]');
  if (row) { select(row.dataset.thread); return; }
  if (on('#newThread')) { select('new'); return; }
  if (on('#back')) { select(null); return; }
  const zoom = on('[data-zoom]');
  if (zoom) { lightbox(zoom.dataset.zoom, zoom.dataset.name); return; }
  const chip = on('.chip[data-react]');
  if (chip) { react(chip.dataset.on, chip.dataset.react, chip.getAttribute('aria-pressed') === 'true'); return; }
  const more = on('[data-pick]');
  if (more) { emojiPicker(more, REACTIONS, (c) => react(more.dataset.pick, c)); return; }
  const edit = on('[data-edit]');
  if (edit) { state.editing = edit.dataset.edit; renderMessages(); $('pane').querySelector('form.edit textarea')?.focus(); return; }
  if (on('[data-cancel]')) { state.editing = null; renderMessages(); return; }
  const del = on('[data-delete]');
  if (del) {
    if (await confirmFirst('Delete this message and its files? Adobe sees that it was deleted.', 'Delete')) {
      act(await call('/api/delete', 'POST', { channel: state.channel.id, id: del.dataset.delete }));
    }
    return;
  }
  const picked = on('#suggest li');
  if (picked) { takeSuggestion(Number(picked.dataset.i)); return; }
  const drop = on('[data-drop]');
  if (drop) {
    const { key } = $('composer').dataset;
    const list = state.uploads.get(key) || [];
    const gone = list.find((u) => String(u.n) === drop.dataset.drop);
    if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
    state.uploads.set(key, list.filter((u) => u !== gone));
    renderTray(key);
    return;
  }
  const format = on('[data-format]');
  if (format && $('text')) {
    const box = $('text');
    Writing.applyText(box, Writing.formatText(box.value, box.selectionStart, box.selectionEnd, format.dataset.format));
    return;
  }
  const tool = on('[data-tool]');
  if (!tool) return;
  if (tool.dataset.tool === 'attach') $('files').click();
  if (tool.dataset.tool === 'preview') togglePreview(tool);
  if (tool.dataset.tool === 'mention') { $('text').focus(); insertAtCaret($('text'), '@'); }
  if (tool.dataset.tool === 'emoji') emojiPicker(tool, COMMON, (c) => { $('text').focus(); insertAtCaret($('text'), c); });
});
// A suggestion is taken before the text box loses the focus to it.
$('main').addEventListener('mousedown', (e) => {
  if (e.target.closest?.('#suggest, .tools') && !e.target.closest('.picker input')) e.preventDefault();
});

$('main').addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'composer') { e.preventDefault(); submitComposer(form); }
  if (form.matches('form.edit')) {
    e.preventDefault();
    const res = await call('/api/edit', 'POST', {
      channel: state.channel.id, id: form.dataset.save, text: form.querySelector('textarea').value,
    });
    if (res.ok) state.editing = null;
    act(res);
  }
});

$('main').addEventListener('input', (e) => {
  if (e.target.id !== 'text') return;
  state.drafts.set($('composer').dataset.key, e.target.value);
  updateSuggest();
});
$('main').addEventListener('change', (e) => {
  if (e.target.id !== 'files') return;
  addFiles($('composer').dataset.key, [...e.target.files]);
  e.target.value = '';
});
// The suggestions follow the caret, and close when the text box is left.
document.addEventListener('selectionchange', () => { if (document.activeElement?.id === 'text' && state.suggest) updateSuggest(); });
$('main').addEventListener('focusout', (e) => { if (e.target.id === 'text') { state.suggest = null; renderSuggest(); } });

$('main').addEventListener('keydown', (e) => {
  const box = e.target;
  if (box.tagName !== 'TEXTAREA' || e.isComposing || !box.closest('#pane')) return;
  const s = box.id === 'text' ? state.suggest : null;
  if (s) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      s.at = (s.at + (e.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length;
      renderSuggest();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); takeSuggestion(s.at); return; }
    if (e.key === 'Escape') { e.preventDefault(); state.suggest = null; renderSuggest(); return; }
  }
  // Enter with Ctrl or ⌘ sends; Enter alone is a new line, as in any text.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); box.closest('form').requestSubmit(); return; }
  const kind = Writing.formatKind(e);
  if (!kind) return;
  e.preventDefault();
  Writing.applyText(box, Writing.formatText(box.value, box.selectionStart, box.selectionEnd, kind));
});

// Files pasted into the text box, or dropped on the thread, are attached; a link pasted over
// words makes them its label.
$('main').addEventListener('paste', (e) => {
  if (e.target.tagName !== 'TEXTAREA' || !e.target.closest('#pane')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && e.target.id === 'text') {
    e.preventDefault();
    addFiles($('composer').dataset.key, files);
    return;
  }
  Writing.pasteLink(e);
});
const dragged = (e) => $('composer') && [...(e.dataTransfer?.types || [])].includes('Files');
$('main').addEventListener('dragover', (e) => {
  if (!dragged(e)) return;
  e.preventDefault();
  $('pane').classList.add('dropping');
});
$('main').addEventListener('dragleave', (e) => { if (!$('pane')?.contains(e.relatedTarget)) $('pane')?.classList.remove('dropping'); });
$('main').addEventListener('drop', (e) => {
  if (!dragged(e)) return;
  e.preventDefault();
  $('pane').classList.remove('dropping');
  addFiles($('composer').dataset.key, [...e.dataTransfer.files]);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

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
  await refresh();
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
window.addEventListener('opspile:signedin', () => (state.data ? poll() : start()));

start();
