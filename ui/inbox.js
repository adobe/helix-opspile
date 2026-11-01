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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = {
  me: null, team: null, data: null, open: null, compose: null, awaiting: null, sockets: [], live: 0, review: null, answers: null,
  sel: { type: new Set(['conversation']) },
  // Facet values excluded, as klickhaus's negative filters: by facet id, like `sel`.
  not: {},
  order: [], prevKeys: null, shownIds: null, sending: [], sort: 'team', unread: false, scores: new Map(),
  // The thread list on screen, while it stays the same list (see syncList).
  list: newList(),
  cache: new Map(), staged: {}, profiles: new Map(), experts: new Map(), expertsAt: new Map(), expertsOpen: null, expertLists: new Map(), expertsSeen: null, composers: new Map(), attachments: new Map(), filtering: false,
  // The thread agents' latest turns, by inbox entry: { turn, latest, timer }.
  agents: new Map(),
  // Search (GET /api/search): the query, its words, the answer, and which request is current.
  search: { q: '', words: [], data: null, loading: false, error: null, seq: 0 },
  // The message a search hit opens the thread at: { key, id }.
  jump: null,
  // The message being edited in place: { id: '<thread>|<message id>', key, text, as }.
  editing: null,
  // Edits saved and not back from the platform yet, by message: { body, sentAt, saving }.
  edits: new Map(),
};

// The thread list's design explorations (`?design=a|b|c`) are over: A is the list. A choice one
// of them left in this browser is let go.
try { localStorage.removeItem('opspile.design'); } catch { /* storage is off */ }

// ---------------------------------------------------------------- helpers
async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin', headers: state.as ? { 'x-opspile-as': String(state.as) } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}
// Dates and times: one formatter each, made once (toLocale*String builds one per call, and a
// long thread asks for hundreds), and each day's label once.
const formatter = (opts) => {
  let f = null; // made when first used: making one takes a while
  return (d) => {
    if (Number.isNaN(d.getTime())) return 'Invalid Date';
    f = f || new Intl.DateTimeFormat(undefined, opts);
    return f.format(d);
  };
};
const SHORT_DATE = formatter({ day: 'numeric', month: 'short' });
const CLOCK = formatter({ hour: 'numeric', minute: '2-digit' });
const LONG_DAY = formatter({ weekday: 'long', month: 'long', day: 'numeric' });
const days = new Map();
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return SHORT_DATE(new Date(iso));
}
const clock = (iso) => CLOCK(new Date(iso));
function dayLabel(iso) {
  const d = new Date(iso);
  const day = d.toDateString();
  if (day === new Date().toDateString()) return 'Today';
  if (day === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  if (!days.has(day)) days.set(day, LONG_DAY(d));
  return days.get(day);
}
const PLATFORM = { slack: 'Slack', teams: 'Teams', discord: 'Discord' };
const platform = (t) => PLATFORM[t.source] || 'Teams';
// The account a person connects for a platform.
const accountOf = (p) => (p === 'teams' ? 'Microsoft' : PLATFORM[p] || p);
const lastOf = (t) => (t.kind === 'alert' ? t.any_at : t.last_at);
// When the list places a thread and says it was active: its last post by a person, else (only
// bots or apps posted) its last message at all, as the inbox API orders it. Never null: a
// thread without a time would sort above every date ("null" > "2026-…").
const activityOf = (t) => String(lastOf(t) || t.any_at || '');
const favicon = (domain) => (/^https:\/\//.test(domain) ? domain
  : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`);
// An org as the admin team set it up (/inbox/admin): its name and icon, else the slug and
// the favicon of the customer's usual mail domain. `favicon()` takes either.
const orgName = (t) => t.org_name || t.org;
const orgIcon = (t) => t.org_icon || t.customerDomain || null;
const ORG_TYPE = { partner: 'Partner', vendor: 'Vendor', internal: 'Internal' };
const backlink = (t, label) => (t.permalink
  ? `<a class="back" href="${esc(t.permalink)}" target="_blank" rel="noopener" title="Open in ${platform(t)}">${esc(label || `↗ ${platform(t)}`)}</a>` : '');

const COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f', '#a16207', '#0e7490'];
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').split(/[\s,]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
// Initials underneath, the picture on top: while a picture loads (or when Gravatar has
// none and answers 404), the initials show instead of a blank.
// With a profile key the avatar opens the person's card (`tab`: also by keyboard) instead of
// a plain title tooltip.
function avatar(name, url, cls = '', { key = null, tab = false } = {}) {
  const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  const who = key
    ? ` data-p="${esc(key)}" role="button" aria-label="${esc(name)}"${tab ? ' tabindex="0"' : ''}`
    : ` title="${esc(name)}"`;
  return `<span class="av ${cls}" style="background:${hue(name)}"${who}>${esc(initials(name))}${img}</span>`;
}

// ---------------------------------------------------------------- profile cards
// Cards come with the inbox and thread payloads (`profiles`, keyed by platform account), so
// hovering costs no request. People without one (no account in D1) get a card from what the
// message says about them.
function mergeProfiles(cards) {
  for (const [k, v] of Object.entries(cards || {})) state.profiles.set(k, v);
}
function profileKey(key, { name, staff, kind, domain, avatar: url, platform: source } = {}) {
  const k = key || `local:${kind || 'person'}:${staff ? 1 : 0}:${domain || ''}:${name}`;
  if (!state.profiles.has(k)) {
    state.profiles.set(k, {
      name, avatar: url || null, platform: source || null, kind: kind || 'person', domain: domain || null,
      relation: kind === 'bot' ? 'bot' : (staff ? 'adobe' : 'customer'), teams: [], local: true,
    });
  }
  return k;
}
const RELATION_LABEL = { adobe: 'Adobe', partner: 'Partner', customer: 'Customer', bot: 'Bot' };
const RELATION_HINT = {
  adobe: 'Adobe staff',
  partner: 'Works for a partner of Adobe (their mail domain is a known partner domain)',
  customer: 'Not Adobe staff and not from a known partner domain',
  bot: 'An app or integration posting automatically',
};

/** The thread a name or avatar belongs to: its row in the list, or the open thread. */
function cardContext(el) {
  const key = el.closest('.t')?.dataset.thread || state.open;
  const t = state.data?.threads.find((x) => x.thread === key) || {};
  const th = state.cache.get(key)?.data?.thread || {};
  return {
    org: orgName(t.org ? t : th), icon: orgIcon(t.org ? t : th), customerDomain: t.customerDomain || null, channel: t.channel_name || th.channel_name,
  };
}

function cardHtml(p, ctx) {
  const role = [p.title, p.company].filter(Boolean).join(' · ');
  const rel = p.relation || 'customer';
  const label = rel === 'partner' && p.partner ? `Partner · ${p.partner}` : RELATION_LABEL[rel];
  const where = PLATFORM[p.platform] ? `${PLATFORM[p.platform]} account` : '';
  const rows = [];
  const ico = (d) => (d ? `<img src="${esc(favicon(d))}" alt="" loading="lazy" onerror="this.remove()">` : '');
  if (p.domain) rows.push(['Mail', `${ico(p.domain)}${esc(p.domain)}`]);
  if (p.teams?.length) rows.push(['Ops teams', esc(p.teams.join(', '))]);
  if (ctx.org) {
    rows.push(['Channel', `${ico(ctx.icon)}${esc(ctx.org)}${ctx.channel ? ` <span style="color:var(--faint)">· ${esc(ctx.channel)}</span>` : ''}`]);
  }
  // A customer from another domain than the channel's customer may be a partner nobody listed.
  const other = rel === 'customer' && p.domain && ctx.customerDomain && p.domain !== ctx.customerDomain;
  return `<div class="top">${avatar(p.name || '?', p.avatar)}<div>
      <div class="nm">${esc(p.name || 'unknown')}</div>${role ? `<div class="ttl">${esc(role)}</div>` : ''}</div></div>
    <div class="chips"><span class="rel ${esc(rel)}" title="${esc(RELATION_HINT[rel] || '')}">${esc(label)}</span>
      ${where ? `<span class="tag">${where}</span>` : ''}</div>
    ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${other ? `<div class="note">Not the usual customer domain in this channel (${esc(ctx.customerDomain)}).</div>` : ''}
    ${p.local ? '<div class="note">No account details known yet.</div>' : ''}`;
}

const card = { el: null, target: null, showTimer: 0, hideTimer: 0, pointer: 'mouse' };
function cardEl() {
  if (card.el) return card.el;
  const el = document.createElement('div');
  el.id = 'pcard';
  el.className = 'pcard';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  el.addEventListener('pointerenter', () => clearTimeout(card.hideTimer));
  el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hideCardSoon(); });
  document.body.append(el);
  card.el = el;
  return el;
}
function showCard(target) {
  clearTimeout(card.showTimer);
  clearTimeout(card.hideTimer);
  const p = state.profiles.get(target.dataset.p);
  if (!p || !target.isConnected) return;
  const el = cardEl();
  if (card.target && card.target !== target) card.target.removeAttribute('aria-describedby');
  el.innerHTML = cardHtml(p, cardContext(target));
  el.hidden = false;
  card.target = target;
  target.setAttribute('aria-describedby', 'pcard');
  // Below the name or avatar, or above it when there is no room; always on screen.
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
}
function hideCard() {
  clearTimeout(card.showTimer);
  clearTimeout(card.hideTimer);
  if (card.el) card.el.hidden = true;
  card.target?.removeAttribute('aria-describedby');
  card.target = null;
}
function hideCardSoon() {
  clearTimeout(card.hideTimer);
  card.hideTimer = setTimeout(hideCard, 160);
}
/** After a re-render: a card whose name or avatar is gone goes too. */
function cardGone() { if (card.target && !card.target.isConnected) hideCard(); }

function wireCards() {
  const hovering = (e) => e.pointerType === 'mouse' || e.pointerType === 'pen';
  document.addEventListener('pointerdown', (e) => { card.pointer = e.pointerType; }, true);
  document.addEventListener('pointerover', (e) => {
    if (!hovering(e)) return;
    const t = e.target.closest('[data-p]');
    if (t) {
      clearTimeout(card.hideTimer);
      if (card.target === t) return;
      clearTimeout(card.showTimer);
      // Quick when moving from one person to the next, a pause before the first.
      card.showTimer = setTimeout(() => showCard(t), card.target ? 60 : 350);
    }
  });
  document.addEventListener('pointerout', (e) => {
    if (!hovering(e)) return;
    const t = e.target.closest('[data-p]');
    if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
    clearTimeout(card.showTimer);
    if (card.target) hideCardSoon();
  });
  // A tap shows the card (and does not open the thread underneath); a tap elsewhere hides it.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-p]');
    if (t && card.pointer === 'touch') {
      e.preventDefault();
      e.stopPropagation();
      if (card.target === t) hideCard(); else showCard(t);
      return;
    }
    if (card.target && !e.target.closest('#pcard') && t !== card.target) hideCard();
  }, true);
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-p]');
    if (t && t.matches(':focus-visible')) showCard(t);
  });
  document.addEventListener('focusout', (e) => {
    if (card.target && e.target === card.target && !card.el.contains(e.relatedTarget)) hideCard();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && card.target) { hideCard(); return; }
    const t = e.target.closest?.('[data-p]');
    if (t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (card.target === t) hideCard(); else showCard(t);
    }
  });
  // Native scrolling moves the name away from a fixed card: let the card go.
  document.addEventListener('scroll', (e) => { if (card.target && !card.el.contains(e.target)) hideCard(); }, true);
  window.addEventListener('resize', hideCard);
}

// Emoji names to characters: Slack's standard names, filled in from src/emoji.js where the page
// is served (src/page.js), then Teams reaction types and names workspaces give their own
// emoji. Other platforms' names and spellings of them (`facepalm`, `thumbs-up`) are found too
// (src/emojinames.js). A workspace's own emoji are images (see `ownEmoji`); anything else is
// shown by name.
const SLACK_EMOJI = /* SLACK_EMOJI */ { names: {}, skin: [] };
const EMOJI = Object.assign(Object.create(null), {
  like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😠', facepalm: '🤦', rofl: '🤣',
  ack: '✅', done: '✅', yes: '✅', no: '❌', thank_you: '🙏', thanks: '🙏',
  // Used by the reaction bar; also in Slack's table, here so dev and tests show them too.
  white_check_mark: '✅', heavy_check_mark: '✔️', eyes: '👀', pray: '🙏', '+1': '👍', thumbsup: '👍',
  grinning: '😀', rocket: '🚀', ring_buoy: '🛟', joy: '😂', open_mouth: '😮', tada: '🎉',
}, SLACK_EMOJI.names);
const SKIN_TONES = new Set(SLACK_EMOJI.skin);
const emojiCanonical = Markdown.emojiLookup(EMOJI, SLACK_EMOJI.aliases || {}, SKIN_TONES);
// `wave::skin-tone-3`: the tone modifier goes after the first code point, in place of a VS16.
function emojiByName(name) {
  const [base, tone] = String(emojiCanonical(name) || '').split('::skin-tone-');
  const c = EMOJI[base];
  if (!c || !tone) return c;
  const [first, ...rest] = [...c];
  if (rest[0] === '\uFE0F') rest.shift();
  return [first, String.fromCodePoint(0x1f3fb + Number(tone) - 2), ...rest].join('');
}
// A name, without the colons a Discord custom reaction is stored with.
const emojiBare = (name) => String(name).replace(/^:|:$/g, '');
const emoji = (name) => {
  const bare = emojiBare(name);
  return emojiByName(bare) || (/^\p{Extended_Pictographic}/u.test(bare) ? bare : `:${bare}:`);
};
// `:name:` in text, with an optional `::skin-tone-N`.
const EMOJI_CODE = /:([a-z0-9_+-]+(?:::skin-tone-[2-6])?):/g;
// Slack's custom emoji (GET /api/emoji/custom, src/shortcodes.js): `images` by name, `aliases`
// of a standard emoji, `complete` once Slack said. `closest`: names with neither, the emoji
// Clef picks (GET /api/emoji/closest). `names` and `alike`: the composer's tables, with them.
// `version` changes with any of this, so what shows them is rendered again.
const ownEmoji = {
  images: new Map(),
  aliases: new Map(),
  complete: false,
  closest: new Map(),
  names: SLACK_EMOJI.names,
  alike: SLACK_EMOJI.aliases || {},
  version: 0,
};
// Names asked about in a page's life, and how many a request takes (MAX_ASK, src/shortcodes.js).
const CLOSEST_MAX = 40;
const CLOSEST_BATCH = 3;
const closestAsked = new Set();
const closestWaiting = [];
let closestBusy = false;

/** Shows the workspace's emoji where they are named: the thread list and the open thread. */
function showOwnEmoji() {
  ownEmoji.version += 1;
  render();
  if (state.open) openThread(state.open, { live: true, cached: true });
}

async function askClosest() {
  if (closestBusy) return;
  closestBusy = true;
  while (closestWaiting.length) {
    const names = closestWaiting.splice(0, CLOSEST_BATCH);
    try {
      // eslint-disable-next-line no-await-in-loop
      const found = Object.entries((await get(`/api/emoji/closest?names=${encodeURIComponent(names.join(','))}`)).emoji || {});
      for (const [name, near] of found) ownEmoji.closest.set(name, near);
      if (found.length) showOwnEmoji();
    } catch { /* they stay names */ }
  }
  closestBusy = false;
}

/** A name with neither a character nor an image: Clef may know a close one. */
function wantClosest(name) {
  if (!ownEmoji.complete || name.length < 2 || !/[a-z]/.test(name)) return;
  if (closestAsked.has(name) || closestAsked.size >= CLOSEST_MAX) return;
  closestAsked.add(name);
  closestWaiting.push(name);
  setTimeout(askClosest, 300);
}

async function loadOwnEmoji() {
  try {
    const { images = {}, aliases = {}, complete } = await get('/api/emoji/custom');
    Object.assign(ownEmoji, {
      images: new Map(Object.entries(images)),
      aliases: new Map(Object.entries(aliases)),
      complete: Boolean(complete),
      names: { ...SLACK_EMOJI.names, ...images },
      alike: { ...SLACK_EMOJI.aliases, ...aliases },
    });
    showOwnEmoji();
  } catch { /* they stay names */ }
}

/**
 * An emoji name as HTML: its image, its character, or the emoji Clef finds closest, marked as
 * such; undefined for a name there is none of, which only asks Clef if it is `alone`, not part
 * of a word or address (`Markdown.emojiAlone`). `slack: false` for a reaction of another
 * platform: Teams stores `like`, which a Slack workspace may have an emoji of its own for.
 */
function emojiHtml(name, { slack = true, alone = true } = {}) {
  const bare = emojiBare(name);
  const [base] = bare.split('::skin-tone-');
  const src = slack && ownEmoji.images.get(base);
  if (src) return `<img class="emoji" src="${esc(src)}" alt=":${esc(base)}:" title=":${esc(base)}:" loading="lazy">`;
  const c = emojiByName((slack && ownEmoji.aliases.get(base)) || bare);
  if (c) return esc(c);
  if (/^\p{Extended_Pictographic}/u.test(bare)) return esc(bare);
  const near = ownEmoji.closest.get(base);
  if (near) return `<span class="emoji-near" title=":${esc(base)}: has no image here. Closest emoji, picked by Clef">${esc(emojiByName(near))}</span>`;
  if (alone) wantClosest(base);
  return undefined;
}
/** A reaction, or a suggestion, as HTML: as `emojiHtml`, or its name. */
const emojiChip = (name, source = 'slack') => emojiHtml(name, { slack: source === 'slack' }) || esc(emoji(name));
// Reactions by Slack name (the server turns them into Teams emoji). The quick ones show on
// hovering a message, like in Slack; some of them steer the inbox (see SIGNAL_HINT).
const QUICK = ['white_check_mark', 'eyes', 'pray', '+1', 'grinning', 'rocket', 'ring_buoy'];
const PICKER = [...QUICK, 'heavy_check_mark', 'heart', 'joy', 'open_mouth', 'tada'];
const SIGNAL_HINT = {
  white_check_mark: 'resolved (also goes on the first message)',
  heavy_check_mark: 'resolved (also goes on the first message)',
  eyes: 'seen: you are on it (lower for the rest of the team, higher for you)',
  pray: 'thanks: nothing is pending any more',
  ring_buoy: 'help: the rest of the team should look',
};

// Markdown: micromark, with chat's line breaks, mentions and emoji (src/ui-markdown.js, put
// into the page as `Markdown`). Images from Slack and Teams go through the inbox's media
// proxy, which adds the platform's credentials.
// Full names of people the open thread may mention, so "@Ada Lovelace" shows as one mention,
// and who they are (Adobe, partner, customer, bot), so mentions of people outside Adobe stand
// out. Teams mentions some people as "@Last, First": that form is known too.
let mentionNames = null;
let mentionKinds = new Map();
const mentionKindOf = (name) => mentionKinds.get(String(name).toLowerCase());
// Each distinct set of names gets a short id, for the cache of rendered messages below.
let mentionSet = '';
const mentionSets = new Map();
function setMentionNames(names, kinds = new Map()) {
  mentionNames = Markdown.mentionPattern(names);
  mentionKinds = new Map();
  for (const [name, kind] of kinds) {
    const parts = String(name).trim().split(/\s+/);
    const forms = parts.length < 2 ? [name] : [name, `${parts[parts.length - 1]}, ${parts[0]}`];
    for (const f of forms) {
      const k = f.toLowerCase();
      // A name that stands for people of different kinds says nothing.
      mentionKinds.set(k, mentionKinds.has(k) && mentionKinds.get(k) !== kind ? undefined : kind);
    }
  }
  const source = `${mentionNames ? mentionNames.source : ''}\u0000${[...mentionKinds].join(';')}`;
  if (!mentionSets.has(source)) mentionSets.set(source, String(mentionSets.size));
  mentionSet = mentionSets.get(source);
}
// Channels the open thread's messages name (`#name`, or the `#C…` id Slack sent without the
// name; src/channelrefs.js): links to where their threads are, in the view on screen if it
// has them, with the channel's customer picked, else to the channel on its platform.
let channelRefs = new Map();
let channelSet = '';
const channelSets = new Map();
function channelLink(c) {
  const customer = c.org ? `&f.customer=${encodeURIComponent(c.org)}` : '';
  const name = c.name ? `#${c.name}` : 'The channel';
  const inPersonal = c.personal && (personal() || !c.teams.length);
  const team = !inPersonal && (c.teams.includes(state.team) ? state.team : c.teams[0]);
  const where = c.org ? `${customerName(c.org)} in ` : '';
  if (inPersonal) return { name: c.name, href: `/inbox?view=personal&filters=1${customer}`, inbox: true, title: `${name}: ${where}Personal` };
  if (team) return { name: c.name, href: `/inbox?team=${encodeURIComponent(team)}&filters=1${customer}`, inbox: true, title: `${name}: ${where}${viewName(team)}` };
  return c.url ? { name: c.name, href: c.url, title: `${name} is not in your inbox: open it in ${platform(c)}` } : undefined;
}
function setChannelRefs(list) {
  channelRefs = new Map();
  for (const c of list || []) {
    const link = channelLink(c);
    if (!link) continue;
    channelRefs.set(c.id, link);
    if (c.name && !channelRefs.has(c.name.toLowerCase())) channelRefs.set(c.name.toLowerCase(), link);
  }
  const source = JSON.stringify([...channelRefs]);
  if (!channelSets.has(source)) channelSets.set(source, String(channelSets.size));
  channelSet = channelSets.get(source);
}
const channelOf = (token) => channelRefs.get(token) || channelRefs.get(token.toLowerCase());
/** A title with the channel ids in it (`#C…`) as the channels' names. */
const channelNames = (s) => String(s || '').replace(Markdown.CHANNEL_REF, (m, before, token) => {
  const c = channelRefs.get(token);
  return c && c.name ? `${before}#${c.name}` : m;
});
/** A channel link in a message (`a[data-inbox]`): the inbox, with its filters, in this tab. */
function openInbox(href) {
  // The thread closes first: loading the other view must not write it into the new address.
  state.open = null;
  history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}
// Slack, Teams and Discord images come through the Worker, with the app's credentials; a Teams
// image with its thread, so the Worker serves its copy from pile 1 (SharePoint files only so).
const MEDIA = /^https:\/\/(files\.slack\.com\/|graph\.microsoft\.com\/|[a-z0-9-]+\.sharepoint\.com\/|(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/)/i;
const proxied = (u, thread) => (MEDIA.test(u) ? `/api/media?u=${encodeURIComponent(u)}${thread && /^teams:/.test(thread) ? `&t=${encodeURIComponent(thread)}` : ''}` : u);
// Rendered once per text and set of known names: opening a thread again, or a live update,
// renders only the messages that are new or changed.
const rendered = new Map();
const RENDERED_MAX = 4000;
// `thread`: the message's own, for its images.
function md(src, thread = '') {
  const k = `${ownEmoji.version}\u0000${mentionSet}\u0000${channelSet}\u0000${thread}\u0000${src}`;
  let html = rendered.get(k);
  if (html === undefined) {
    const proxy = (u) => proxied(u, thread);
    // A message's video and audio files play in the page, through the Worker (src/fileview.js).
    const fileUrl = (u, what) => (thread ? `/api/file/${what}?t=${encodeURIComponent(thread)}&u=${encodeURIComponent(u)}` : undefined);
    html = Markdown.render(src, {
      mentions: mentionNames, emoji: (name, alone) => emojiHtml(name, { alone }), proxy, kindOf: mentionKindOf, channel: channelOf, fileUrl,
    });
    if (rendered.size >= RENDERED_MAX) rendered.delete(rendered.keys().next().value);
  } else {
    rendered.delete(k);
  }
  rendered.set(k, html);
  return html;
}

// ---------------------------------------------------------------- facets
// Status: red = nobody at Adobe has seen it, or you were mentioned; yellow = a teammate was
// mentioned, or nobody on the team has seen it; green = only you have not; none = caught up.
const URGENCY = ['low', 'normal', 'high', 'critical'];
// None and low are one bucket.
const urgencyOf = (t) => (t.label && t.label.urgency != null ? URGENCY[Math.min(3, Math.round(t.label.urgency))] : 'low');
const KIND_EMOJI = {
  incident: '🔥', security: '🔒', question: '❓', request: '🙋', access: '🔑', people: '👋', meeting: '📅', alert: '🚨', other: '💬',
};
const URGENCY_ICON = { critical: '🆘', high: '⚡', normal: '🔹', low: '▫️' };
// Every filter row has an icon, so the folded filter column (the rail) still tells them apart.
const STATUS_ICON = {
  critical: '‼️', hot: '❗', you: '🫵', waiting: '⏰', silent: '🔇', team: '🤝', quiet: '🍃',
};
const RESOLVED_ICON = { open: '⭕', resolved: '✅', '(none)': '◌' };
const DRAFT_ICON = { mine: '✍️', team: '📝', none: '📭' };
const WAITING_ICON = { Us: '🛎️', Customer: '⏳', Nobody: '💤' };
const TYPE_ICON = { conversation: '💬', alert: '🚨' };
const PLATFORM_SITE = { Slack: 'slack.com', Teams: 'teams.microsoft.com', Discord: 'discord.com' };
const kindOf = (t) => (t.kind === 'alert' ? 'alert' : (t.label?.label_kind && t.label.label_kind !== 'other' ? t.label.label_kind : 'other'));
// A staff ✅ on the root decides (until a customer writes again), else Clef does.
const resolvedOf = (t) => t.resolution?.verdict
  || (t.label?.resolved_p == null ? null : (t.label.resolved_p >= 0.5 ? 'resolved' : 'open'));
const checked = (t) => t.resolution?.verdict === 'resolved';
const resolvedP = (t) => (t.resolution?.verdict ? Number(checked(t)) : (t.label?.resolved_p ?? 0));
const viewerId = () => state.data?.me?.id ?? state.me.id;
const teamIds = () => {
  if (pass?.team) return pass.team;
  const ids = new Set(Object.values(state.data?.teams || {}).flatMap((x) => x.members));
  if (pass) pass.team = ids;
  return ids;
};
// A render pass (the filter cards and the list together): each thread's status and facet
// values are worked out once in it, not once per facet card and again per row. Nothing
// changes a thread during a pass; the next pass starts afresh.
let pass = null;
function inPass(fn) {
  if (pass) return fn();
  pass = { status: new WeakMap(), values: new Map(), team: null };
  try { return fn(); } finally { pass = null; }
}
/**
 * Us, Customer (customer or vendor), Nobody. The API works it out (`waitingOn` in
 * src/threads.js): Clef's label, except that a thread where Adobe posted last never waits on
 * us, and without a label, a thread waits on us when the customer posted last.
 */
const waitingOn = (t) => {
  const n = t.waiting_on;
  if (n === 'us') return 'Us';
  if (n === 'customer' || n === 'vendor') return 'Customer';
  return 'Nobody';
};

// How long a thread may wait before it turns yellow, by urgency.
const MIN = 60000;
const WAIT_US = { critical: 15 * MIN, high: 60 * MIN, normal: 180 * MIN, low: 180 * MIN };
const WAIT_THEM = { critical: 30 * MIN, high: 60 * MIN, normal: 1440 * MIN, low: 1440 * MIN };

/**
 * The status pile a thread is in, most pressing first:
 * - critical: critical urgency and nobody at Adobe has seen it (dark red)
 * - hot: high urgency and nobody at Adobe has seen it (red)
 * - you: you are in it (posted or mentioned), and the last word is not Adobe's, or it
 *   mentions you (blue)
 * - waiting: waits on us longer than its urgency allows (yellow); never when Adobe posted last
 * - silent: waits on the customer or vendor longer than its urgency allows (purple)
 * - team: your team is in it, you were not mentioned, all is well (green)
 * - quiet: everything else (grey)
 */
/**
 * What the steering reactions say, for the viewer: `mine` 👀 by the viewer (on it),
 * `others` 👀 by someone else at Adobe since the customer last wrote (someone is on it),
 * `help` 🛟 by someone else at Adobe (they ask the team to look).
 */
function signals(t) {
  const me = viewerId();
  const list = (t.signals || []).filter((x) => x.staff);
  const since = (x) => t.last_staff === 1 || !t.last_at || (x.at && x.at >= t.last_at);
  return {
    mine: list.some((x) => x.signal === 'seen' && x.person === me),
    others: list.some((x) => x.signal === 'seen' && x.person !== me && since(x)),
    help: list.some((x) => x.signal === 'help' && x.person !== me),
  };
}

function statusOf(t) {
  if (!pass) return computeStatus(t);
  if (!pass.status.has(t)) pass.status.set(t, computeStatus(t));
  return pass.status.get(t);
}
function computeStatus(t) {
  const me = viewerId();
  const u = urgencyOf(t);
  const alert = t.kind === 'alert';
  const sig = signals(t);
  if (!alert && t.unseenByAdobe && u === 'critical') return 'critical';
  if (!alert && t.unseenByAdobe && u === 'high') return 'hot';
  // 🛟: a colleague asks for eyes on it.
  if (!alert && sig.help && !checked(t)) return 'you';
  // 👀 by a colleague: they are on it, so it is theirs, unless it mentions you.
  if (!alert && sig.others && !sig.mine && !t.mentionedMe) return 'team';
  const mine = (t.posters || []).includes(me) || (t.mentioned || []).some((m) => m.person === me)
    || sig.mine;
  // Resolved with ✅ by staff: nobody is waiting, whoever spoke last.
  if (!alert && mine && !checked(t) && (t.last_staff === 0 || t.mentionedMe)) return 'you';
  const age = Date.now() - (Date.parse(lastOf(t)) || Date.now());
  const on = waitingOn(t);
  if (!alert && !checked(t) && on === 'Us' && age > WAIT_US[u]) return 'waiting';
  if (!alert && !checked(t) && on === 'Customer' && age > WAIT_THEM[u]) return 'silent';
  const team = teamIds();
  if ((t.posters || []).some((p) => team.has(p)) && !t.mentionedMe) return 'team';
  return 'quiet';
}
const STATUS_ORDER = ['critical', 'hot', 'you', 'waiting', 'silent', 'team', 'quiet'];
const STATUS_LABEL = {
  critical: 'Critical, unseen', hot: 'Hot, unseen', you: 'You', waiting: 'Waiting too long', silent: 'Customer silent', team: 'Team on it', quiet: 'Everything else',
};
const STATUS_HINT = {
  critical: 'Critical urgency and nobody at Adobe has seen it',
  hot: 'High urgency and nobody at Adobe has seen it',
  you: 'You posted, were mentioned or put 👀 on it, and the customer spoke last or you were mentioned (not once resolved with ✅); or a colleague asked for help with 🛟',
  waiting: 'Waiting on us for too long (15 min critical, 1 h high, 3 h normal), and Adobe did not post last',
  silent: 'Waiting on the customer or vendor for too long (30 min critical, 1 h high, 1 day normal): follow up or close',
  team: 'Your team is in it (or a colleague put 👀 on it), you were not mentioned, all is well',
  quiet: 'Everything else',
};

/** Who a thread involves, from the viewer's point of view. */
function involvement(t) {
  const me = viewerId();
  const out = [];
  const people = [...(t.posters || []), ...(t.mentioned || []).map((m) => m.person)];
  if (people.includes(me)) out.push('me');
  for (const [slug, team] of Object.entries(state.data?.teams || {})) {
    if (people.some((p) => team.members.includes(p))) out.push(`team:${slug}`);
  }
  for (const p of state.coPeople || []) if (people.includes(p)) out.push(`person:${p}`);
  return out.length ? out : null;
}
/** The ten people the viewer shares the most threads with. */
function coParticipants() {
  const me = viewerId();
  const n = new Map();
  for (const t of state.data?.threads || []) {
    const people = new Set([...(t.posters || []), ...(t.mentioned || []).map((m) => m.person)]);
    if (!people.has(me)) continue;
    for (const p of people) if (p !== me) n.set(p, (n.get(p) || 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p]) => p);
}
const involvesLabel = (v) => {
  if (v === 'me') return 'Me';
  if (v.startsWith('team:')) return state.data?.teams?.[v.slice(5)]?.name || v.slice(5);
  if (v.startsWith('person:')) return state.data?.people?.[v.slice(7)]?.name || v;
  return v;
};

// A thread carries at most one draft, shared with the team: saved last by you, or by a colleague.
const draftState = (t) => (t.draft ? (t.draft.by?.id === viewerId() ? 'mine' : 'team') : 'none');
const DRAFT_LABEL = { mine: 'By you', team: 'By a colleague', none: 'No draft' };
const DRAFT_HINT = {
  mine: 'A reply waits as a draft, and you saved it last',
  team: 'A reply waits as a draft, saved last by someone else on the team',
  none: 'No draft',
};
const draftBy = (d) => (d.by?.id === viewerId() ? 'you' : (d.by?.name || 'a colleague'));

// Who someone in a thread is, to the viewer: on one of their teams, elsewhere at Adobe, or a
// partner (by mail domain), else as the orgs they post in say (vendor, partner, customer).
const PERSON_KINDS = ['member', 'customer', 'partner', 'vendor', 'adobe'];
function personKind(id) {
  const same = (x) => String(x) === String(id);
  if (Object.values(state.data?.teams || {}).some((x) => x.members.some(same))) return 'member';
  const p = state.data?.people?.[id];
  if (p?.staff || p?.relation === 'adobe') return 'adobe';
  if (p?.relation === 'partner') return 'partner';
  const n = {};
  for (const t of state.data?.threads || []) {
    if ((t.posters || []).some(same)) n[t.org_type] = (n[t.org_type] || 0) + 1;
  }
  const top = Object.entries(n).sort((x, y) => y[1] - x[1])[0]?.[0];
  return top === 'vendor' || top === 'partner' ? top : 'customer';
}
/** A filter row's icon for a name without one: its initial on its colour, as avatars have. */
const tile = (name) => `<span class="ico av" style="background:${hue(name)}" aria-hidden="true">${esc(initials(name).slice(0, 1))}</span>`;
/** Involves: you and the people as their avatars (round), your teams as tiles. */
function involvesFace(v) {
  if (v.startsWith('team:')) return tile(involvesLabel(v));
  const name = v === 'me' ? state.me?.name || involvesLabel(v) : involvesLabel(v);
  const p = (state.data?.threads || []).flatMap((t) => t.participants || []).find((x) => x.name === name && x.avatar);
  return avatar(name, p?.avatar, 'ico round').replace(/ title="[^"]*"/, ' aria-hidden="true"');
}
const involvesColor = (v) => {
  if (v === 'me') return 'c-me';
  if (v.startsWith('team:')) return 'c-team';
  return `c-${personKind(v.slice(7))}`;
};
// Orgs by the type the admin team set (customer unless set); "other" for threads not filed
// under an org yet (`_unassigned`). Not guessed from who posted: a customer's new
// conversation that only Adobe has written in yet is still the customer's.
const ORG_GROUPS = ['partner', 'vendor', 'customer', 'internal', 'other'];
const ORG_GROUP_LABEL = {
  partner: 'Partners', vendor: 'Vendors', customer: 'Customers', internal: 'Internal', other: 'Other',
};
function orgGroup(org) {
  if (!org || org.startsWith('_')) return 'other';
  const type = (state.data?.threads || []).find((x) => x.org === org)?.org_type;
  return ORG_GROUPS.includes(type) && type !== 'other' ? type : 'customer';
}
const ORG_COLOR = {
  partner: 'c-partner', vendor: 'c-vendor', customer: 'c-customer', internal: 'c-none', other: 'c-none',
};
const URGENCY_COLOR = {
  critical: 'c-red', high: 'c-gold', normal: 'c-blue', low: 'c-none',
};
const KIND_COLOR = {
  incident: 'c-orange', security: 'c-gold', question: 'c-red', request: 'c-pink', access: 'c-brown', people: 'c-green', meeting: 'c-blue', alert: 'c-crimson', other: 'c-none',
};
// The names of tech stack and topic ids, as the API sends them (src/label.js vocab).
const vocabName = (kind, v) => state.data?.vocab?.[kind]?.[v] || v;
// A thread's channel's tech stack, and what the thread is about (both multi-valued).
const techOf = (t) => t.tech || [];
const topicsOf = (t) => t.label?.topics || [];
const colorOf = (map) => (v) => map[v] || 'c-none';

// The cards in this order. A facet with `into` is shown in that facet's card, below its own
// rows, and still filters on its own (both must match).
const customerName = (v) => { const t = [...listed(), ...(state.data?.threads || [])].find((x) => x.org === v); return t ? orgName(t) : v; };
const FACETS = [
  { id: 'status', title: 'Status', value: statusOf, order: STATUS_ORDER, label: STATUS_LABEL, hint: STATUS_HINT,
    emoji: (v) => STATUS_ICON[v], color: (v) => `c-${v}` },
  { id: 'urgency', title: 'Urgency', value: urgencyOf, order: ['critical', 'high', 'normal', 'low'],
    emoji: (v) => URGENCY_ICON[v], color: colorOf(URGENCY_COLOR) },
  { id: 'resolved', title: 'Resolved', value: resolvedOf, order: ['open', 'resolved'],
    label: { open: 'Unresolved', resolved: 'Resolved' }, emoji: (v) => RESOLVED_ICON[v],
    color: colorOf({ open: 'c-red', resolved: 'c-green' }) },
  { id: 'draft', into: 'resolved', title: 'Draft', value: draftState, order: ['mine', 'team', 'none'], label: DRAFT_LABEL, hint: DRAFT_HINT,
    emoji: (v) => DRAFT_ICON[v], color: colorOf({ mine: 'c-blue', team: 'c-blue' }) },
  { id: 'customer', title: 'Customer', value: (t) => t.org, icon: (v, ts) => { const t = ts.find((x) => x.org === v && orgIcon(x)); return t && orgIcon(t); },
    labelFn: customerName, limit: 12, face: (v) => tile(customerName(v)),
    group: orgGroup, groups: ORG_GROUPS, groupLabel: ORG_GROUP_LABEL, color: (v) => ORG_COLOR[orgGroup(v)] },
  { id: 'kind', title: 'Kind', value: kindOf, emoji: (v) => KIND_EMOJI[v], color: colorOf(KIND_COLOR),
    order: ['incident', 'security', 'question', 'request', 'access', 'people', 'meeting', 'alert', 'other'] },
  { id: 'topic', title: 'Topic', value: topicsOf, multi: true, labelFn: (v) => vocabName('topics', v), limit: 12,
    face: (v) => tile(vocabName('topics', v)) },
  { id: 'tech', title: 'Tech stack', value: techOf, multi: true, labelFn: (v) => vocabName('tech', v), limit: 12,
    face: (v) => tile(vocabName('tech', v)) },
  { id: 'next', title: 'Waiting on', value: waitingOn, order: ['Us', 'Customer', 'Nobody'], emoji: (v) => WAITING_ICON[v],
    color: colorOf({ Us: 'c-red', Customer: 'c-silent' }) },
  { id: 'involves', title: 'Involves', value: involvement, multi: true, labelFn: involvesLabel, color: involvesColor,
    face: involvesFace,
    order: () => ['me', ...Object.keys(state.data?.teams || {}).map((s) => `team:${s}`),
      ...(state.coPeople || []).map((p) => `person:${p}`)
        .sort((x, y) => PERSON_KINDS.indexOf(personKind(x.slice(7))) - PERSON_KINDS.indexOf(personKind(y.slice(7))))] },
  { id: 'type', title: 'Type', value: (t) => (t.kind === 'alert' ? 'alert' : 'conversation'), order: ['conversation', 'alert'],
    label: { conversation: 'Conversations', alert: 'Alerts' }, emoji: (v) => TYPE_ICON[v],
    color: colorOf({ conversation: 'c-blue', alert: 'c-crimson' }) },
  { id: 'platform', title: 'Platform', value: platform, order: ['Slack', 'Teams', 'Discord'],
    icon: (v) => PLATFORM_SITE[v],
    color: colorOf({ Slack: 'c-slack', Teams: 'c-msteams', Discord: 'c-discord' }) },
];
// The views: the inbox of one of the viewer's teams (`state.team`), or the personal view
// (`state.sort` is 'personal'), the threads of the channels they posted or were mentioned in,
// whichever team they are filed under. The personal view (latest activity first) keeps the customer and platform
// cards only, and picks one customer at a time; it shows conversations, not alerts. A team's
// view has every card. Filters on the cards a view does not show do not apply in it, and are
// kept for the other.
const PERSONAL_FACETS = FACETS.filter((f) => f.id === 'customer' || f.id === 'platform');
const personal = () => state.sort === 'personal';
/** Which inbox is on screen (or `data` is of): a team's slug, or `~personal`. */
const scopeKey = () => (personal() ? '~personal' : state.team);
const scopeOf = (data) => (data.personal ? '~personal' : data.team);
const viewFacets = () => (personal() ? PERSONAL_FACETS : FACETS);
const single = (id) => personal() && id === 'customer';
/** Into the personal view: one customer stays picked, the open thread's if it is one of them. */
function onePick() {
  const set = state.sel.customer;
  if (!personal() || !set || set.size < 2) return;
  const open = state.open && state.data?.threads.find((t) => t.thread === state.open);
  state.sel.customer = new Set([open && set.has(open.org) ? open.org : [...set][0]]);
}
const facetValues = (f, t) => {
  const v = f.value(t);
  if (f.multi) return v && v.length ? v : ['(none)'];
  return [v ?? '(none)'];
};
function valuesOf(f, t) {
  if (!pass) return facetValues(f, t);
  let byThread = pass.values.get(f.id);
  if (!byThread) pass.values.set(f.id, (byThread = new WeakMap()));
  if (!byThread.has(t)) byThread.set(t, facetValues(f, t));
  return byThread.get(t);
}
// Unread only keeps every thread the list has shown since it was opened (see syncList), so a
// row does not vanish when you, or you elsewhere, read it.
const passes = (t, except) => (!state.unread || keptUnread(t))
  && (!personal() || t.kind !== 'alert')
  && viewFacets().every((f) => f.id === except || facetPasses(f, t));
/**
 * Whether `t` passes facet `f`, as in klickhaus: one of its values is picked (when any are),
 * and none of them is excluded. Picked values of a facet are OR'd, excluded ones AND'd.
 */
function facetPasses(f, t) {
  const picked = state.sel[f.id];
  const excluded = state.not[f.id];
  if (!picked?.size && !excluded?.size) return true;
  const vs = valuesOf(f, t);
  return (!picked?.size || vs.some((v) => picked.has(v)))
    && (!excluded?.size || !vs.some((v) => excluded.has(v)));
}
/** Filter values set on facet `id`, picked and excluded. */
const filterCount = (id) => (state.sel[id]?.size || 0) + (state.not[id]?.size || 0);
/**
 * A click on a facet row: plain, it picks the value or drops it; with `exclude` (Shift, or the
 * row's ≠ button), it excludes the value or stops excluding it. A value is picked or excluded,
 * never both, and a plain click on an excluded one just stops excluding it.
 */
function toggleFilter(id, v, exclude) {
  const picked = state.sel[id];
  const excluded = state.not[id];
  const was = excluded?.has(v) ? 'not' : (picked?.has(v) ? 'sel' : null);
  picked?.delete(v);
  excluded?.delete(v);
  if (exclude && was !== 'not') (state.not[id] ||= new Set()).add(v);
  else if (!exclude && !was) {
    if (single(id)) state.sel[id] = new Set([v]);
    else (state.sel[id] ||= new Set()).add(v);
  }
  for (const sets of [state.sel, state.not]) if (!sets[id]?.size) delete sets[id];
}

/**
 * A facet row's bar. Its length is the count; except on the status card itself, it is
 * split into the statuses of the threads behind it, as klickhaus splits status codes.
 */
function bar(f, v, n, max, m, color) {
  const width = `${Math.max(2, Math.round((n / max) * 100))}%`;
  if (f.id === 'status' || !m || !n) return `<span class="bar ${color}" style="width:${width}"></span>`;
  const seg = STATUS_ORDER.filter((k) => m[k])
    .map((k) => `<i class="c-${k}" style="flex:${m[k]}" title="${m[k]} ${esc(STATUS_LABEL[k])}"></i>`).join('');
  return `<span class="bar stack" style="width:${width}">${seg}</span>`;
}

/**
 * A facet row's label: a name for a customer or someone involved, not their slug or id. It is
 * also the row's tooltip, all the folded filter column shows of it, unless the facet has a hint.
 */
const rowLabel = (f, v) => (f.labelFn && f.labelFn(v)) || (f.label && f.label[v]) || v;

function facetRows(f) {
  const all = listed();
  const pool = all.filter((t) => passes(t, f.id));
  const counts = new Map();
  const mix = new Map(); // value -> { red, yellow, green, none }
  const unread = new Set(); // values with threads the viewer has not read
  const mentions = new Map(); // value -> messages mentioning the viewer they have not read
  for (const t of pool) {
    for (const v of valuesOf(f, t)) {
      counts.set(v, (counts.get(v) || 0) + 1);
      if (t.unread) unread.add(v);
      if (t.unreadMentions) mentions.set(v, (mentions.get(v) || 0) + t.unreadMentions);
      const m = mix.get(v) || {};
      m[statusOf(t)] = (m[statusOf(t)] || 0) + 1;
      mix.set(v, m);
    }
  }
  if (f.multi) counts.delete('(none)');
  for (const v of state.sel[f.id] || []) if (!counts.has(v)) counts.set(v, 0);
  for (const v of state.not[f.id] || []) if (!counts.has(v)) counts.set(v, 0);
  let rows = [...counts];
  const order = typeof f.order === 'function' ? f.order() : f.order;
  if (f.multi) for (const v of order || []) if (!counts.has(v)) counts.set(v, 0);
  rows.sort((a, b) => (order ? (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99) : b[1] - a[1]));
  const on = state.sel[f.id] || new Set();
  const off = state.not[f.id] || new Set();
  // Past the limit, the values picked or excluded stay, so they can be clicked off again.
  if (f.limit) rows = rows.filter(([v], i) => i < f.limit || on.has(v) || off.has(v));
  if (f.group) rows.sort((a, b) => f.groups.indexOf(f.group(a[0])) - f.groups.indexOf(f.group(b[0])));
  const max = Math.max(1, ...rows.map((r) => r[1]));
  let group = null;
  return rows.map(([v, n]) => {
    const color = f.color ? f.color(v) : 'c-accent';
    const ic = f.icon && f.icon(v, all);
    const em = f.emoji && f.emoji(v);
    const face = !ic && !em && f.face && f.face(v);
    const g = f.group && f.group(v);
    const head = g && g !== group ? `<div class="fg">${esc(f.groupLabel[g])}</div>` : '';
    group = g;
    const out = off.has(v);
    const not = out ? 'Stop excluding' : 'Exclude (or Shift-click the row)';
    const label = rowLabel(f, v);
    return `${head}<div class="fr ${on.has(v) ? 'on' : ''}${out ? 'off' : ''}" data-f="${f.id}" data-v="${esc(v)}" title="${esc((f.hint && f.hint[v]) || label)}${out ? ' (excluded)' : ''}">
      <span class="ind ${v === '(none)' ? 'c-none' : color}"></span>
      ${ic ? `<img class="ico" src="${esc(favicon(ic))}" alt="" loading="lazy">` : (face || (em ? `<span class="ico em">${em}</span>` : '<span></span>'))}
      <span class="lw"><span class="lab${v === '(none)' ? ' dim' : ''}${unread.has(v) ? ' new' : ''}"${unread.has(v) ? ' aria-description="unread threads"' : ''}>${esc(label)}</span>${mentionBadge(mentions.get(v))}</span>
      <button class="not" type="button" data-not aria-pressed="${out}" title="${not}" aria-label="${out ? 'Stop excluding' : 'Exclude'}">≠</button>
      <span class="n">${n}</span>
      ${bar(f, v, n, max, mix.get(v), color)}</div>`;
  }).join('') || '<div class="fr"><span></span><span></span><span class="lab dim">nothing</span></div>';
}

/** How many messages mention the viewer that they have not read, as Slack and Teams show it. */
const mentionBadge = (n) => (n ? `<b class="men" title="${n} unread ${n === 1 ? 'mention' : 'mentions'} of you">${n > 99 ? '99+' : n}</b>` : '');

const cardFacets = (id) => viewFacets().filter((f) => f.id === id || f.into === id);

function renderFilters() { inPass(filterCards); }
function filterCards() {
  syncList();
  const cards = viewFacets().filter((f) => !f.into).map((f) => {
    const parts = cardFacets(f.id);
    const on = parts.some((x) => filterCount(x.id));
    return `<div class="card${on ? ' active' : ''}" data-f="${f.id}"><h3>${esc(f.title)}${on ? '<span class="clear" data-clear="1">clear</span>' : ''}</h3>
      ${parts.map((x) => `${x === f ? '' : `<div class="fg">${esc(x.title)}</div>`}${facetRows(x)}`).join('')}</div>`;
  });
  // Only the cards whose counts or selection changed are rebuilt.
  const box = $('filters');
  const old = [...box.children];
  if (old.length !== cards.length || old.some((c) => c.__html === undefined)) {
    box.innerHTML = cards.join('');
    [...box.children].forEach((c, i) => { c.__html = cards[i]; });
    return;
  }
  cards.forEach((html, i) => {
    if (old[i].__html === html) return;
    const node = toNode(html);
    node.__html = html;
    old[i].replaceWith(node);
  });
}

// ---------------------------------------------------------------- thread list
// `:name:` to the emoji, for titles (the body renderer does the same).
const emojify = (text) => esc(text).replace(EMOJI_CODE, (m, n, at, s) => emojiHtml(n, { alone: Markdown.emojiAlone(s, at, m.length) }) || m);
/** Text without what platforms rewrite: emoji (characters or :codes:), markup, spacing. */
// eslint-disable-next-line no-misleading-character-class -- the joiner on its own, too
const looseText = (text) => String(text || '').replace(EMOJI_CODE, '').replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, '')
  .replace(/<@[^>]+>|@\S+/g, '').replace(/[*_~`>]/g, '').replace(/\s+/g, ' ')
  .trim();

const URGENCY_EMOJI = { critical: '🆘', high: '⚡' };
const ourMove = (t) => t.waiting_on === 'us';

/** The thread's mood: its kind first, then the reactions people left in it. */
function moods(t) {
  const out = [];
  const u = urgencyOf(t);
  if (URGENCY_EMOJI[u]) out.push(`<span class="em" title="${esc(u)} urgency">${URGENCY_EMOJI[u]}</span>`);
  const k = kindOf(t);
  if (k) out.push(`<span class="em" title="${esc(k)}">${KIND_EMOJI[k] || '💬'}</span>`);
  const rx = (t.reactions || []).map((r) => ({ ...r, html: emojiHtml(r.emoji, { slack: t.source === 'slack' }) }))
    .filter((r) => r.html).sort((a, b) => b.count - a.count).slice(0, 5);
  for (const r of rx) out.push(`<span class="em" title="${esc(`${r.emoji} × ${r.count}`)}">${r.html}</span>`);
  return out.length ? `<span class="moods">${out.join('')}</span>` : '';
}

// What a row sets apart, in its classes: resolved, an unread mention of you, critical or hot.
const isResolved = (t) => checked(t) || resolvedOf(t) === 'resolved';
const mentionsMe = (t) => t.unread && (t.unreadMentions > 0 || t.mentionedMe);
function flags(t) {
  const status = statusOf(t);
  let out = '';
  if (isResolved(t)) out += ' resolved';
  if (mentionsMe(t)) out += ' mention';
  if (status === 'critical' || status === 'hot') out += ' urgent';
  return out;
}
const titleHtml = (t, hit) => `${t.root_known ? '' : '↳ '}${hit ? marked(t.title || '(no text)', state.search.words) : emojify(t.title || '(no text)')}`;
const draftMark = (t) => (t.draft ? `<span class="drafted" title="${esc(`Draft by ${draftBy(t.draft)}, ${ago(t.draft.updated_at)}: ${t.draft.preview}`)}">✎ Draft</span>` : '');
const statusTitle = (t, status) => `${STATUS_HINT[status]}${ourMove(t) ? ' · our move' : ''}`;
/** A row's one status mark: the status dot, or a ✓ in its place once the thread is resolved. */
function statusMark(t, status) {
  const title = esc(statusTitle(t, status));
  if (isResolved(t)) return `<span class="ok" title="Resolved · ${title}">✓</span>`;
  return `<span class="dot ${status === 'quiet' ? '' : `c-${status}`} ${ourMove(t) ? 'ring' : ''}" title="${title}"></span>`;
}
const rowOpen = (t, hit, cls) => `<div class="t ${t.unread ? 'unread' : ''} ${state.open === t.thread ? 'sel' : ''} ${!hit && state.prevKeys && !state.prevKeys.has(t.thread) ? 'enter' : ''}${hit ? ' hit' : ''}${flags(t)}${cls}" data-thread="${esc(t.thread)}"${hit ? ` data-hit="1"${hit.snippet ? ` data-msg="${esc(hit.snippet.message)}"` : ''}` : ''}>`;

/** One customer picked in the filters: every row is theirs, so the rows leave it out. */
const oneCustomer = () => state.sel.customer?.size === 1;

/**
 * A thread's row: unread rows are white and read ones tinted. The customer is left out when
 * the filters pick one; the second line says "Y replies, X mentions" and, as far as there is
 * room before the reactions, the latest reply, as Messages does.
 */
function row(t, hit = null) {
  const status = statusOf(t);
  const faces = (t.participants || []).map((p) => avatar(p.name || '?', p.avatar, '', {
    key: profileKey(p.key, { ...p, platform: t.source }), tab: true,
  })).join('');
  const replies = Math.max(0, (t.messages || 1) - 1);
  const n = t.occurrences || (t.members || []).length;
  let count = '';
  if (n > 1) count = `${n}×`;
  else if (replies) count = `${replies} ${replies === 1 ? 'reply' : 'replies'}`;
  const m = mentionsMe(t) ? (t.unreadMentions || 1) : 0;
  const mentions = m ? `<b class="men" title="Unread mentions of you">${count ? ', ' : ''}${m} ${m === 1 ? 'mention' : 'mentions'}</b>` : '';
  // The latest reply: the inbox sends it (see `preview`). Not for a thread without replies (its
  // latest message is its title) or a search result (it shows the message that matched).
  const p = replies && !hit ? preview(t) : null;
  const said = p?.text ? `<span class="snip" title="${esc(`${p.who}: ${p.text}`)}">${p.who ? `${esc(p.who.split(' ')[0])}: ` : ''}${emojify(p.text)}</span>` : '';
  const cust = oneCustomer() ? ''
    : `<span class="cust">${orgIcon(t) ? `<img src="${esc(favicon(orgIcon(t)))}" alt="" loading="lazy">` : ''}${esc(orgName(t))}</span>`;
  return `${rowOpen(t, hit, oneCustomer() ? ' nocust' : '')}
    <div class="l1">${statusMark(t, status)}
      ${draftMark(t)}<span class="title">${titleHtml(t, hit)}</span>
      <span class="when" title="${esc(activityOf(t))}">${ago(activityOf(t))}</span></div>
    <div class="l2">${cust}
      <span class="faces">${faces}</span>
      ${count || mentions ? `<span class="replies${replies && n <= 1 ? ' re' : ''}">${count}${mentions}</span>` : ''}${said}
      <span class="tags">${moods(t)}</span>
    </div>${hit ? hitLine(hit) : ''}</div>`;
}

/** Markdown as one line of plain text, for a preview. */
const plain = (text) => String(text || '').replace(EMOJI_CODE, (m, n) => emojiByName(n) || m)
  .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
  .replace(/^\s*(?:[-*+]|\d+\.|>|#+|\|)\s*/gm, '')
  .replace(/[*_~`|]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
/**
 * A row's preview: the thread's latest message as the inbox sends it (`last_text`, from
 * `threads`), else from the thread cache (a thread the cron has not filled in yet, see
 * src/previews.js).
 */
function preview(t) {
  if (t.last_text) return { who: t.last_author || '', text: plain(t.last_text).slice(0, 220) };
  const ms = (state.cache.get(t.thread)?.data?.messages || [])
    .filter((m) => m.author?.kind !== 'system' && !m.deletedAt && !m.pending);
  const m = ms[ms.length - 1];
  return m ? { who: m.author?.name || '', text: plain(m.body).slice(0, 220) } : null;
}

// ---------------------------------------------------------------- search
// The search box over the list: what it finds (GET /api/search, every platform at once) takes
// the list's place, best match first, each row with the message that matched. The filter
// cards count and filter the results; clearing the search brings the inbox back as it was.
const searching = () => Boolean(state.search.q);
/** A search result's entry: the inbox's own (kept current by live updates), else the search's. */
const searchEntry = (key) => state.data?.threads.find((t) => t.thread === key)
  || state.search.data?.threads.find((t) => t.thread === key);
/** The entries the list and the filter cards are about: the search results, or the inbox. */
function listed() {
  if (!searching()) return state.data?.threads || [];
  return (state.search.data?.hits || []).map((h) => searchEntry(h.thread)).filter(Boolean);
}
const reEscape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `text`, escaped, with the query's words marked. */
function marked(text, words) {
  const ws = (words || []).filter(Boolean).map(reEscape);
  if (!ws.length) return emojify(text);
  return String(text).split(new RegExp(`(${ws.join('|')})`, 'gi'))
    .map((part, i) => (i % 2 ? `<mark>${emojify(part)}</mark>` : emojify(part))).join('');
}
const MATCHED = { title: 'Title', place: 'Channel or customer', fact: 'Facts', text: 'Words in a message', topic: 'About this' };
// Fact fields of the admin team's rules (migration 0043) and Clairic's; a team's own show as they are named.
const FACT_LABEL = {
  url: 'URL', cve: 'CVE', ticket: 'Ticket', site: 'Site', repo: 'Repository', problem: 'Problem', error: 'Error', deadline: 'Deadline',
  go_live: 'Go-live', affected_url: 'Affected URL', admin_api: 'Admin API', aemcs_env: 'AEM environment', doc: 'Docs', tool: 'Tool',
  config_file: 'Config file', http_status: 'Status', header: 'Header', case: 'Support case',
};
/** A result's third line: the message that matched, else the fact, else why it matched. */
function hitLine(hit) {
  const words = state.search.words;
  if (hit.snippet) {
    const s = hit.snippet;
    return `<div class="l3" title="${esc(s.text)}">${s.author ? `<b>${esc(s.author)}</b> ` : ''}${marked(s.text, words)}</div>`;
  }
  if (hit.fact) {
    return `<div class="l3"><span class="tag">${esc(FACT_LABEL[hit.fact.field] || hit.fact.field)}</span> ${marked(hit.fact.value, words)}</div>`;
  }
  return `<div class="l3 dim">${esc(hit.matched.map((m) => MATCHED[m] || m).join(' · '))} matches</div>`;
}

/** Asks for `q` (after a pause in typing, or at once), and shows the answer when it is the latest. */
let searchTimer = null;
function searchSoon(q, wait = 250) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), wait);
}
async function runSearch(q) {
  clearTimeout(searchTimer);
  const query = String(q || '').replace(/\s+/g, ' ').trim();
  // The same question as the one on screen, or on its way, is not asked again.
  if (query === state.search.q && (state.search.loading || (state.search.data?.scope === scopeKey() && !state.search.error))) return;
  const seq = ++state.search.seq;
  state.search.q = query;
  if ($('q') && $('q').value.trim() !== query) $('q').value = query;
  toUrl(false);
  if (!query) { Object.assign(state.search, { words: [], data: null, loading: false, error: null }); render(); return; }
  state.search.loading = true;
  state.search.error = null;
  render();
  try {
    const scope = scopeKey();
    const data = await get(`/api/search?${personal() ? 'view=personal' : `team=${encodeURIComponent(state.team)}`}&q=${encodeURIComponent(query)}`);
    if (seq !== state.search.seq) return;
    data.scope = scope;
    mergeProfiles(data.profiles);
    if (state.data) state.data.people = { ...(data.people || {}), ...(state.data.people || {}) };
    Object.assign(state.search, { data, words: data.words || [], loading: false });
  } catch (e) {
    if (seq !== state.search.seq) return;
    Object.assign(state.search, { data: null, loading: false, error: e.message });
  }
  render();
}
function clearSearch() {
  if ($('q')) $('q').value = '';
  runSearch('');
}
/** The results, as rows: built anew when they change, the rest kept. */
function searchRows(box) {
  const { data, loading, error, q } = state.search;
  const all = data?.hits || [];
  const hits = all.filter((h) => { const t = searchEntry(h.thread); return t && passes(t); });
  const on = viewFacets().reduce((n, f) => n + filterCount(f.id), 0) + (state.unread ? 1 : 0);
  const filt = `<button class="filt" data-filters aria-controls="filters" aria-expanded="${state.filtering}" title="Show the filters">${SLIDERS}Filters${on ? `<b>${on}</b>` : ''}</button>`;
  let said = 'Searching…';
  if (!loading && error) said = 'Search failed';
  else if (!loading && data) said = `${hits.length}${hits.length < all.length ? ` of ${all.length}` : ''} ${all.length === 1 ? 'result' : 'results'}`;
  // The view switch stays: a search is of the view on screen, a team's or the personal one.
  const ctl = `<span class="lead">${filt}<span class="found" aria-live="polite">${esc(said)}</span><button class="clearq" data-clearq title="Back to the inbox (Esc in the search box)">Clear</button></span><span class="sort">${viewSwitch()}</span>`;
  const head = box.querySelector('.ctl');
  if (head.__html !== ctl) { head.innerHTML = ctl; head.__html = ctl; }
  const list = box.querySelector('.rows');
  const made = state.hitNodes || (state.hitNodes = new Map());
  const nodes = hits.map((h) => {
    const html = row(searchEntry(h.thread), h).trim();
    let node = made.get(h.thread);
    if (!node || node.__html !== html) {
      node = toNode(html);
      node.__html = html;
      made.set(h.thread, node);
    }
    preload.observe(node);
    return node;
  });
  for (const c of list.children) if (!nodes.includes(c)) preload.unobserve(c);
  if (nodes.length) list.replaceChildren(...nodes);
  else if (loading && !data) list.innerHTML = '<div class="empty">Searching…</div>';
  else if (error) list.innerHTML = `<div class="empty">${esc(error)}</div>`;
  else if (all.length) list.innerHTML = `<div class="empty">${all.length} ${all.length === 1 ? 'result is' : 'results are'} hidden by the filters. <button class="linkish" data-unfilter>Show all</button></div>`;
  else if (data) list.innerHTML = `<div class="empty">Nothing found for “${esc(q)}”.</div>`;
  list.classList.toggle('stale', Boolean(loading && data));
  const keep = new Set(hits.map((h) => h.thread));
  for (const k of made.keys()) if (!keep.has(k)) made.delete(k);
  cardGone();
  state.order = hits.map((h) => h.thread);
}
/** Opens a result at the message that matched. */
function openHit(key) {
  const el = document.querySelector(`#threads .t[data-thread="${CSS.escape(key)}"][data-msg]`);
  state.jump = el ? { key, id: el.dataset.msg } : null;
  openThread(key);
}

// Team order: what needs me most, first. The status piles come first (STATUS_WEIGHT); within
// a pile, the model of ui/rank.js says what needs the team most (learned from Clef's
// judgements of production threads, `npm run rank`), and how close a thread is to me adds to
// it: mentioned me > I posted > mentioned the team > the team posted, 🛟 by a colleague raises
// it, 👀 by a colleague lowers it. Without a model, classicScore: recency always counts; a
// thread that waits on us counts more the longer it waits, the more urgent and unresolved it
// is, and the closer to me; resolved weighs on all of it.
// Neighbouring piles are at least 0.5 apart (× 100: 50), and baseScore stays within ±24, so a
// thread never leaves its pile: keep both so when a pile is added or moved.
const STATUS_WEIGHT = {
  critical: 6, hot: 5, you: 4, waiting: 3, silent: 2, team: 1.5, quiet: 1,
};
const PILE_CLAMP = 24;
function smartScore(t) {
  return STATUS_WEIGHT[statusOf(t)] * 100 + baseScore(t);
}
/** How close a thread is to the viewer, as a factor (1: only the team's). */
function closeness(t) {
  const me = viewerId();
  const team = teamIds();
  let near = 1;
  if ((t.mentioned || []).some((m) => m.person === me) || t.mentionedMe) near = 3;
  else if ((t.posters || []).includes(me) || signals(t).mine) near = 2;
  else if ((t.mentioned || []).some((m) => team.has(m.person))) near = 1.5;
  else if ((t.posters || []).some((p) => team.has(p))) near = 1.2;
  const sig = signals(t);
  // 👀 by a colleague lowers it for you; 🛟 by a colleague raises it.
  return near * (sig.others && !sig.mine ? 0.5 : 1) * (sig.help ? 2 : 1);
}
/** Within a pile: the model's log-odds and the viewer's closeness, kept inside the pile. */
function baseScore(t) {
  const team = Rank.model ? Rank.score(t) : null;
  if (team === null) return classicScore(t);
  return Math.max(-PILE_CLAMP, Math.min(PILE_CLAMP, team + Math.log(closeness(t))));
}
function classicScore(t) {
  const now = Date.now();
  const last = Date.parse(lastOf(t) || t.any_at || 0) || 0;
  const ageH = Math.max(0, (now - last) / 3600000);
  const recency = Math.exp(-ageH / 48);
  const urgency = 1 + (t.label?.urgency ?? 0.5);
  const open = 1 - 0.9 * resolvedP(t);
  const waiting = t.waiting_on === 'us' ? 1 + Math.log2(1 + ageH / 2) : 0.3;
  const unseen = t.unseenByAdobe ? 1.5 : 1;
  const alert = t.kind === 'alert' ? 0.3 : 1;
  return alert * open * (2 * recency + urgency * waiting * unseen * closeness(t));
}

/**
 * The team order learns from what people open (`npm run rank`, src/rankevents.js): a thread
 * clicked in the list wins over the others on screen then. Sent with each of them: its place
 * in the list, its status pile and what ui/rank.js makes of it now, so the training sees what
 * the list showed (and compares threads within a pile, as the model orders them).
 * Not while viewing as someone else, searching, or clicking the thread already open.
 */
function recordPick(key) {
  if (state.as || searching() || !state.data || key === state.open) return;
  const list = $('threads').getBoundingClientRect();
  const top = Math.max(0, list.top);
  const bottom = Math.min(innerHeight, list.bottom);
  const byKey = new Map(state.data.threads.map((t) => [t.thread, t]));
  const shown = [];
  for (const node of $('threads').querySelectorAll('.t[data-thread]')) {
    const r = node.getBoundingClientRect();
    const t = byKey.get(node.dataset.thread);
    if (t && r.height && r.bottom > top && r.top < bottom && shown.length < 40) {
      const f = Rank.features(t);
      for (const k of Object.keys(f)) f[k] = Math.round(f[k] * 1000) / 1000;
      shown.push({ thread: t.thread, pos: state.order.indexOf(t.thread), status: statusOf(t), features: f });
    }
  }
  if (shown.length < 2 || !shown.some((x) => x.thread === key)) return;
  fetch('/api/rank/pick', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    body: JSON.stringify({ view: personal() ? 'personal' : state.team, clicked: key, shown, model: Rank.model?.trained || 'classic' }),
  }).catch(() => {});
}

const tpl = document.createElement('template');
const toNode = (html) => { tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };

// Threads in view are fetched ahead, so opening one is instant.
const preload = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) prefetch(e.target.dataset.thread);
}, { root: $('threads'), rootMargin: '200px' });

const FUNNEL = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h12M4.5 8h7M7 12h2"/></svg>';
const COMPOSE = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2.8H3.6a1.1 1.1 0 0 0-1.1 1.1v8.5a1.1 1.1 0 0 0 1.1 1.1h8.5a1.1 1.1 0 0 0 1.1-1.1V8.5"/><path d="M12 1.9a1.2 1.2 0 0 1 1.7 1.7L8 9.3l-2.3.6.6-2.3z"/></svg>';
const SLIDERS = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4.5h6M11 4.5h3M2 11.5h2M7 11.5h7"/><circle cx="9.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/></svg>';

function renderThreads() { inPass(threadRows); }

/*
 * The thread list stays put while it is the same list: the same view, filters and unread only
 * (`listKey`). Reading a thread changes its score, its status and whether it is unread; none of
 * that moves or hides a row you have seen, and new threads do not push the rows you look at
 * away. While the list lasts:
 * - every thread it has shown stays in it (`held`), read or not, whatever its filters say now:
 *   unread only is "unread when the list was opened", and what came in since;
 * - the rows you have seen (in view, or scrolled past: `seen`) keep their order; the rows below
 *   them are sorted as the view sorts, as older pages come in behind them;
 * - threads that come in (`arrived`: activity since the list was opened, and not in it yet) are
 *   added at the end of a team's list, its queue, and at the top of the personal view, latest
 *   activity first. There, a thread further down that you have not seen comes up to the top
 *   too when it has activity. In a team's list, a critical or hot one (nobody at Adobe has
 *   seen it) comes in right below the rows you have seen instead, not at the end.
 * A new list (another view or filter, unread only on or off, or a click on the view already
 * shown) is sorted afresh. The thread open then (`open`) stays in it when read, if it passes
 * the new filters.
 */
function newList(key = null, open = null) {
  return {
    key, open, fresh: true, order: [], held: new Set(), seen: new Set(), arrived: new Set(), since: '',
  };
}
/** Whether unread only keeps `t`: unread, shown by the list already, or open when the list was opened. */
const keptUnread = (t) => t.unread || state.list.held.has(t.thread) || t.thread === state.list.open;
const setsKey = (o) => Object.entries(o).filter(([, s]) => s?.size).map(([id, s]) => [id, [...s].sort()])
  .sort((a, b) => a[0].localeCompare(b[0]));
const listKey = () => JSON.stringify([scopeOf(state.data), state.data.as || null, state.unread,
  setsKey(state.sel), setsKey(state.not)]);
/** A new list, when what the list is of changed. */
function syncList() {
  if (!state.data) return;
  const key = listKey();
  if (state.list.key === key) return;
  state.list = newList(key, state.open);
  state.list.since = state.data.threads.reduce((m, t) => (activityOf(t) > m ? activityOf(t) : m), '');
}
/** A thread the list shows: one it has shown already (not an alert in the personal view), or one that passes. */
const onList = (t) => (state.list.held.has(t.thread) && (!personal() || t.kind !== 'alert')) || passes(t);
/** The view's order: latest activity first (personal), or what needs me most (a team). */
function viewSort(ts) {
  if (personal()) return ts.sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
  // Scores are computed when the inbox loads, not when you read a thread.
  return ts.sort((a, b) => (state.scores.get(b.thread) ?? smartScore(b)) - (state.scores.get(a.thread) ?? smartScore(a)));
}
/** The threads of the list (`sorted`, in the view's order), in the order the list shows them. */
function placeRows(sorted) {
  const L = state.list;
  let out = sorted;
  if (!L.fresh) {
    const placed = new Set(L.order);
    const unseen = sorted.filter((t) => !L.seen.has(t.thread));
    for (const t of unseen) {
      if ((personal() || !placed.has(t.thread)) && activityOf(t) > L.since) L.arrived.add(t.thread);
    }
    const by = new Map(sorted.map((t) => [t.thread, t]));
    const pinned = L.order.filter((k) => L.seen.has(k) && by.has(k)).map((k) => by.get(k));
    const come = unseen.filter((t) => L.arrived.has(t.thread));
    const rest = unseen.filter((t) => !L.arrived.has(t.thread));
    const urgent = (t) => ['critical', 'hot'].includes(statusOf(t));
    out = personal() ? [...come, ...pinned, ...rest]
      : [...pinned, ...come.filter(urgent), ...rest, ...come.filter((t) => !urgent(t))];
  }
  L.fresh = false;
  L.order = out.map((t) => t.thread);
  for (const k of L.order) L.held.add(k);
  return out;
}
/** The rows in view, and the ones above them, are seen: they keep their order from now on. */
function noteSeen() {
  const box = $('threads');
  const rows = box.querySelector('.rows')?.children;
  if (!rows?.length || searching() || !box.clientHeight) return;
  const bottom = Math.min(box.getBoundingClientRect().bottom, window.innerHeight);
  let lo = 0;
  let hi = rows.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().top < bottom) { last = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = 0; i <= last; i += 1) if (rows[i].dataset.thread) state.list.seen.add(rows[i].dataset.thread);
}
let seenFrame = 0;
const seenSoon = () => { if (!seenFrame) seenFrame = requestAnimationFrame(() => { seenFrame = 0; noteSeen(); }); };
/** The personal view (the default), then each of the viewer's teams: one switch, the active one highlighted. */
function viewSwitch() {
  const mine = personal();
  const views = [{
    slug: '', name: 'Personal', on: mine, hint: 'Personal: the channels you posted or were mentioned in, latest activity first',
  }, ...(state.teams || []).map((t) => ({
    slug: t.slug, name: t.name, on: !mine && t.slug === state.team, hint: `${t.name}: the team's channels, what needs you most first, with every filter`,
  }))];
  return `<span class="order" role="radiogroup" aria-label="Inbox">${views.map((v) => `<button role="radio" aria-checked="${v.on}" data-view="${esc(v.slug)}" title="${esc(v.hint)}">${esc(v.name)}</button>`).join('')}</span>`;
}
const LOUPE = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>';
/** The list's heading, made once: the search box (kept, as you type in it), then the controls. */
function listHead(box) {
  if (box.querySelector('.rows')) return;
  box.innerHTML = `<div class="count"><label class="find">${LOUPE}<input id="q" type="search" placeholder="Search Slack, Teams and Discord" aria-label="Search threads" aria-keyshortcuts="/" autocomplete="off" spellcheck="false" enterkeyhint="search"><kbd>/</kbd></label><div class="ctl"></div></div><div class="rows"></div>`;
  const input = $('q');
  input.value = state.search.q;
  input.addEventListener('input', () => searchSoon(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(input.value); }
    if (e.key === 'Escape') { e.preventDefault(); if (input.value || searching()) clearSearch(); else input.blur(); }
    if (e.key === 'ArrowDown' && state.order.length) { e.preventDefault(); input.blur(); (searching() ? openHit : openThread)(state.order[0]); }
  });
}
function threadRows() {
  const box = $('threads');
  if (!state.data) return;
  listHead(box);
  syncList();
  if (searching()) { searchRows(box); return; }
  const shown = placeRows(viewSort(state.data.threads.filter(onList)));
  const unread = `<button class="unread" data-unread aria-pressed="${state.unread}" title="${state.unread ? 'Showing unread threads only' : 'Show unread threads only'}" aria-label="Unread only">${FUNNEL}</button>`;
  const sorter = viewSwitch();
  // Narrower screens keep the filter cards in a drawer, opened from here (see the styles).
  const on = viewFacets().reduce((n, f) => n + filterCount(f.id), 0);
  const filt = `<button class="filt" data-filters aria-controls="filters" aria-expanded="${state.filtering}" title="Show the filters">${SLIDERS}Filters${on ? `<b>${on}</b>` : ''}</button>`;
  // Filters (narrow screens) and unread only on the left, the view switch on the right.
  // The bell: notifications for this view, with its filters (not while viewing as someone).
  const rung = bellOn();
  const bell = state.as ? '' : `<button class="bell" data-bell aria-pressed="${rung}" title="${rung ? 'Notifying you of new messages in this view: click to stop' : 'Notify me of new messages in this view, with these filters'}" aria-label="Notifications for this view">${BELL}</button>`;
  // Start a thread (not while viewing as someone: that is read-only).
  const post = state.as ? '' : `<button class="newpost" data-compose aria-pressed="${Boolean(state.compose)}" title="Start a new thread" aria-label="Start a new thread">${COMPOSE}</button>`;
  const count = `<span class="lead">${filt}${unread}${bell}${post}</span><span class="sort">${sorter}</span>`;
  const head = box.querySelector('.ctl');
  if (head.__html !== count) { head.innerHTML = count; head.__html = count; }
  // Patch the list instead of rebuilding it: unchanged rows keep their DOM (and images),
  // also rows a filter hid for a while, which are kept aside for when they show again.
  const list = box.querySelector('.rows');
  const existing = state.rowNodes || (state.rowNodes = new Map());
  for (const c of list.children) if (c.dataset.thread && !c.dataset.hit) existing.set(c.dataset.thread, c);
  list.classList.remove('stale');
  const nodes = shown.map((t) => {
    const html = row(t);
    // Selection, read state and the status dot change on a click; only the first line is
    // updated then, so the second line (avatars, favicon) keeps its DOM and does not flicker.
    const cls = /^<div class="([^"]*)"/.exec(html.trim())[1];
    const body = html.trim().replace(/^<div class="[^"]*"/, '<div');
    const old = existing.get(t.thread);
    const l2 = /<div class="l2">[\s\S]*$/.exec(body)[0];
    if (old && (old.__body === body || old.__l2 === l2)) {
      old.className = cls.replace(/\benter\b/, '').trim();
      if (old.__body !== body) {
        old.querySelector('.l1').outerHTML = /<div class="l1">[\s\S]*?<\/div>/.exec(body)[0];
        old.__body = body;
      }
      if (!old.isConnected) preload.observe(old);
      return old;
    }
    return { html, body, l2, thread: t.thread };
  });
  // New rows are parsed together, in one go.
  const fresh = nodes.map((n, i) => i).filter((i) => !(nodes[i] instanceof Element));
  if (fresh.length) {
    tpl.innerHTML = fresh.map((i) => nodes[i].html.trim()).join('');
    const made = [...tpl.content.children];
    for (const [k, i] of fresh.entries()) {
      const n = nodes[i];
      const node = made.length === fresh.length ? made[k] : toNode(n.html);
      node.__body = n.body;
      node.__l2 = n.l2;
      preload.observe(node);
      existing.set(n.thread, node);
      nodes[i] = node;
    }
  }
  const keep = new Set(nodes);
  if (!nodes.length) {
    for (const c of list.children) preload.unobserve(c);
    list.innerHTML = '<div class="empty">Nothing matches these filters.</div>';
  } else {
    [...list.children].forEach((c) => { if (!keep.has(c) && !c.classList.contains('older')) { preload.unobserve(c); c.remove(); } });
    nodes.forEach((n, i) => { if (list.children[i] !== n) list.insertBefore(n, list.children[i] || null); });
  }
  // The end of the list: older threads, while there are any.
  let older = list.querySelector(':scope > .older');
  const more = state.data.page?.next;
  const label = paging ? 'Loading older threads…' : 'Load older threads';
  if (more) {
    if (!older) older = toNode('<button class="older" data-older></button>');
    if (older.textContent !== label) older.textContent = label;
    older.disabled = Boolean(paging);
    if (list.lastElementChild !== older) list.append(older);
  } else if (older) older.remove();
  // Rows of threads that are no longer in the inbox are let go.
  const known = new Set(state.data.threads.map((t) => t.thread));
  for (const k of existing.keys()) if (!known.has(k)) existing.delete(k);
  cardGone();
  state.order = shown.map((t) => t.thread);
  state.prevKeys = known;
  noteSeen();
}
function render() { syncRail(); inPass(() => { renderFilters(); renderThreads(); }); }

// The open thread's row, lifted out of its column: a copy of it over the real one, wider by
// LIFT on each side and over the pane, in #lift, which spans the list. It floats over the
// list's heading while its row is below it, and slides under it with its row: above the
// heading's lower edge #lift fades out, over its top LIFT.v and shadow (LIFT.shade) at rest,
// over less and less of it as the row goes under, to a hard edge once it has.
const LIFT = { left: 10, right: 16, v: 3, room: 48, shade: 16 };
let liftOf = null;
function syncLift(copy) {
  const list = $('threads');
  const lift = $('lift');
  const sel = list.querySelector('.t.sel');
  lift.hidden = !sel;
  if (!sel) { liftOf = null; return; }
  if (copy || liftOf !== sel) {
    liftOf = sel;
    lift.innerHTML = sel.outerHTML;
    lift.firstElementChild.classList.remove('enter');
  }
  const main = lift.parentElement.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  const head = list.querySelector('.count')?.offsetHeight || 0;
  const r = sel.getBoundingClientRect();
  const over = LIFT.v + LIFT.shade;
  const f = over - Math.min(Math.max(box.top + head - r.top, 0), over);
  const mask = `linear-gradient(transparent ${head - f}px, #000 ${head - (LIFT.v * f) / over}px)`;
  Object.assign(lift.style, {
    left: `${box.left - main.left - LIFT.room}px`,
    top: `${box.top - main.top}px`,
    width: `${box.width + 2 * LIFT.room}px`,
    height: `${box.height}px`,
    maskImage: mask,
    webkitMaskImage: mask,
  });
  const { style } = lift.firstElementChild;
  // With the filters in a drawer the list starts at the page's left edge: the copy stops there.
  const ll = Math.min(LIFT.left, Math.max(0, box.left - main.left));
  // Moved with a transform: the copy follows the row as the list scrolls, and a move by
  // `top` would count as a layout shift (CLS) on every scroll.
  Object.assign(style, {
    left: '0px',
    top: '0px',
    transform: `translate(${r.left - box.left + LIFT.room - ll}px, ${r.top - box.top - LIFT.v}px)`,
    width: `${r.width + ll + LIFT.right}px`,
    height: `${r.height + 2 * LIFT.v}px`,
  });
  style.setProperty('--ll', `${ll}px`);
  style.setProperty('--lr', `${LIFT.right}px`);
  style.setProperty('--lv', `${LIFT.v}px`);
}
{
  let frame = 0;
  let copy = false;
  const later = (again) => {
    copy ||= again;
    if (!frame) {
      frame = requestAnimationFrame(() => { frame = 0; syncLift(copy); copy = false; });
    }
  };
  new MutationObserver(() => later(true)).observe($('threads'), {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  $('threads').addEventListener('scroll', () => later(false), { passive: true });
  $('threads').addEventListener('animationend', () => later(false));
  new ResizeObserver(() => later(false)).observe(document.querySelector('main'));
}

// ---------------------------------------------------------------- messages
const QUESTION_LABEL = { next_actor: 'Next actor', kind: 'Kind', urgency: 'Urgency', resolved: 'Resolved' };
function modelValue(model, q) {
  if (q === 'urgency') return model.urgency == null ? null : String(Math.round(model.urgency));
  if (q === 'resolved') return model.resolved_p == null ? null : (model.resolved_p >= 0.5 ? 'yes' : 'no');
  return model[q];
}
/**
 * Label review (admin team, "Review labels" on): pinned to the top of the thread, so you
 * can read on, pick the right answers, and apply them together.
 */
function reviewPanel(thread, model, reviews) {
  const current = reviews.filter((r) => r.labeled_through === model.labeled_through);
  const staged = state.staged[thread.thread] || {};
  const rows = Object.keys(QUESTION_LABEL).map((q) => {
    const mv = modelValue(model, q);
    const reviewed = (current.find((r) => r.question === q) || {}).value;
    const picked = staged[q] ?? reviewed;
    return `<div class="q"><b>${QUESTION_LABEL[q]}</b>${(state.answers?.[q] || []).map((v) => `<button data-q="${q}" data-v="${esc(v)}" class="${v === mv ? 'model' : ''} ${v === picked ? 'picked' : ''}" title="${v === mv ? 'Clef' : ''}">${esc(v)}</button>`).join('')}</div>`;
  }).join('');
  const n = Object.keys(staged).length;
  return `<div class="rv" data-thread="${esc(thread.thread)}">${rows}
    <div class="apply"><button class="send" data-apply="1" ${n ? '' : 'disabled'}>Apply ${n || ''} ${n === 1 ? 'correction' : 'corrections'}</button>
      <button data-confirm="1" title="Clef got everything right">All correct</button></div></div>`;
}
// Discord lets only bots react through its API: reactions there are made in Discord.
const canReact = (m) => !state.data?.me?.readonly && !m.pending && !m.deletedAt && m.author?.kind !== 'system'
  && m.source !== 'discord';

/**
 * Whether the viewer may edit a message from here (the server says how, `m.editable`): as
 * themselves with a token that may (`me.edit`; Discord lets people edit only in Discord), or
 * as the opspile app, which posted it for them.
 */
const canEdit = (m) => !state.data?.me?.readonly && !m.pending && !m.deletedAt
  && (m.editable === 'app' || (m.editable === 'user' && Boolean(state.me?.edit?.[m.source])));

/** What the ✅ says, for the thread header's second line. */
function resolveNote(r) {
  const names = (r?.by || []).join(', ');
  let note = '';
  if (r?.state === 'resolved') note = `<span class="resolved" title="${esc(new Date(r.at).toLocaleString())}">✅ Resolved by ${esc(names || 'Adobe')}</span>`;
  else if (r?.state === 'reopened') note = `<span class="reopened" title="✅ by ${esc(names || 'Adobe')}, then the customer wrote again${r.verdict ? '' : '; Clef decides again'}">Reopened: the customer wrote after the ✅</span>`;
  return note ? `· ${note}` : '';
}
/** The ✅ button: resolve, or take your ✅ off again. */
function resolveButton(thread, r) {
  // Without the first message there is nothing to put the ✅ on.
  if (state.data?.me?.readonly || !thread.root_at || (thread.kind === 'alert' && !r) || thread.source === 'discord') return '';
  const mine = r?.state === 'resolved' && r.mine;
  return `<button class="resolve" id="resolve" aria-pressed="${Boolean(mine)}" aria-keyshortcuts="e" data-mine="${mine ? '1' : ''}" title="${mine ? 'Take your ✅ off the first message again' : 'Add ✅ to the first message, as you: resolved'} (e)">${mine ? '✅ Resolved · undo' : '✅ Resolve'}</button>`;
}

/** Whether `m` goes on from `prev`: same author, same post and day, within five minutes. */
const continues = (prev, m) => Boolean(prev) && m.author?.kind !== 'system' && prev.author?.kind !== 'system'
  && prev.author?.name === m.author?.name && prev.author?.kind === m.author?.kind && prev.thread === m.thread
  && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60 * 1000 && dayLabel(prev.at) === dayLabel(m.at);

// A run of one author's messages: the name above the first, the avatar beside the last
// (`followed`: the next message goes on from this one).
function message(m, prev, fresh, followed = false) {
  const a = m.author || {};
  const id = `${m.thread}|${m.id}`;
  const enter = fresh ? 'enter' : '';
  if (a.kind === 'system') return `<div class="sys ${enter}" data-id="${esc(id)}">${md(m.body, m.thread)} · ${clock(m.at)}</div>`;
  const adobe = Boolean(a.staff);
  // Yours (blue), or a colleague's (grey, like the customer's), as in iMessage.
  const own = Boolean(m.mine || m.pending);
  const cont = continues(prev, m);
  const key = profileKey(m.authorKey, {
    name: a.name, staff: a.staff, kind: a.kind, domain: a.org, avatar: m.avatar, platform: m.source,
  });
  const who = `<b data-p="${esc(key)}" role="button" tabindex="0">${esc(a.name || 'unknown')}</b>${a.kind === 'bot' ? ' bot' : ''} · ${clock(m.at)}`;
  const face = `<span class="face">${avatar(a.name || '?', m.avatar, '', { key })}${!adobe && a.org ? `<img class="badge-ico" src="${esc(favicon(a.org))}" alt="" title="${esc(a.org)}" loading="lazy">` : ''}</span>`;
  // Reactions: who reacted on hover; a click adds yours, or takes it off again.
  const can = canReact(m);
  const rx = (m.reactions || []).map((r) => {
    const tip = esc(`${r.names.join(', ') || r.emoji}${can ? (r.mine ? ' · click to take yours off' : ' · click to add yours') : ''}`);
    const chip = `${emojiChip(r.emoji, m.source)} ${r.count}`;
    return can ? `<button class="${r.mine ? 'mine' : ''}" data-emoji="${esc(r.emoji)}" data-mine="${r.mine ? '1' : ''}" aria-pressed="${Boolean(r.mine)}" title="${tip}">${chip}</button>`
      : `<span title="${tip}">${chip}</span>`;
  }).join('');
  const editing = state.editing?.id === id;
  // Your own messages: ✎ edits them in place, as they were sent (as you, or as the app).
  const pen = canEdit(m) && !editing
    ? `<button class="edit" data-edit="1" title="${m.editable === 'app' ? 'Edit, as the bot' : 'Edit your message'}" aria-label="Edit">✎</button>` : '';
  const picks = can ? `${QUICK.map((n) => {
    const mine = (m.reactions || []).some((r) => r.mine && emoji(r.emoji) === emoji(n));
    return `<button data-pick="${n}" aria-pressed="${mine}" title="${esc(`${emoji(n)} ${SIGNAL_HINT[n] || `:${n}:`}${mine ? ' · click to take yours off' : ''}`)}">${emoji(n)}</button>`;
  }).join('')}<button class="more" data-picker="1" aria-haspopup="true" aria-expanded="false" title="More reactions">☺</button>` : '';
  const quick = (can && !editing) || pen ? `<div class="quick" role="toolbar" aria-label="${can ? 'React, as you' : 'Message actions'}">${pen}${editing ? '' : picks}</div>` : '';
  // The editor's text is set when it is shown (wireEditor), so typing does not change the HTML.
  const bubble = editing
    ? `<div class="bubble editing"><ul class="mentions" id="edit-mention-list" role="listbox" hidden></ul><textarea class="editbox" rows="1" role="combobox" aria-autocomplete="list" aria-controls="edit-mention-list" aria-expanded="false" aria-label="Edit the message"></textarea>
      <div class="edithint">Enter to save · Esc to cancel${m.editable === 'app' ? ' · as the bot' : ''} <button data-edit-save="1">Save</button> <button data-edit-cancel="1">Cancel</button></div></div>`
    : `<div class="bubble">${m.deletedAt ? 'This message was deleted.' : md(m.body, m.thread)}${m.pending && m.files?.length ? pendingFiles(m.files) : ''}</div>`;
  const notes = [m.saving ? 'saving…' : '', m.editedAt && !m.pending ? '(edited)' : ''].filter(Boolean).join(' ');
  return `<div class="msg ${adobe ? 'adobe' : ''} ${own ? 'mine' : ''} ${cont ? 'cont' : ''} ${followed ? 'followed' : ''} ${m.deletedAt ? 'deleted' : ''} ${m.pending ? 'pending' : ''} ${editing ? 'editing' : ''} ${enter}" data-id="${esc(id)}">
    ${face}
    <div class="col">${quick}<div class="who">${who}</div>
      ${bubble}
      ${rx ? `<div class="rx">${rx}</div>` : ''}
      ${notes ? `<div class="meta"${m.editedAt ? ` title="Edited ${esc(new Date(m.editedAt).toLocaleString())}"` : ''}>${notes}</div>` : ''}${m.pending ? sendState(m) : ''}
    </div></div>`;
}

// ---------------------------------------------------------------- the thread agent
// Its latest turn, under the last message (GET /api/agent): what it is doing while it works,
// its note for the team once done: its thinking. Asked when a thread opens or changes, and
// every few seconds while it works, or while a new message waits for it to start. Not where
// you hide it (your settings: `traces`, and `channelTraces` by channel, which wins). Its
// avatar and name open the agent settings of the thread's team, at the thread's channel.
const AGENT_NAME = 'Thread Agent';
const AGENT_POLL_MS = 4000;
const AGENT_WAIT_MS = 2 * 60 * 1000;

/** The open thread's row (its channel, its team), from the thread as it was fetched. */
const threadRow = (key) => state.cache.get(key)?.data?.thread || null;

/** Whether you see the agent's thinking in a channel: its own setting, else yours everywhere. */
function tracesShown(channel) {
  const own = state.settings?.channelTraces?.[channel];
  return typeof own === 'boolean' ? own : state.settings?.traces !== false;
}

/** The agent settings of the thread's team, at its channel (ui/kb.js). */
function agentHref(key) {
  const t = threadRow(key);
  const team = t?.team || (!personal() && state.team) || null;
  if (!team) return null;
  const q = new URLSearchParams({ team, view: 'agents' });
  if (t?.channel_id) q.set('channel', t.channel_id);
  return `/inbox/kb?${q}`;
}

function agentItem(key) {
  const { turn, latest } = state.agents.get(key) || {};
  if (!turn) return '';
  if (!tracesShown(threadRow(key)?.channel_id)) return '';
  // A note is about the thread as it was: someone posted since (or is sending), it is gone.
  if (turn.state !== 'working' && latest && latest > (turn.endedAt || turn.startedAt)) return '';
  const body = turn.state === 'working' ? `<span class="spin" aria-hidden="true"></span>${esc(turn.text)}…` : md(turn.text);
  const label = turn.state === 'working' ? 'The thread agent is working' : 'The thread agent\'s note on its latest turn';
  const href = agentHref(key);
  const team = threadRow(key)?.team;
  const teamName = state.teams?.find((t) => t.slug === team)?.name || team;
  const tip = `${AGENT_NAME}'s settings${teamName ? ` in ${teamName}` : ''}`;
  const face = href ? `<a class="face" href="${esc(href)}" title="${esc(tip)}" aria-label="${esc(tip)}">${avatar(AGENT_NAME, '/icon-192.png')}</a>`
    : `<span class="face">${avatar(AGENT_NAME, '/icon-192.png')}</span>`;
  const name = href ? `<a href="${esc(href)}" title="${esc(tip)}" tabindex="-1"><b>${AGENT_NAME}</b></a>` : `<b>${AGENT_NAME}</b>`;
  return `<div class="msg adobe agent ${turn.state === 'done' ? '' : turn.state}" aria-label="${label}"${turn.state === 'working' ? ' aria-live="polite"' : ''}>
    ${face}
    <div class="col"><div class="who">${name}</div><div class="bubble">${body}</div></div></div>`;
}

/** Puts the agent's turn into the open feed (or takes it out), without rebuilding the rest. */
function placeAgent(key) {
  const feed = state.open === key && $('pane').querySelector(':scope > .scroller > .feed');
  if (!feed) return;
  const html = agentItem(key);
  const old = feed.querySelector(':scope > .msg.agent');
  if ((old ? old.__html : '') === html) return;
  const scroller = feed.parentElement;
  const near = nearBottom(scroller);
  if (!html) { old.remove(); return; }
  const node = toNode(html);
  node.__html = html;
  if (old) old.replaceWith(node); else feed.append(node);
  if (near) scroller.scrollTop = scroller.scrollHeight;
}

/** Asks the thread's agent how its latest turn went; keeps asking while it works. */
async function loadAgent(key, { latest = null } = {}) {
  const known = state.agents.get(key);
  clearTimeout(known?.timer);
  // Hidden here: not asked (shown again, renderTraces asks).
  if (!tracesShown(threadRow(key)?.channel_id)) {
    if (known) known.timer = null;
    placeAgent(key);
    return;
  }
  let res;
  try {
    res = await get(`/api/agent?thread=${encodeURIComponent(key)}`);
  } catch {
    return;
  }
  const turn = res.enabled ? res.turn || null : null;
  const last = [latest, known?.latest].filter(Boolean).sort().pop() || null;
  const entry = { turn, latest: last, timer: null };
  state.agents.set(key, entry);
  placeAgent(key);
  // Working, or a message newer than its turn that it has not picked up yet (it waits a few
  // seconds for more): ask again, while the thread stays open.
  const waiting = res.enabled && last && (!turn || turn.startedAt < last) && Date.now() - Date.parse(last) < AGENT_WAIT_MS;
  if (turn?.state === 'working' || waiting) {
    // Not while the tab is in the background: asked again once it is shown (visibilitychange).
    entry.timer = setTimeout(() => {
      if (state.open !== key) return;
      if (hidden()) entry.due = true;
      else loadAgent(key);
    }, AGENT_POLL_MS);
  }
}

// ---------------------------------------------------------------- expert finder
// Bottom right of the thread's header: the colleague most worth pulling in and why (GET
// /api/experts, src/experts.js), with more in a dropdown. Picking one mentions them in the reply
// box, as picking them after @ does; what is sent stays the person's to write.
const expertLine = (e) => (e.suggested ? `Agent suggests ${e.name}` : `${e.name} ${e.reasons[0] || ''}`);

function expertsHtml(key) {
  const list = state.experts.get(key);
  if (!list?.length) return '<div class="experts" id="experts" hidden></div>';
  const open = state.expertsOpen === key;
  const top = list[0];
  // ✕ only where a reject can be recorded, and then ▾ even for one, so each can be rejected.
  const rejectable = expertsRecordable(key);
  const more = list.length > 1 || rejectable ? `<button class="more" data-experts-more aria-haspopup="listbox" aria-expanded="${open}" aria-label="${list.length > 1 ? 'More colleagues to pull in' : 'About this colleague'}" title="${list.length > 1 ? 'More colleagues' : 'Why them, or not the right person'}">▾</button>` : '';
  const reject = (e, i) => (rejectable ? `<button class="reject" data-expert-reject="${i}" title="Not the right person for this thread" aria-label="${esc(e.name)} is not the right person for this thread">✕</button>` : '');
  const rows = open ? `<ul class="expertlist" role="listbox" aria-label="Colleagues to pull in">${list.map((e, i) => `<li role="option" aria-selected="false"><button data-expert="${i}">${avatar(e.name, e.avatar)}<span><b>${esc(e.name)}</b><small>${e.suggested ? `Agent: ${esc(e.reasons[0])}` : esc(e.reasons.join(' · '))}</small></span></button>${reject(e, i)}</li>`).join('')}</ul>` : '';
  return `<div class="experts" id="experts"><button class="top" data-expert="0" title="${esc(top.reasons.join(' · '))}. Mention them in your reply">${avatar(top.name, top.avatar)}<span>${esc(expertLine(top))}</span></button>${more}${rows}</div>`;
}

/** Puts the list on screen without touching the rest of the header. */
function placeExperts(key) {
  if (state.open !== key) return;
  $('experts')?.replaceWith(toNode(expertsHtml(key)));
  wireExperts(key);
}

/**
 * A better finder learns from what is done with its lists (POST /api/experts/event,
 * src/expertevents.js): each list the Worker computed has an id (`list`), and the page says when
 * it is `shown` in the open thread, its ▾ list is `open`ed, someone is `pick`ed, and when the ▾
 * list is closed or left with nobody picked (`dismiss`). Not while viewing as someone else.
 */
function expertEvent(key, action, account) {
  const list = state.expertLists.get(key);
  if (!expertsRecordable(key)) return Promise.resolve(false);
  return fetch('/api/experts/event', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    body: JSON.stringify({ list, action, ...(account ? { account } : {}) }),
  }).then((res) => res.ok, () => false);
}

/** Whether what is done with the thread's list can be recorded: it has an id, and I am me. */
function expertsRecordable(key) {
  return !state.as && !state.data?.me?.readonly && Boolean(state.expertLists?.get(key));
}

/** Says a list is on screen: once each time a thread is opened, and again when it changes. */
function expertsShown(key) {
  const seen = `${key}|${state.expertLists.get(key)}`;
  if (state.open !== key || !state.experts.get(key)?.length || state.expertsSeen === seen) return;
  state.expertsSeen = seen;
  expertEvent(key, 'shown');
}

/** `fresh` when the thread was just opened (not a new message in it). */
async function loadExperts(key, fresh = false) {
  // Left for another thread with the ▾ list open: nobody was picked.
  if (state.expertsOpen && state.expertsOpen !== key) dismissExperts();
  if (fresh) state.expertsSeen = null;
  wireExperts(key);
  if (state.experts.has(key) && state.expertsAt?.get(key) === threadRow(key)?.last_at) {
    expertsShown(key);
    return;
  }
  let res;
  try {
    res = await get(`/api/experts?thread=${encodeURIComponent(key)}`);
  } catch {
    return; // the header works without it
  }
  const same = JSON.stringify(state.experts.get(key)) === JSON.stringify(res.experts);
  state.experts.set(key, res.experts);
  state.expertsAt.set(key, threadRow(key)?.last_at);
  state.expertLists.set(key, res.list || null);
  if (!same) placeExperts(key);
  expertsShown(key);
}

/** The ▾ list goes away with nobody picked from it. */
function dismissExperts() {
  const key = state.expertsOpen;
  if (!key) return;
  state.expertsOpen = null;
  expertEvent(key, 'dismiss');
}

/** Writes @Name into the reply box, where the caret is, and remembers the account. */
function pullExpert(key, e) {
  const box = $('reply');
  if (!box) {
    toast('There is no reply box here to mention them in.');
    return;
  }
  const at = document.activeElement === box ? box.selectionStart : box.value.length;
  const before = box.value.slice(0, at);
  const insert = `${before && !/\s$/.test(before) ? ' ' : ''}@${e.name} `;
  if (!mentionsIn(key, box.value).some((m) => m.id === e.id)) {
    box.value = before + insert + box.value.slice(at);
    box.setSelectionRange(at + insert.length, at + insert.length);
    if (!mention.picked.has(key)) mention.picked.set(key, new Map());
    mention.picked.get(key).set(e.name, e);
    mention.names.add(e.name);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  box.focus();
}

/**
 * "Not the right person": they leave the list, and the finder leaves them out of my lists of
 * this thread from then on (a `reject`, which the training learns from too).
 */
async function rejectExpert(key, i, button) {
  const expert = state.experts.get(key)?.[i];
  if (!expert || button?.disabled) return;
  if (button) button.disabled = true;
  // Only once the Worker has it: until then, they would be back on the next load.
  if (!await expertEvent(key, 'reject', expert.id)) {
    if (button) button.disabled = false;
    toast(`Couldn’t save that ${expert.name} is not the right person. Try again.`);
    return;
  }
  const rest = (state.experts.get(key) || []).filter((e) => e.id !== expert.id);
  state.experts.set(key, rest);
  if (!rest.length) state.expertsOpen = null;
  placeExperts(key);
  const rows = document.querySelectorAll('#experts .expertlist [data-expert]');
  (rows[Math.min(i, rows.length - 1)] || document.querySelector('#experts .top'))?.focus();
  toast(`${expert.name} won’t be suggested to you for this thread again.`);
}

function closeExperts(key, focus = false) {
  if (state.expertsOpen !== key) return;
  dismissExperts();
  placeExperts(key);
  if (focus) document.querySelector('#experts .more')?.focus();
}

function wireExperts(key) {
  const el = $('experts');
  if (!el) return;
  el.onclick = (e) => {
    const pick = e.target.closest('[data-expert]');
    const reject = e.target.closest('[data-expert-reject]');
    if (reject) {
      rejectExpert(key, Number(reject.dataset.expertReject), reject);
    } else if (e.target.closest('[data-experts-more]')) {
      if (state.expertsOpen === key) {
        dismissExperts();
      } else {
        state.expertsOpen = key;
        expertEvent(key, 'open');
      }
      placeExperts(key);
      const rows = document.querySelectorAll('#experts .expertlist [data-expert]');
      (rows[1] || rows[0])?.focus();
    } else if (pick) {
      const expert = state.experts.get(key)?.[Number(pick.dataset.expert)];
      state.expertsOpen = null;
      placeExperts(key);
      if (expert) {
        expertEvent(key, 'pick', expert.id);
        pullExpert(key, expert);
      }
    }
  };
  el.onkeydown = (e) => {
    if (state.expertsOpen !== key) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeExperts(key, true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...el.querySelectorAll('.expertlist [data-expert]')];
    const i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
  };
}

/**
 * The line of the thread's shared draft (filled by renderDraftBar), under the reply box: the
 * box grows upwards as it shows the draft, so the line stays under the pointer.
 */
const DRAFT_LINE = '<div class="draftbar" id="draftbar" hidden></div>';

// Only a touch screen, no pointer that hovers (phones): no Shift+Enter on the on-screen
// keyboard, so Enter starts a new line there and Send sends, as in the Slack and Teams apps.
const TOUCH_ONLY = matchMedia('(any-hover: none)');

function composer(thread, resolve = '') {
  if (state.data?.me?.readonly) return `<div class="composer"><span class="connect">Viewing as ${esc(state.data.me.name)}: read-only.</span>${DRAFT_LINE}</div>`;
  const p = thread.source;
  const name = accountOf(p);
  if (p === 'discord') {
    // Discord lets only bots post through its API, and opspile posts as the person or not at
    // all: the reply is written in Discord. Connecting the account makes its posts count as yours.
    const link = state.me.connectable?.discord && !state.me.connected?.discord
      ? ' <a href="/api/auth/discord/start">Connect your Discord account</a> so the inbox knows which posts are yours.' : '';
    return `<div class="composer"><span class="connect">Replies to Discord are written in Discord: ${backlink(thread, 'reply in Discord ↗')}.${link}</span>${DRAFT_LINE}</div>`;
  }
  if (!state.me.connected?.[p]) {
    return `<div class="composer"><span class="connect">To reply as yourself, <a href="/api/auth/${p}/start">connect your ${name} account</a>.</span>${DRAFT_LINE}</div>`;
  }
  return `<div class="composer"><ul class="mentions" id="mention-list" role="listbox" hidden></ul>
    <div class="tray" id="tray" hidden></div>${attachButton(thread)}
    <textarea id="reply" rows="1" role="combobox" aria-autocomplete="list" aria-controls="mention-list" aria-expanded="false"
      placeholder="Reply in thread"></textarea>
    <span class="sendwrap"><span class="hold" id="hold" hidden><button class="savedraft" id="savedraft" title="Save as the thread's draft: everyone on the team sees it, and can send it (⌘S)">✎ Save draft</button>${resolve}</span><button class="send" id="send">Send</button></span>${DRAFT_LINE}</div>`;
}

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

/** Resolves once the next frame has been painted (at once in a hidden tab, which paints none). */
const afterPaint = () => new Promise((resolve) => {
  if (document.visibilityState !== 'visible') { resolve(); return; }
  requestAnimationFrame(() => setTimeout(resolve, 0));
  setTimeout(resolve, 100);
});

/**
 * Shows a thread in the pane: header, review panel, feed, reply box. Showing the same thread
 * again (a live update, a reaction, a refresh) patches it: only the parts and messages whose
 * HTML changed are rebuilt, so the rest keeps its DOM (images, the reply box and its focus,
 * the scroll position), and an unchanged thread costs next to nothing.
 */
function renderPane(pane, key, {
  head, review, items, reply, patch,
}) {
  const feed = patch && pane.__key === key && pane.querySelector(':scope > .scroller > .feed');
  const enter = (node, item) => { if (item.enter) node.classList.add('enter'); return node; };
  const make = (html) => { const node = toNode(html); node.__html = html; return node; };
  if (!feed) {
    pane.innerHTML = `${head}<div class="scroller">${review}<div class="feed">${items.map((i) => i.html).join('')}</div></div>${reply}`;
    pane.__key = key;
    const [ph, scroller, box] = pane.children;
    ph.__html = head;
    box.__html = reply;
    if (review) scroller.firstElementChild.__html = review;
    const nodes = [...scroller.lastElementChild.children];
    if (nodes.length === items.length) nodes.forEach((n, i) => { n.__html = items[i].html; enter(n, items[i]); });
    return;
  }
  const ph = pane.querySelector(':scope > .ph');
  if (ph.__html !== head) ph.replaceWith(make(head));
  const rv = feed.parentElement.querySelector(':scope > .rv');
  if ((rv ? rv.__html : '') !== review) {
    rv?.remove();
    if (review) feed.before(make(review));
  }
  // Feed items by their HTML: unchanged ones stay, new and changed ones are built.
  const spare = new Map();
  for (const n of feed.children) {
    if (!spare.has(n.__html)) spare.set(n.__html, []);
    spare.get(n.__html).push(n);
  }
  const nodes = items.map((item) => spare.get(item.html)?.shift() || enter(make(item.html), item));
  const keep = new Set(nodes);
  [...feed.children].forEach((n) => { if (!keep.has(n)) n.remove(); });
  nodes.forEach((n, i) => { if (feed.children[i] !== n) feed.insertBefore(n, feed.children[i] || null); });
  const box = pane.querySelector(':scope > .composer');
  if (!box || box.__html !== reply) {
    const node = make(reply);
    if (box) box.replaceWith(node); else pane.append(node);
  }
}

async function openThread(key, { live = false, cached = false } = {}) {
  const switching = state.open !== key;
  // Opened from the list, not from another thread: the entry before this one shows the list.
  const fromList = !state.open;
  state.open = key;
  Object.assign(state, { compose: null, awaiting: null });
  syncReading();
  if (switching) prefetchAround(key);
  if (switching) toUrl(true, fromList ? { list: true } : null);
  renderThreads();
  const pane = $('pane');
  const prevScroller = pane.querySelector('.scroller');
  const wasNear = prevScroller ? nearBottom(prevScroller) : true;
  const keepTop = prevScroller ? prevScroller.scrollTop : 0;
  // A draft shown in the reply box on hover gives the box back first: what it held is what counts.
  if (switching) hideSource();
  endDraftPreview();
  const typed = $('reply')?.value;
  const focused = document.activeElement === $('reply');
  const caret = focused ? [$('reply').selectionStart, $('reply').selectionEnd] : null;
  if (!live && !state.cache.get(key)) pane.innerHTML = '<div class="empty">Loading…</div>';
  let data;
  const hit = (!live || cached) && state.cache.get(key);
  try {
    // A thread being fetched ahead is waited for, not fetched a second time.
    const ahead = !hit && !live && inflight.get(key);
    data = hit ? hit.data : ((ahead && await ahead) || await get(threadUrl(key)));
  } catch (e) {
    pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  // Opened from the cache: let the selected row paint first, then render the thread (the
  // click or key press is answered in one frame, not after the whole thread is built).
  if (hit && switching) {
    await afterPaint();
    if (state.open !== key) return;
  }
  state.cache.set(key, { data, at: hit ? hit.at : Date.now() });
  // A member of a folded group (a root re-threaded after it was opened, or a link to it): its
  // group is the inbox entry, so open that instead of showing the member on its own.
  const entryKey = data.thread?.thread;
  if (entryKey && entryKey !== key) {
    state.cache.delete(key);
    state.cache.set(entryKey, { data, at: hit ? hit.at : Date.now() });
    if (state.open !== key) return;
    // What was typed or is being sent there belongs to the entry now.
    if (state.composers.has(key) && !state.composers.has(entryKey)) state.composers.set(entryKey, state.composers.get(key));
    state.composers.delete(key);
    for (const p of state.sending) if (p.thread === key) p.thread = entryKey;
    state.open = entryKey;
    toUrl(false);
    // The group has messages the member did not: shown as opened, not as new arrivals.
    await openThread(entryKey, { cached: true });
    return;
  }
  mergeProfiles(data.profiles);
  // Shown from the preload: fetch the current state behind it.
  if (hit && !cached && Date.now() - hit.at > 5000) setTimeout(() => { if (state.open === key) openThread(key, { live: true }); }, 0);
  const { thread, members = [], messages, watermarks, model, reviews, facts, resolution } = data;
  if (state.open !== key) return;
  const group = members.length > 1;
  const t = searchEntry(key) || {};
  // Where I was: the last time I had read any member of this entry.
  const myRead = watermarks.filter((w) => w.person === state.me.id).map((w) => w.read_at).sort().pop() || null;
  const ids = new Set(messages.map((m) => `${m.thread}|${m.id}`));
  // Replies I sent that have not arrived yet: a reply has arrived once a message has the id
  // the platform gave it, or (no id) my text, compared loosely, because the platform rewrites
  // it (emoji as :shortcodes:, Slack's *bold* and _italics_, mentions). One still on its way,
  // or that failed, stays; one the platform took, for a minute at most.
  const settled = new Set();
  state.sending = state.sending.filter((p) => {
    if (p.status === 'sending' || p.status === 'failed') return true;
    if (Date.now() - p.sentAt >= 60000) return false;
    if (p.thread !== key) return true;
    const m = messages.find((x) => (p.postedId ? String(x.id) === String(p.postedId)
      : x.author?.name === p.author.name
        && looseText(p.files?.length ? withoutAttachments(x.body) : x.body) === looseText(p.body)));
    if (m) settled.add(`${m.thread}|${m.id}`);
    return !m;
  });
  // Arrivals come up into view, but not a reply taking the place of its bubble, which looks
  // the same, nor that bubble again when it changes (its bar is through, or it failed).
  const fresh = (m) => (m.pending ? m.fresh : live && state.shownIds
    && !state.shownIds.has(`${m.thread}|${m.id}`) && !settled.has(`${m.thread}|${m.id}`));
  // Edits saved here and not back from the platform yet show their new text, until a message
  // has it (compared loosely, as replies are), is edited after it, or a minute has passed.
  for (const [id, e] of state.edits) {
    const m = messages.find((x) => `${x.thread}|${x.id}` === id);
    if (!m) { if (Date.now() - e.sentAt > 60000) state.edits.delete(id); continue; }
    if (Date.now() - e.sentAt > 60000 || (!e.saving && (looseText(m.body) === looseText(e.body)
      || (m.editedAt && Date.parse(m.editedAt) >= e.sentAt - 2000)))) state.edits.delete(id);
  }
  const withEdit = (m) => {
    const e = state.edits.get(`${m.thread}|${m.id}`);
    return e ? { ...m, body: e.body, editedAt: new Date(e.sentAt).toISOString(), saving: e.saving } : m;
  };
  const sending = state.sending.filter((p) => p.thread === key);
  const shown = [...messages.map(withEdit), ...sending.map((p) => ({ ...p, pending: true, fresh: !p.shown }))];
  for (const p of sending) p.shown = true;
  // Who they are: the server's answer for the names the messages mention, then what the
  // thread's authors, the inbox's people, the picked mentions and the replies being sent say.
  const kinds = new Map(Object.entries(data.mentioned || {}));
  const known = (name, kind) => { if (name && kind && !kinds.has(name)) kinds.set(name, kind); };
  for (const m of shown) {
    const a = m.author || {};
    if (a.kind === 'system') continue;
    known(a.name, state.profiles.get(m.authorKey)?.relation || (a.kind === 'bot' ? 'bot' : (a.staff ? 'adobe' : 'customer')));
  }
  for (const p of Object.values(state.data?.people || {})) known(p.name, p.relation || (p.staff ? 'adobe' : null));
  for (const p of mention.picked.get(key)?.values() || []) known(p.name, pickedKind(p));
  for (const p of sending) for (const [name, kind] of Object.entries(p.kinds || {})) known(name, kind);
  setChannelRefs(data.channels);
  setMentionNames([
    ...shown.map((m) => m.author?.name),
    ...Object.values(state.data?.people || {}).map((p) => p.name),
    ...mention.names,
    ...kinds.keys(),
  ], kinds);
  // The feed, one element per item; `enter` marks the messages that just arrived.
  const items = thread.root_at ? [] : [{ html: '<div class="sys">Earlier messages were posted before the inbox started listening.</div>' }];
  let prev = null;
  let day = null;
  // A message's markup waits for the next one: the avatar goes beside the last of a run.
  let last = null;
  shown.forEach((m, i) => {
    if (dayLabel(m.at) !== day) { day = dayLabel(m.at); items.push({ html: `<div class="day"><span>${esc(day)}</span></div>` }); prev = null; }
    if (group && prev && prev.thread !== m.thread) { items.push({ html: `<div class="post">new post · ${clock(m.at)}</div>` }); prev = null; }
    if (!group && i === 1 && thread.root_at && messages.length > 1) { items.push({ html: `<div class="divider">${messages.length - 1} ${messages.length === 2 ? 'reply' : 'replies'}</div>` }); prev = null; }
    if (last && continues(prev, m)) last.item.html = message(last.m, last.prev, false, true);
    const item = { html: message(m, prev, false), enter: fresh(m) };
    items.push(item);
    last = { item, m, prev };
    prev = m;
  });
  // The newest message, counting the ones being sent: newer than the agent's note hides it.
  const latest = shown.reduce((at, m) => (m.at > at ? m.at : at), '') || null;
  const agent = state.agents.get(key);
  if (agent) agent.latest = latest;
  const agentHtml = agentItem(key);
  if (agentHtml) items.push({ html: agentHtml });
  // Sites as links (main--site--org.aem.live), tickets and CVEs as chips, and the tech the
  // channel is known to use.
  const sites = facts.filter((f) => f.field === 'site').map((f) => {
    const [org, site] = f.value.split('/');
    const host = `main--${site}--${org}.aem.live`;
    return `<a class="back" href="https://${esc(host)}/" target="_blank" rel="noopener">${esc(host)}</a>`;
  }).join(' ');
  const chips = facts.filter((f) => f.field === 'ticket' || f.field === 'cve').map((f) => `<span class="tag">${esc(f.value)}</span>`).join('');
  const stack = [
    ...(data.topics || []).map((x) => `<span class="tag topic" title="Topic">${esc(data.vocab?.topics?.[x] || x)}</span>`),
    ...(data.tech || []).map((x) => `<span class="tag tech" title="${Math.round(x.p * 100)}%">${esc(data.vocab?.tech?.[x.tech] || x.tech)}</span>`),
  ].join('');
  const head = `<div class="ph"><button class="close" data-close title="Back to the threads" aria-label="Back to the threads">${BACK}</button><h2>${emojify(channelNames(thread.title) || '(no text)')} ${backlink(thread, `Open in ${platform(thread)} ↗`)}</h2>
      <div class="sub">${orgIcon({ ...t, ...thread }) ? `<img src="${esc(favicon(orgIcon({ ...t, ...thread })))}" alt="">` : ''}<span>${esc(orgName(thread))}</span>${ORG_TYPE[thread.org_type] ? ` <span class="tag">${ORG_TYPE[thread.org_type]}</span>` : ''} ·
        <span>${esc(thread.channel_name || '')}</span>
        ${group ? `· <span class="tag">${members.length} posts folded into one thread</span>` : ''}
        ${sites ? `· ${sites}` : ''} ${chips} ${resolveNote(resolution)}</div>
      ${stack ? `<div class="sub stack">${stack}</div>` : ''}${expertsHtml(key)}</div>`;
  const review = state.review && state.me.admin && model ? reviewPanel({ thread: thread.label_thread || thread.thread }, model, reviews) : '';
  const reply = composer(thread, resolveButton(thread, resolution));
  renderPane(pane, key, {
    head, review, items, reply, patch: !switching,
  });
  restorePreviews(pane);
  state.shownIds = ids;
  cardGone();
  loadAgent(key, { latest });
  loadExperts(key, switching);
  const scroller = pane.querySelector('.scroller');
  if (live && !switching) {
    // New messages scroll up into view if I was at the bottom; otherwise stay put.
    scroller.scrollTop = keepTop;
    if (wasNear) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  } else {
    // Opened from a search result: at the message that matched, marked for a moment.
    const jump = state.jump?.key === key ? state.jump : null;
    state.jump = null;
    const found = jump && scroller.querySelector(`[data-id="${CSS.escape(jump.id)}"]`);
    const firstUnread = myRead && messages.find((m) => m.at > myRead && m.author?.name !== state.me.name);
    const el = found || (firstUnread && scroller.querySelector(`[data-id="${CSS.escape(`${firstUnread.thread}|${firstUnread.id}`)}"]`));
    if (el) scroller.scrollTop = Math.max(0, el.offsetTop - scroller.offsetTop - 80);
    else scroller.scrollTop = scroller.scrollHeight;
    if (found) { found.classList.add('found'); setTimeout(() => found.classList.remove('found'), 2400); }
  }
  wireEditor(key);
  const box = $('reply');
  if (box) {
    const c = composerFor(key, data.draft);
    box.value = c.text;
    if (focused && !switching) { box.focus(); if (typed === c.text) box.setSelectionRange(...caret); }
    const grow = () => growReply(box);
    box.oninput = () => {
      // Saving, loading or discarding replaces the thread's composer state: update the current one.
      const now = state.composers.get(key);
      if (now) now.text = box.value; else state.composers.set(key, { text: box.value, from: '', base: null });
      grow(); suggest(key); renderDraftBar(key);
    };
    box.onclick = () => suggest(key);
    box.onblur = () => setTimeout(closeMentions, 150);
    grow();
    box.onkeydown = (e) => {
      // Typing while the pointer rests on the draft line: the box is yours again, until the
      // pointer comes back to the line.
      if (draftPreview.key || draftPreview.over) {
        Object.assign(draftPreview, { over: false, focus: false });
        endDraftPreview();
      }
      if (mentionKey(e, key)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH_ONLY.matches) { e.preventDefault(); send(key, thread); }
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); saveDraft(key, box.value, undefined, { fromBox: true }); }
    };
    $('send').onclick = (e) => { if (!sendHold.held) send(key, thread); e.preventDefault(); };
    wireHoldMenu(key, thread);
    wireAttach(key, thread);
  }
  renderDraftBar(key);
  if (searchEntry(key) && (switching || !live)) markRead(t);
}

// Keeping the pointer on Send for a second (or pressing it for a second on touch) shows
// more ways to send above it: ✎ save the text as the thread's draft, and ✅ resolve (with
// text, it sends the reply first).
const sendHold = { timer: null, hide: null, held: false };
function wireHoldMenu(key, thread) {
  const wrap = document.querySelector('.sendwrap');
  const menu = $('hold');
  const btn = $('resolve');
  const save = $('savedraft');
  if (!wrap || !menu) return;
  const label = () => {
    const text = $('reply')?.value.trim();
    const d = state.cache.get(key)?.data?.draft;
    save.hidden = !text;
    save.textContent = d ? '✎ Update draft' : '✎ Save draft';
    if (!btn) return;
    if (btn.dataset.mine) btn.textContent = '✅ Resolved · undo';
    else btn.textContent = text ? 'Send and ✅ resolve' : '✅ Resolve';
  };
  const show = () => { label(); menu.hidden = save.hidden && !btn; };
  const hide = () => { menu.hidden = true; };
  $('send').onpointerenter = (e) => {
    if (e.pointerType === 'touch') return;
    clearTimeout(sendHold.hide);
    clearTimeout(sendHold.timer);
    sendHold.timer = setTimeout(show, 1000);
  };
  $('send').onpointerdown = (e) => {
    sendHold.held = false;
    if (e.pointerType !== 'touch') return;
    clearTimeout(sendHold.timer);
    sendHold.timer = setTimeout(() => { sendHold.held = true; show(); }, 1000);
  };
  $('send').onpointerup = () => clearTimeout(sendHold.timer);
  $('send').onpointercancel = () => clearTimeout(sendHold.timer);
  // A long press on touch would open the context menu instead.
  $('send').oncontextmenu = (e) => e.preventDefault();
  wrap.onpointerenter = () => clearTimeout(sendHold.hide);
  wrap.onpointerleave = (e) => {
    // A finger leaves as it lifts: the menu it held open stays until a tap elsewhere.
    if (e.pointerType === 'touch') return;
    clearTimeout(sendHold.timer);
    sendHold.hide = setTimeout(hide, 500);
  };
  save.onclick = () => { hide(); saveDraft(key, $('reply')?.value || '', undefined, { fromBox: true }); };
  if (!btn) return;
  btn.onclick = async () => {
    hide();
    if (!btn.dataset.mine && ($('reply')?.value.trim() || state.attachments.get(key)?.length) && !(await send(key, thread))) return;
    toggleResolve();
  };
}

// ---------------------------------------------------------------- drafts
// A thread carries at most one draft, which everyone on the team that owns the channel sees
// and may change, send or discard. It waits on its own line under the reply box, not in it:
// the reply box is yours, and a draft never replaces what you typed. Resting the pointer on
// the line, or moving the keyboard focus into it, shows the draft in the box, in place, and
// gives the box back as it was when the pointer or focus leaves. Clicking the line (tapping
// it, on touch) takes the draft into the box to edit, after anything you had typed there. The
// line also sends the draft as it is: as you, or as the opspile app where the channel lets it
// post. Each thread remembers what you typed in it and did not save (in this tab only). A box
// that took the draft in (`base`, its version) and still holds it unchanged follows it as
// colleagues change or discard it.
/** The composer state of a thread: its text, and the draft version it took in. */
function composerFor(key, draft) {
  let c = state.composers.get(key);
  if (c && c.base && c.text === c.from && c.base !== draft?.updated_at) {
    // It holds the draft unchanged, and the draft changed or went: it follows.
    if (!draft) mention.picked.delete(key);
    c = draft ? takeDraft(key, draft, '') : { text: '', from: '', base: null };
    state.composers.set(key, c);
  }
  if (!c) {
    c = { text: '', from: '', base: null };
    state.composers.set(key, c);
  }
  return c;
}

/** `text` with draft `d` in it: the draft alone in an empty box, else after what is there. */
const withDraft = (text, d) => (text.trim() && text !== d.body ? `${text.trimEnd()}\n\n${d.body}` : d.body);

/** The composer state once draft `d` is taken into `text`; its mentions come along. */
function takeDraft(key, d, text) {
  if (d.mentions?.length) {
    if (!mention.picked.has(key)) mention.picked.set(key, new Map());
    for (const m of d.mentions) {
      mention.picked.get(key).set(m.name, m);
      mention.names.add(m.name);
    }
  }
  return { text: withDraft(text, d), from: d.body, base: d.updated_at };
}

/** The composer took this version of the draft in (and was not emptied since). */
const tookDraft = (c, d) => Boolean(c && d && c.base === d.updated_at && c.text.trim());

function growReply(box) {
  box.style.height = 'auto';
  // The stylesheet's limit: a draft being looked at (.previewing, .checking) may take more room.
  box.style.height = `${Math.min(parseFloat(getComputedStyle(box).maxHeight) || 180, box.scrollHeight)}px`;
}

// The draft shown in the reply box while the pointer rests on its line (`over`) or the
// keyboard focus is in it (`focus`), and what the box held before (`value`, `sel`).
const draftPreview = {
  key: null, value: '', sel: [0, 0], over: false, focus: false,
};
// Threads whose draft line shows all of the draft, not only how it starts.
const draftOpen = new Set();

function startDraftPreview(key) {
  const box = $('reply');
  const d = state.cache.get(key)?.data?.draft;
  if (!box || !d || draftPreview.key || state.open !== key) return;
  if (tookDraft(state.composers.get(key), d)) return;
  const shown = withDraft(box.value, d);
  if (shown === box.value) return;
  Object.assign(draftPreview, { key, value: box.value, sel: [box.selectionStart, box.selectionEnd] });
  closeMentions();
  box.value = shown;
  box.readOnly = true;
  box.classList.add('previewing');
  growReply(box);
  // The draft alone reads from its start; after your text, the box shows where it begins.
  box.scrollTop = shown === d.body ? 0 : box.scrollHeight;
}

/** Gives the reply box back as it was before the draft was shown in it. */
function endDraftPreview() {
  const { key, value, sel } = draftPreview;
  if (!key) return;
  draftPreview.key = null;
  const box = $('reply');
  if (!box?.classList.contains('previewing')) return;
  box.readOnly = false;
  box.classList.remove('previewing');
  if (state.open !== key) return;
  box.value = value;
  box.setSelectionRange(...sel);
  growReply(box);
}

function syncDraftPreview(key) {
  if (draftPreview.over || draftPreview.focus || sourcePop.url) startDraftPreview(key);
  else endDraftPreview();
}

// The sources of a draft: what an agent says the draft rests on, as links on the draft's line.
// Only the inbox has them; a reply never does. Resting the pointer on one, or moving the
// keyboard focus to it, shows the page beside the draft, to check one against the other: in a
// frame where the site allows that, else as Markdown (GET /api/draft/source says which). It
// stays while the pointer is on it. Clicking a source opens it in a new tab, also on touch.
// The popover hangs off the page, not the line, so a live update leaves its frame alone.
const SOURCE_DELAY = 180;
const SOURCE_GRACE = 300;
const SOURCE_SIDE_BY_SIDE = 860; // the pane's width from which a source fits beside the draft
const sourcePop = {
  el: null, key: null, url: null, timer: 0,
};
const sourceViews = new Map(); // `thread\0url` -> the promise of how to show it

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const sourceLink = (u, label, cls = '', attrs = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(u)}" target="_blank" rel="noopener noreferrer"${attrs}>${label}</a>`;

/** The line of a draft's sources, or nothing. */
function sourcesLine(d) {
  if (!d.sources?.length) return '';
  const links = d.sources.map((s, i) => sourceLink(s.url, esc(s.title || hostOf(s.url)), 'src', ` data-source="${i}" title="${esc(s.url)}"`));
  return `<span class="srcs"><span class="lb" title="For checking the draft. Only your team sees them: they are not sent.">Sources</span>${links.join('')}</span>`;
}

function sourceView(key, url) {
  const k = `${key}\u0000${url}`;
  if (!sourceViews.has(k)) {
    sourceViews.set(k, get(`/api/draft/source?thread=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`)
      .catch(() => ({ view: 'none', url, reason: 'The page could not be looked at.' })));
  }
  return sourceViews.get(k);
}

function sourceBody(v) {
  if (v.view === 'frame') {
    // No top navigation, no forms, no cookies of the viewer's: an agent picked this page, and
    // what agents read is written by strangers. The header above it says whose page it is.
    return `<iframe src="${esc(v.url)}" title="The source" sandbox="allow-scripts allow-same-origin allow-popups" credentialless referrerpolicy="no-referrer"></iframe>`;
  }
  if (v.view === 'markdown') return `<div class="bubble">${md(v.text)}</div>`;
  return `<p class="none">${esc(v.reason || 'This page cannot be shown here.')} ${sourceLink(v.url, 'Open it in a new tab')}.</p>`;
}

/** The popover, under the page's body; made when first used. */
function sourcePopEl() {
  if (sourcePop.el) return sourcePop.el;
  const el = document.createElement('section');
  el.className = 'srcpop';
  el.hidden = true;
  el.setAttribute('aria-label', 'Source of the draft');
  el.addEventListener('pointerenter', () => clearTimeout(sourcePop.timer));
  el.addEventListener('pointerleave', leaveSource);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSource();
  });
  addEventListener('resize', hideSource);
  document.body.append(el);
  sourcePop.el = el;
  return el;
}

/** Over the pane: its right half above the draft's line, in a narrow one above the reply box. */
function placeSource(el, under, wide) {
  const pane = $('pane').getBoundingClientRect();
  el.style.left = `${wide ? pane.left + pane.width / 2 : pane.left + 8}px`;
  el.style.right = `${innerWidth - pane.right + 12}px`;
  el.style.top = `${pane.top + 8}px`;
  el.style.bottom = `${innerHeight - under.getBoundingClientRect().top + 6}px`;
}

async function showSource(key, i) {
  clearTimeout(sourcePop.timer);
  const s = state.cache.get(key)?.data?.draft?.sources?.[i];
  const line = $('draftbar');
  if (!s || !line || state.open !== key || sourcePop.url === s.url) return;
  const el = sourcePopEl();
  Object.assign(sourcePop, { key, url: s.url });
  el.innerHTML = `<div class="head"><b>${esc(s.title || hostOf(s.url))}</b><span class="host">${esc(hostOf(s.url))}</span>
    <span class="only">Only your team sees this</span>${sourceLink(s.url, 'Open ↗')}</div>
    ${s.quote ? `<blockquote class="bubble">${md(s.quote)}</blockquote>` : ''}<div class="view"><p class="none">Loading…</p></div>`;
  el.hidden = false;
  const composerEl = line.closest('.composer');
  const wide = $('pane').getBoundingClientRect().width >= SOURCE_SIDE_BY_SIDE;
  composerEl.classList.toggle('checking', wide);
  const box = $('reply');
  if (box) growReply(box);
  syncDraftPreview(key);
  placeSource(el, wide ? line : composerEl, wide);
  const v = await sourceView(key, s.url);
  if (sourcePop.url === s.url) el.querySelector('.view').innerHTML = sourceBody(v);
}

function hideSource() {
  clearTimeout(sourcePop.timer);
  if (!sourcePop.url) return;
  const { key } = sourcePop;
  Object.assign(sourcePop, { key: null, url: null });
  sourcePop.el.hidden = true;
  sourcePop.el.innerHTML = '';
  const box = $('reply');
  $('draftbar')?.closest('.composer')?.classList.remove('checking');
  if (box) growReply(box);
  syncDraftPreview(key);
}

function leaveSource() {
  clearTimeout(sourcePop.timer);
  if (sourcePop.url) sourcePop.timer = setTimeout(hideSource, SOURCE_GRACE);
}

function wireSources(el) {
  el.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const a = e.target.closest('[data-source]');
    if (!a) { leaveSource(); return; }
    clearTimeout(sourcePop.timer);
    sourcePop.timer = setTimeout(() => showSource(el.__key, Number(a.dataset.source)), SOURCE_DELAY);
  });
  el.addEventListener('pointerleave', leaveSource);
  el.addEventListener('focusin', (e) => {
    if (e.target.matches('[data-source]:focus-visible')) showSource(el.__key, Number(e.target.dataset.source));
  });
  el.addEventListener('focusout', (e) => {
    if (!sourcePop.el?.contains(e.relatedTarget)) leaveSource();
  });
}

/** The draft line: who saved the draft, when, how it starts (or all of it), and what to do. */
function renderDraftBar(key, force = false) {
  const el = $('draftbar');
  if (!el || state.open !== key) return;
  const data = state.cache.get(key)?.data;
  // A draft on its way (its reply shows in the feed, sending) is not offered again; it comes
  // back if the reply fails.
  const going = (x) => x && state.sending.some((p) => p.thread === key && p.base === x.updated_at && p.status !== 'failed');
  const d = going(data?.draft) ? null : data?.draft;
  const box = $('reply');
  const readonly = state.data?.me?.readonly;
  const c = state.composers.get(key);
  let html = '';
  if (d) {
    const took = box && tookDraft(c, d);
    const own = box && !took && c?.text.trim();
    const open = draftOpen.has(key);
    let note = '';
    if (took) note = c.text === d.body ? ' · in the reply box' : ' · in the reply box, edited';
    else if (own && c.base) note = ' · changed since you took it';
    const editable = box && !took && !readonly;
    const acts = [];
    if (editable) acts.push(`<button data-draft="edit" title="${own ? 'Add the draft after what you wrote, to edit it' : 'Put the draft in the reply box, to edit it'}">${own ? 'Add to reply' : 'Edit'}</button>`);
    if (box && !readonly) acts.push('<button data-draft="me" class="asme" title="Post the draft in the thread as it is, as you">Send as me</button>');
    if (data.can_post_as_bot) acts.push('<button data-draft="bot" class="asbot" title="Post the draft in the thread as it is, as the bot">Send as bot</button>');
    if (!readonly) acts.push('<button data-draft="discard" title="Throw the draft away, for everyone on the team">Discard</button>');
    const tag = editable ? 'button' : 'span';
    const long = d.body.length > 80 || d.body.includes('\n');
    html = `<span class="pen">✎ Draft</span>
      <${tag} class="pv"${editable ? ` data-draft="edit" title="${own ? 'Hover to see it after your text; click to add it to your reply' : 'Hover to see it in the reply box; click to edit it'}"` : ''}><span class="by">by ${esc(draftBy(d))} · ${ago(d.updated_at)}${note}</span><span class="tx">${esc(d.body)}</span></${tag}>
      ${long ? `<button class="more" data-draft="more" aria-expanded="${open}" title="${open ? 'Show how it starts' : 'Show all of it'}" aria-label="${open ? 'Show less of the draft' : 'Show all of the draft'}">${open ? '▴' : '▾'}</button>` : ''}
      ${acts.length ? `<span class="act">${acts.join('')}</span>` : ''}${sourcesLine(d)}`;
  }
  if (force || el.__html !== html) {
    // A new line under a resting pointer (the reply box was rebuilt) is hovered too.
    if (el.__html === undefined) draftPreview.over = !TOUCH_ONLY.matches && el.matches(':hover');
    el.__html = html;
    el.innerHTML = html;
    el.hidden = !d;
    el.classList.toggle('open', draftOpen.has(key));
    if (!el.contains(document.activeElement)) draftPreview.focus = false;
    // The draft changed while shown in the box: show the new one.
    endDraftPreview();
  }
  if (sourcePop.url && !d?.sources?.some((s) => s.url === sourcePop.url)) hideSource();
  if (d) syncDraftPreview(key); else endDraftPreview();
  el.__key = key;
  if (!el.__wired) wireDraftBar(el);
}

/** What the draft line answers: clicks, the pointer resting on it, focus moving through it. */
function wireDraftBar(el) {
  el.__wired = true;
  wireSources(el);
  const sync = () => syncDraftPreview(el.__key);
  el.addEventListener('click', (e) => {
    const key = el.__key;
    const b = e.target.closest('[data-draft]');
    if (!b || b.disabled) return;
    const act = b.dataset.draft;
    if (act === 'more') {
      if (draftOpen.has(key)) draftOpen.delete(key); else draftOpen.add(key);
      renderDraftBar(key);
      el.querySelector('.more')?.focus();
      return;
    }
    Object.assign(draftPreview, { over: false, focus: false });
    endDraftPreview();
    if (act === 'edit') adoptDraft(key);
    else if (act === 'discard') discardDraft(key);
    else sendDraft(key, act === 'bot');
  });
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    draftPreview.over = true;
    sync();
  });
  el.addEventListener('pointerleave', () => {
    draftPreview.over = false;
    sync();
  });
  el.addEventListener('focusin', (e) => {
    // Keyboard focus, not the focus a click leaves behind.
    draftPreview.focus = e.target.matches(':focus-visible');
    sync();
  });
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return;
    draftPreview.focus = false;
    sync();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !(draftPreview.key || sourcePop.url)) return;
    e.preventDefault();
    Object.assign(draftPreview, { over: false, focus: false });
    hideSource();
    endDraftPreview();
    $('reply')?.focus();
  });
  // The pointer has to stay on the line for the box to show the draft, so the wheel reads it from
  // there (an opened line scrolls its own text).
  el.addEventListener('wheel', (e) => {
    const box = $('reply');
    if (!draftPreview.key || !box || (el.classList.contains('open') && e.target.closest('.pv'))) return;
    e.preventDefault();
    box.scrollTop += e.deltaY;
  }, { passive: false });
}

/** Takes the draft into the reply box, to edit: after what you typed, if anything. */
function adoptDraft(key) {
  const d = state.cache.get(key)?.data?.draft;
  const box = $('reply');
  if (!d || !box || state.open !== key) return;
  endDraftPreview();
  const c = takeDraft(key, d, box.value);
  state.composers.set(key, c);
  box.value = c.text;
  box.dispatchEvent(new Event('input'));
  box.focus();
  box.setSelectionRange(c.text.length, c.text.length);
  box.scrollTop = box.scrollHeight;
}

/** Sends the draft as it is, as you or as the opspile app: that uses it up. */
async function sendDraft(key, asApp) {
  const data = state.cache.get(key)?.data;
  const d = data?.draft;
  if (!d) return;
  $('draftbar')?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  if (asApp) {
    const error = await sendAsApp(key, d.body, d.updated_at, { mentions: d.mentions || [] });
    toast(error ? `Nothing was sent: ${error}.` : 'Sent as the bot.');
  } else {
    await send(key, data.thread, d);
  }
  renderDraftBar(key, true);
}

/** The draft as the inbox list shows it, without fetching the inbox again. */
function setRowDraft(key, d) {
  const t = state.data?.threads.find((x) => x.thread === key);
  if (!t) return;
  t.draft = d ? { by: d.by, updated_at: d.updated_at, preview: d.body.length > 140 ? `${d.body.slice(0, 139)}…` : d.body } : null;
  render();
}
function setCachedDraft(key, d) {
  const hit = state.cache.get(key);
  if (hit) hit.data = { ...hit.data, draft: d };
  setRowDraft(key, d);
  renderDraftBar(key);
}

/**
 * Saves `text` as the thread's draft; `base` is the version it replaces (by default, the one the
 * reply box took in). Saved from the reply box (`fromBox`), the box holds the draft it saved.
 * `sources` replaces the draft's; left out, they stay.
 */
async function saveDraft(key, text, base, { fromBox = false, sources } = {}) {
  if (state.data?.me?.readonly || !text.trim()) return { error: 'nothing to save' };
  const c = state.composers.get(key) || { text, from: '', base: null };
  const res = await request('PUT', '/api/draft', {
    thread: key, text, mentions: mentionsIn(key, text), sources, base: base === undefined ? c.base : base,
  });
  if (res.status === 409 && res.data.draft) {
    // A colleague saved (or changed) it meanwhile: show theirs, and offer to overwrite it.
    setCachedDraft(key, res.data.draft);
    toast(`${res.data.error}.`, { label: 'Overwrite', run: () => saveDraft(key, text, res.data.draft.updated_at, { fromBox, sources }) });
    return { error: res.data.error, conflict: res.data.draft };
  }
  if (!res.ok) {
    const error = res.data.error || `could not save the draft (${res.status})`;
    toast(error);
    return { error };
  }
  const d = res.data.draft;
  // What the box holds now (it may have changed while saving) stays; the draft is the base.
  // Saved from elsewhere (the page's agent), the box is left alone.
  const now = state.composers.get(key);
  if (fromBox) state.composers.set(key, { text: now ? now.text : text, from: text, base: d.updated_at });
  const box = fromBox && state.open === key && $('reply');
  if (box && box.value !== state.composers.get(key).text) {
    box.value = state.composers.get(key).text;
    box.dispatchEvent(new Event('input'));
  }
  setCachedDraft(key, d);
  // In the personal view: the team it is filed under.
  const slug = personal() ? state.data?.threads.find((t) => t.thread === key)?.team : state.team;
  const team = state.data?.teams?.[slug]?.name || 'the team';
  toast(`Draft saved. Everyone in ${team} sees it.`);
  return { ok: true, draft: d };
}

async function discardDraft(key) {
  const d = state.cache.get(key)?.data?.draft;
  if (!d || state.data?.me?.readonly) return;
  const res = await request('DELETE', '/api/draft', { thread: key, base: d.updated_at });
  if (res.status === 409 && res.data.draft) {
    setCachedDraft(key, res.data.draft);
    toast(`${res.data.error}; it is still there.`);
    return;
  }
  if (!res.ok) { toast(res.data.error || `could not discard the draft (${res.status})`); return; }
  const c = state.composers.get(key);
  const held = Boolean(c && c.base && c.text.trim() && c.text === c.from);
  // An untouched composer empties with it; your own text stays.
  if (c && c.text === c.from) {
    state.composers.set(key, { text: '', from: '', base: null });
    mention.picked.delete(key);
    if (state.open === key && $('reply')) { $('reply').value = ''; $('reply').dispatchEvent(new Event('input')); }
  } else if (c) {
    c.base = null;
  }
  setCachedDraft(key, null);
  toast('Draft discarded.', {
    label: 'Undo',
    run: () => {
      // A reply box that held it (and was not written in since) gets it back too.
      const refill = held && !state.composers.get(key)?.text.trim();
      if (refill) state.composers.delete(key);
      saveDraft(key, d.body, null, { fromBox: refill, sources: d.sources });
    },
  });
}

// Sending, as in iMessage: a reply shows at once, as it will look once sent, with a thin bar
// under it that fills while the platform takes it (POST /api/post: 0.3 to 1.5 s). There is no
// real progress to show, so the bar eases towards 90%, completes once the platform has the
// message, and fades. The bubble stays until the message comes back through the platform's
// events, some ten seconds later, looking the same. A reply that failed says why, with Retry.
const SEND_FROM = 0.08;
const SEND_TO = 0.9;
const SEND_EASE_MS = 800;
const SEND_FINISH_MS = 250;
const SEND_FADE_MS = 300;

/**
 * The bar of reply `p` at `now`: how full it is (0 to 1), how visible, and whether it is
 * gone. It starts filling when the request goes out (`startedAt`; replies to one thread go
 * out one by one), and completes from wherever it was when the platform took it (`doneAt`).
 */
function sendBar(p, now) {
  const eased = (ms) => SEND_FROM + (SEND_TO - SEND_FROM) * (1 - Math.exp(-Math.max(0, ms) / SEND_EASE_MS));
  const at = (t) => (p.startedAt ? eased(t - p.startedAt) : SEND_FROM);
  if (!p.doneAt) return { fill: at(now), opacity: 1, over: false };
  const from = at(p.doneAt);
  const t = now - p.doneAt;
  const k = Math.min(1, t / SEND_FINISH_MS);
  return {
    fill: from + (1 - from) * (1 - (1 - k) ** 2),
    opacity: 1 - Math.min(1, Math.max(0, (t - SEND_FINISH_MS) / SEND_FADE_MS)),
    over: t >= SEND_FINISH_MS + SEND_FADE_MS,
  };
}

/**
 * What goes under a reply being sent: the bar (the same markup from start to end, so the
 * feed keeps its node while the bar fills), why it failed, or nothing once it is through.
 */
function sendState(p) {
  if (p.status === 'failed') {
    return `<div class="unsent" role="alert"><span class="why">Not sent: ${esc(p.error)}</span>
      <button data-retry="${esc(p.id)}">Retry</button><button data-unsend="${esc(p.id)}" title="Throw the reply away">Discard</button></div>`;
  }
  if (p.status !== 'sending' && p.status !== 'sent') return '';
  return `<div class="sendbar" data-send="${esc(p.id)}" role="progressbar" aria-label="Sending" aria-valuemin="0" aria-valuemax="100"><i></i></div>`;
}

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
// Replies to a thread go out in the order they were written: each waits for the one before.
const sendQueue = new Map();
let sendSeq = 0;
let sendFrame = 0;

/**
 * How the viewer's messages on `source` look (their name there, avatar and account), from
 * the latest one opspile has, this thread's first: a reply being sent looks the same.
 */
function ownLook(key, source) {
  const lists = [key, ...state.cache.keys()].map((k) => state.cache.get(k)?.data?.messages || []);
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m.mine && m.source === source && m.author?.kind === 'person' && !m.deletedAt) {
        return { author: m.author, avatar: m.avatar || null, authorKey: m.authorKey || null };
      }
    }
  }
  return { author: { kind: 'person', name: state.me.name, staff: true }, avatar: null, authorKey: null };
}

/** Shows the thread's replies being sent as they are now, if it is open. */
function showSending(key) {
  if (state.open === key && state.cache.get(key)) openThread(key, { live: true, cached: true });
}

/** Fills the bars, one frame at a time, while any are on their way. */
function animateSending() {
  if (sendFrame || REDUCED_MOTION.matches) return;
  const frame = () => {
    sendFrame = 0;
    const now = Date.now();
    const through = new Set();
    let more = false;
    for (const p of state.sending) {
      if (p.status !== 'sending' && p.status !== 'sent') continue;
      const look = sendBar(p, now);
      if (look.over) {
        p.status = 'delivered';
        through.add(p.thread);
        continue;
      }
      more = true;
      for (const el of document.querySelectorAll(`.sendbar[data-send="${CSS.escape(p.id)}"]`)) {
        el.style.setProperty('--p', look.fill.toFixed(4));
        el.style.opacity = look.opacity.toFixed(3);
        el.setAttribute('aria-valuenow', String(Math.round(look.fill * 100)));
      }
    }
    for (const key of through) showSending(key);
    if (more) sendFrame = requestAnimationFrame(frame);
  };
  sendFrame = requestAnimationFrame(frame);
}

/** Posts reply `p` once the thread's replies before it are out. Resolves to whether it went. */
function postPending(p) {
  const key = p.thread;
  const run = (sendQueue.get(key) || Promise.resolve()).catch(() => {}).then(() => deliver(p));
  sendQueue.set(key, run);
  run.finally(() => { if (sendQueue.get(key) === run) sendQueue.delete(key); });
  return run;
}

async function deliver(p) {
  Object.assign(p, {
    status: 'sending', startedAt: Date.now(), doneAt: null, error: null,
  });
  animateSending();
  let res = null;
  let data = {};
  try {
    // With files, as multipart (src/attach.js).
    res = await postWith('/api/post', { thread: p.thread, text: p.body, mentions: p.mentions, ...(p.base ? { draft: p.base } : {}) }, p.uploads || []);
    data = res.data || {};
  } catch { /* offline, or the connection dropped */ }
  if (!res?.ok) {
    p.status = 'failed';
    p.error = data.error || (res?.status ? `could not send (${res.status})` : 'could not reach the inbox');
    state.sendError = p.error;
    if (data.connect) state.me.connected = { ...state.me.connected, [data.connect]: false };
    // The account may upload once it is connected again with file access.
    const again = data.files && (data.reconnect || data.connect);
    if (again) toast(p.error, { label: 'Connect again', href: `/api/auth/${again}/start?files=1` });
    // Somewhere else by now: say so there.
    if (state.open !== p.thread) toast(`A reply was not sent: ${p.error}`, { label: 'Show', run: () => openThread(p.thread) });
    // The reply box offers to connect the account.
    if (data.connect && state.open === p.thread) openThread(p.thread, { live: true });
    else showSending(p.thread);
    return false;
  }
  const now = Date.now();
  // The reply as sent: emoji names as the platform knows them (src/shortcodes.js), e.g. the
  // emoji Clef picked for a name nobody has.
  const reworded = typeof data.text === 'string' && data.text !== p.body;
  Object.assign(p, {
    body: reworded ? data.text : p.body, postedId: data.id || null, sentAt: now, doneAt: now, status: REDUCED_MOTION.matches ? 'delivered' : 'sent',
  });
  if (p.base && state.cache.get(p.thread)?.data?.draft?.updated_at === p.base) setCachedDraft(p.thread, null);
  if (p.status === 'delivered' || reworded) showSending(p.thread);
  if (p.status !== 'delivered') animateSending();
  return true;
}

/**
 * Sends the reply box as you, or the shared draft `draft` as it is (its line's "Send as me"),
 * which leaves the reply box alone unless it holds that draft.
 */
async function send(key, thread, draft = null) {
  const box = $('reply');
  const body = (draft ? draft.body : box.value).trim();
  // The files in the tray go with the reply box, not with a draft sent from its line.
  const attached = draft ? [] : state.attachments.get(key) || [];
  state.sendError = null;
  if (!body && !attached.length) return false;
  closeMentions();
  const mentions = draft ? (draft.mentions || []) : mentionsIn(key, body);
  // Who they are, while the picks are still here: the bubble keeps it until the reply arrives
  // (the thread's `mentioned` only knows the names its messages had when it was fetched).
  const picked = mention.picked.get(key);
  const kinds = Object.fromEntries(mentions.map((m) => [m.name, (picked?.has(m.name) && pickedKind(picked.get(m.name))) || mentionKindOf(m.name)]).filter(([, k]) => k));
  // Sent from the thread's draft: that uses it up (unless a colleague changed it since).
  const c = state.composers.get(key);
  const base = draft ? draft.updated_at : c?.base;
  // Shown at once, as it will look once sent; the box is free for the next one (a draft sent
  // from its line leaves the box alone, unless the box holds that draft).
  // The files go with it (`uploads`), and show in its bubble (`files`) until it arrives.
  const files = attached.map((a) => ({ name: a.file.name, type: a.file.type, url: a.url }));
  if (attached.length) {
    state.attachments.delete(key);
    renderTray(key);
  }
  if (!draft || (c?.base === base && c.text.trim() === body)) {
    box.value = '';
    growReply(box);
    state.composers.set(key, { text: '', from: '', base: null });
    mention.picked.delete(key);
  }
  sendSeq += 1;
  const p = {
    thread: key, body, mentions, kinds, base, files, uploads: attached.map((a) => a.file), at: new Date().toISOString(), id: `pending-${Date.now()}-${sendSeq}`, source: thread.source, status: 'sending', ...ownLook(key, thread.source),
  };
  state.sending.push(p);
  showSending(key);
  return postPending(p);
}

/** Sends a reply that failed again. */
function retrySend(id) {
  const p = state.sending.find((x) => x.id === id);
  if (!p || p.status !== 'failed') return;
  Object.assign(p, { status: 'sending', startedAt: null, error: null });
  showSending(p.thread);
  animateSending();
  postPending(p);
}

/** Throws a reply that failed away, with a moment to take that back. */
function discardSend(id) {
  const i = state.sending.findIndex((x) => x.id === id);
  if (i < 0 || state.sending[i].status !== 'failed') return;
  const [p] = state.sending.splice(i, 1);
  showSending(p.thread);
  toast('Reply discarded.', { label: 'Undo', run: () => { state.sending.push(p); showSending(p.thread); } });
}

// Leaving the page (a reload, closing the tab, the browser's Back out of the inbox) while a
// reply is still on its way would lose it: the box is already empty, the bubble lives in this
// page only, and the post may be cut off. The browser asks first, then and only then.
window.addEventListener('beforeunload', (e) => {
  if (!state.sending.some((p) => p.status === 'sending') && !state.compose?.posting) return;
  e.preventDefault();
  e.returnValue = '';
});

/**
 * Posts `text` in the thread as the opspile app (POST /api/post/app), where the channel lets
 * the app post; `base` is the version of the shared draft it sends, which it uses up. Its
 * `@Name`s of the people picked in the reply box (or `mentions`: a draft's) are real
 * mentions, as when you send it. Resolves to null, or the error.
 */
async function sendAsApp(key, text, base, { mentions = mentionsIn(key, text), files = [] } = {}) {
  const res = await postWith('/api/post/app', {
    thread: key, text, ...(mentions.length ? { mentions } : {}), ...(base ? { draft: base } : {}),
  }, files);
  if (!res.ok) return res.data.error || `could not send (${res.status})`;
  const c = state.composers.get(key);
  if (c && c.text.trim() === text.trim()) {
    state.composers.set(key, { text: '', from: '', base: null });
    if (state.open === key && $('reply')) { $('reply').value = ''; $('reply').dispatchEvent(new Event('input')); }
  }
  if (base && state.cache.get(key)?.data?.draft?.updated_at === base) setCachedDraft(key, null);
  openThread(key, { live: true });
  return null;
}

// ---------------------------------------------------------------- new threads
// The ✎ button by the bell opens a composer in the pane, where a thread would be. It goes to the
// one channel the filters leave (`channelsInView`); with more than one, or none, the header
// has a search for one, and nothing can be posted until one is picked. Posting needs the same
// as a reply (POST /api/post, as yourself) and takes the same text, files and mentions, which
// wait under `NEW` as a thread's do under its key. The channel is picked anew each time; the
// text stays in this tab until it is posted. The thread then comes back through the platform's
// events, as a reply does, some ten seconds later, and opens once it is in the inbox.
const NEW = 'new';
const CHANNEL_MAX = 50;
const CHANNELS_FOR_MS = 5 * 60 * 1000;
const ARRIVAL_TRIES = 15;
const ARRIVAL_EVERY_MS = 2000;
let channelsAsked = null;

/** Whether thread or composer `key` is the one in the pane. */
const inPane = (key) => (state.compose ? NEW : state.open) === key;

/** The channels the viewer may start a thread in (GET /api/channels), kept for a while. */
function postableChannels() {
  if (!channelsAsked || Date.now() - channelsAsked.at > CHANNELS_FOR_MS) {
    channelsAsked = { at: Date.now(), list: get('/api/channels').then((d) => d.channels) };
    channelsAsked.list.catch(() => { channelsAsked = null; });
  }
  return channelsAsked.list;
}

/**
 * The channels the view on screen is about: its team's (or those of the personal view) that
 * its customer and platform filters let through. Only those two say which channel: what the
 * other filters pick are threads, in any channel.
 */
function channelsInView(channels) {
  const lets = (id, v) => (!state.sel[id]?.size || state.sel[id].has(v)) && !state.not[id]?.has(v);
  return channels.filter((c) => (personal() ? c.personal : c.teams.includes(state.team))
    && lets('customer', c.org ?? '(none)') && lets('platform', PLATFORM[c.source]));
}

/** The channels found for what is typed (every word), those of the view on screen first. */
function channelOptions(channels, inView, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = channels.filter((c) => {
    const text = [c.name, c.group, c.orgName].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return [...found.filter((c) => inView.includes(c)), ...found.filter((c) => !inView.includes(c))];
}

const channelIcon = (c) => `<img src="${esc(favicon(PLATFORM_SITE[PLATFORM[c.source]]))}" alt="${esc(PLATFORM[c.source])}" title="${esc(PLATFORM[c.source])}">`;
/** Where a channel is, after its name: the customer, and on Teams the team it is in. */
const channelWhere = (c) => [c.orgName, c.group].filter(Boolean).map(esc).join(' · ');

function composeHead({ channel }) {
  const close = `<button class="close" data-close title="Back to the threads" aria-label="Back to the threads">${BACK}</button>`;
  const shut = '<button class="linkish cancel" data-close title="Close (Esc); what you wrote stays until you post it">Cancel</button>';
  const where = channel
    ? `<div class="sub">${channelIcon(channel)}<b id="chan-name">${esc(channel.name)}</b>${channelWhere(channel) ? ` · <span>${channelWhere(channel)}</span>` : ''} · <button class="linkish" data-rechannel>Change</button></div>`
    : '<div class="chanpick"><input id="chan-q" type="search" role="combobox" aria-label="Channel to post in" aria-autocomplete="list" aria-controls="chan-list" aria-expanded="false" placeholder="Pick a channel: search by name or customer" autocomplete="off" spellcheck="false"><ul class="chans" id="chan-list" role="listbox" aria-label="Channels" hidden></ul></div>';
  return `<div class="ph newthread">${close}<h2>New thread ${shut}</h2>${where}</div>`;
}

function composeFeed({ channel, error }) {
  const said = channel ? `Your message starts a new thread in ${esc(channel.name)}, posted as you.` : 'Pick a channel above to post.';
  return `<div class="scroller"><div class="feed">${error ? `<div class="compose-error" role="alert">Not posted: ${esc(error)}</div>` : ''}<div class="empty">${said}</div></div></div>`;
}

function composeBox({ channel, posting }) {
  if (channel && !state.me.connected?.[channel.source]) {
    return `<div class="composer"><span class="connect">To post as yourself, <a href="/api/auth/${channel.source}/start">connect your ${accountOf(channel.source)} account</a>.</span></div>`;
  }
  return `<div class="composer"><ul class="mentions" id="mention-list" role="listbox" hidden></ul>
    <div class="tray" id="tray" hidden></div>${channel ? attachButton(channel) : ''}
    <textarea id="reply" rows="1" role="combobox" aria-autocomplete="list" aria-controls="mention-list" aria-expanded="false"
      placeholder="${channel ? `Write to ${esc(channel.name)}` : 'Write your message'}"></textarea>
    <span class="sendwrap"><button class="send" id="send"${channel ? '' : ' title="Pick a channel first"'}${channel && !posting ? '' : ' disabled'}>${posting ? 'Posting…' : 'Post'}</button></span></div>`;
}

/** Shows the options for what is typed in the header's search, `open` or closed. */
function renderChannels(open = true) {
  const c = state.compose;
  const input = $('chan-q');
  const ul = $('chan-list');
  if (!c || !input || !ul) return;
  ul.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (!open) { input.removeAttribute('aria-activedescendant'); return; }
  ul.innerHTML = c.options.slice(0, CHANNEL_MAX).map((o, i) => `<li role="option" id="chan-${i}" data-i="${i}" class="${i === c.i ? 'on' : ''}" aria-selected="${i === c.i}">${channelIcon(o)}<span class="nm">${esc(o.name)}</span><span class="hint">${channelWhere(o)}</span></li>`).join('')
    || `<li class="none">${input.value.trim() ? 'No channel of yours matches.' : 'You have no channel to post in.'}</li>`;
  if (c.options.length) input.setAttribute('aria-activedescendant', `chan-${c.i}`);
  else input.removeAttribute('aria-activedescendant');
  ul.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

/** Picks channel `channel` (or none, to search again). Mentions are of one workspace or tenant. */
function setChannel(channel) {
  const c = state.compose;
  if (!c) return;
  if (channel?.ref !== c.channel?.ref) mention.picked.delete(NEW);
  Object.assign(c, { channel, error: null });
  renderCompose();
  (channel ? $('reply') : $('chan-q'))?.focus();
}

function wireChannels() {
  const c = state.compose;
  const input = $('chan-q');
  const ul = $('chan-list');
  if (!input) return;
  const find = () => {
    Object.assign(c, { i: 0, options: channelOptions(c.all, channelsInView(c.all), input.value) });
    renderChannels();
  };
  input.onfocus = find;
  input.onclick = () => { if (ul.hidden) find(); };
  input.oninput = find;
  input.onblur = () => renderChannels(false);
  input.onkeydown = (e) => {
    const n = Math.min(c.options.length, CHANNEL_MAX);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (ul.hidden) { find(); return; }
      if (n) c.i = (c.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderChannels();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (!ul.hidden && n) setChannel(c.options[c.i]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!ul.hidden) renderChannels(false); else closeThread();
    }
  };
  // A press keeps the focus in the search, so the list is still there for the click.
  ul.onmousedown = (e) => e.preventDefault();
  ul.onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) setChannel(c.options[Number(li.dataset.i)]);
  };
  find();
}

/** The composer, in the pane, as `state.compose` has it. */
function renderCompose() {
  const c = state.compose;
  const pane = $('pane');
  pane.innerHTML = `${composeHead(c)}${composeFeed(c)}${composeBox(c)}`;
  pane.__key = null;
  wireChannels();
  const box = $('reply');
  if (!box) return;
  box.value = composerFor(NEW).text;
  growReply(box);
  box.oninput = () => {
    composerFor(NEW).text = box.value;
    growReply(box);
    suggest(NEW);
  };
  box.onclick = () => suggest(NEW);
  box.onblur = () => setTimeout(closeMentions, 150);
  box.onkeydown = (e) => {
    if (mentionKey(e, NEW)) return;
    if (e.key === 'Escape') { e.preventDefault(); closeThread(); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH_ONLY.matches) { e.preventDefault(); postNew(); }
  };
  $('send').onclick = (e) => { e.preventDefault(); postNew(); };
  if (c.channel) wireAttach(NEW, c.channel);
}

/** Opens the composer. `push`: a new entry in the history, so Back leaves it. */
async function openCompose({ push = true } = {}) {
  const c = {
    channel: null, all: [], options: [], i: 0, posting: false, error: null,
  };
  Object.assign(state, { open: null, compose: c, awaiting: null });
  syncReading();
  toUrl(push, push ? { list: true } : null);
  renderThreads();
  hideSource();
  closeMentions();
  const pane = $('pane');
  pane.__key = null;
  pane.innerHTML = '<div class="empty">Loading channels…</div>';
  try {
    c.all = await postableChannels();
  } catch (e) {
    if (state.compose === c) pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (state.compose !== c) return;
  const view = channelsInView(c.all);
  if (view.length === 1) [c.channel] = view;
  renderCompose();
  (c.channel ? $('reply') : $('chan-q'))?.focus();
}

/** Opens the thread `key` started once it is in the inbox, unless the pane moved on. */
function openWhenHere(key, shown, tries = ARRIVAL_TRIES) {
  setTimeout(async () => {
    if (state.awaiting !== key) return;
    const here = await get(threadUrl(key)).catch(() => null);
    if (state.awaiting !== key) return;
    if (here) openThread(key);
    else if (tries > 1) openWhenHere(key, shown, tries - 1);
    else $('pane').innerHTML = `<div class="empty">Posted in ${esc(shown)}. It shows up in the inbox as soon as it arrives.</div>`;
  }, ARRIVAL_EVERY_MS);
}

/** Posts the composer's text and files, once a channel is picked. */
async function postNew() {
  const c = state.compose;
  const box = $('reply');
  if (!c || !box || c.posting) return;
  if (!c.channel) { $('chan-q')?.focus(); return; }
  const text = box.value.trim();
  const attached = state.attachments.get(NEW) || [];
  if (!text && !attached.length) return;
  // Picked before the channel changed, perhaps to a platform that takes less.
  const rule = attachRule(c.channel);
  const files = attached.map((a) => a.file);
  const problem = attachProblem(rule, files);
  if (problem) { attachRefused(rule, problem); return; }
  closeMentions();
  c.posting = true;
  c.error = null;
  $('send').disabled = true;
  $('send').textContent = 'Posting…';
  const { channel } = c;
  const res = await postWith('/api/post', { channel: channel.ref, text, mentions: mentionsIn(NEW, text) }, files);
  c.posting = false;
  if (!res.ok) {
    const { data } = res;
    c.error = data.error || (res.status ? `could not post (${res.status})` : 'could not reach the inbox');
    if (data.connect) state.me.connected = { ...state.me.connected, [data.connect]: false };
    const again = data.files && (data.reconnect || data.connect);
    if (again) toast(c.error, { label: 'Connect again', href: `/api/auth/${again}/start?files=1` });
    if (state.compose !== c) { toast(`Your new thread was not posted: ${c.error}`); return; }
    renderCompose();
    $('reply')?.focus();
    return;
  }
  for (const a of attached) if (a.url) URL.revokeObjectURL(a.url);
  state.attachments.delete(NEW);
  state.composers.delete(NEW);
  mention.picked.delete(NEW);
  // Somewhere else by now: that stays on screen.
  if (state.compose !== c) { toast(`Posted in ${channel.name}.`); return; }
  state.compose = null;
  syncReading();
  toUrl(false);
  renderThreads();
  const said = `Posted in ${esc(channel.name)}.`;
  $('pane').innerHTML = `<div class="empty">${said}${res.data.thread ? ' Opening the thread…' : ''}</div>`;
  if (TAKING_TURNS.matches || !res.data.thread) toast(`Posted in ${channel.name}.`);
  if (!res.data.thread) return;
  state.awaiting = res.data.thread;
  openWhenHere(res.data.thread, channel.name);
}

// ---------------------------------------------------------------- editing
// ✎ on one of your messages turns its bubble into an editor: Enter saves (as it was sent: as
// you, or as the opspile app), Escape cancels, @ suggests people as in the reply box. The new
// text shows at once, "(edited)", while the platform's own edit event is on its way.
const messageOf = (key, id) => (state.cache.get(key)?.data?.messages || []).find((x) => `${x.thread}|${x.id}` === id);
const repaint = (key) => { if (state.open === key) openThread(key, { live: true, cached: true }); };

function startEdit(id) {
  const key = state.open;
  const m = messageOf(key, id);
  if (!m || !canEdit(m)) return;
  closePicker();
  const pending = state.edits.get(id);
  state.editing = {
    // The text only: the files listed at its end are not part of it, and stay as they are.
    id, key, text: pending ? pending.body : ownText(m.body), as: m.editable, focus: true,
  };
  repaint(key);
}

function cancelEdit() {
  const ed = state.editing;
  if (!ed) return;
  state.editing = null;
  closeMentions();
  repaint(ed.key);
  // Back to where typing goes on.
  $('reply')?.focus({ preventScroll: true });
}

async function saveEdit() {
  const ed = state.editing;
  const m = ed && messageOf(ed.key, ed.id);
  if (!ed) return;
  const body = ed.text.trim();
  if (!body) { toast('Write something, or press Esc to keep the message as it is.'); return; }
  closeMentions();
  if (!m || body === ownText(m.body)) { cancelEdit(); return; }
  const at = ed.id.indexOf('|');
  const mentions = mentionsIn(ed.key, body);
  state.editing = null;
  state.edits.set(ed.id, { body, sentAt: Date.now(), saving: true });
  repaint(ed.key);
  const res = await write('/api/edit', {
    thread: ed.id.slice(0, at), id: ed.id.slice(at + 1), text: body, mentions,
  });
  if (res.failed) {
    // The message as it was, and the editor again with the text, to try again or cancel.
    state.edits.delete(ed.id);
    if (!state.editing) state.editing = { ...ed, text: body, focus: true };
  } else {
    const e = state.edits.get(ed.id);
    if (e) e.saving = false;
  }
  repaint(ed.key);
}

/** Fills and wires the editor once it is shown (again, after the message was rebuilt). */
function wireEditor(key) {
  const ed = state.editing;
  if (!ed || ed.key !== key) return;
  const box = $('pane').querySelector('.msg.editing .editbox');
  if (!box) { state.editing = null; return; }
  if (box.__wired) return;
  box.__wired = true;
  box.value = ed.text;
  const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(320, box.scrollHeight)}px`; };
  grow();
  // Focused when it opens, or when a live update rebuilt it while it had the focus.
  const active = document.activeElement;
  if (ed.focus || !active || active === document.body || !active.isConnected) {
    ed.focus = false;
    box.focus({ preventScroll: true });
    const end = ed.caret ?? box.value.length;
    box.setSelectionRange(end, end);
    box.closest('.msg').scrollIntoView({ block: 'nearest' });
  }
  box.oninput = () => { ed.text = box.value; ed.caret = box.selectionStart; grow(); suggest(key); };
  box.onclick = () => suggest(key);
  box.onblur = () => setTimeout(closeMentions, 150);
  box.onkeydown = (e) => {
    if (mentionKey(e, key)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH_ONLY.matches) { e.preventDefault(); saveEdit(); }
  };
}

// ---------------------------------------------------------------- attachments
// Files go with a reply: the 📎 button, dropped on the thread, or pasted (screenshots). They
// wait in the tray above the reply box, per thread, until it is sent. What may go is the
// rule the Worker sends for each platform (GET /api/me `attach`, src/attach.js): Slack takes
// files once the account may upload, Teams inline images (and other files with access to the
// channel's files); the Worker checks again.
const PAPERCLIP = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.7 11.3a1.1 1.1 0 0 1-1.5-1.5l4.9-4.9"/></svg>';
const MB = 1024 * 1024;
let attachSeq = 0;
const fileSize = (n) => (n >= MB ? `${(n / MB).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const NO_RULE = { count: 0, why: 'replies here cannot carry files' };
/** The rule for replying as yourself in `thread`. */
const attachRule = (thread) => (thread && state.me.attach?.[thread.source]) || NO_RULE;
const imageUnder = (rule, f) => (rule.types ? rule.types.includes(f.type) : /^image\//.test(f.type || ''));
/** Why `files` cannot go together under `rule`, or null (as src/attach.js checks them). */
function attachProblem(rule, files) {
  if (!files.length) return null;
  if (!rule.count) return `Cannot attach files here: ${rule.why}.`;
  if (files.length > rule.count) return `Up to ${rule.count} files per message.`;
  let total = 0;
  for (const f of files) {
    if (!imageUnder(rule, f) && !rule.other) return `Cannot attach ${f.name}: ${rule.why}.`;
    if (!f.size) return `${f.name} is empty.`;
    if (f.size > rule.file) return `${f.name} is ${fileSize(f.size)}: files here take up to ${fileSize(rule.file)}.`;
    total += f.size;
  }
  return total > rule.total ? `The files are ${fileSize(total)} together: up to ${fileSize(rule.total)} per message.` : null;
}
/** What the 📎 button says it takes. */
function attachHint(rule) {
  if (!rule.count) return `Cannot attach files here: ${rule.why}`;
  const what = rule.other ? 'files' : 'images';
  return `Attach ${what}, or drop or paste them here (up to ${rule.count}, ${fileSize(rule.total)} in all)`;
}
const attachButton = (thread) => {
  const rule = attachRule(thread);
  const accept = rule.other || !rule.types ? '' : ` accept="${rule.types.join(',')}"`;
  return `<button class="attach" id="attach" type="button" aria-label="${esc(attachHint(rule))}" title="${esc(attachHint(rule))}"${rule.count ? '' : ' aria-disabled="true"'}>${PAPERCLIP}</button><input type="file" id="attach-input" multiple hidden${accept}>`;
};

/**
 * A pasted screenshot is called "image.png" by the browser: give it a name that says what
 * and when, as Slack does.
 */
function named(f) {
  if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  return new File([f], `Screenshot ${stamp}.${ext}`, { type: f.type, lastModified: f.lastModified });
}

/** Explains why nothing can be attached, with a way to connect again where that helps. */
function attachRefused(rule, text) {
  toast(text, rule.reconnect ? { label: 'Connect again', href: `/api/auth/${rule.reconnect}/start?files=1` } : null);
}

function showAttachError(key, text) {
  const tray = inPane(key) && $('tray');
  if (!tray) return;
  tray.querySelector('.attach-error')?.remove();
  const el = document.createElement('div');
  el.className = 'attach-error';
  el.setAttribute('role', 'alert');
  el.textContent = text;
  tray.append(el);
  tray.hidden = false;
}

/** Adds files to the thread's tray, if they may go with the ones already there. */
function addFiles(key, thread, list) {
  const files = [...list].filter((f) => f && typeof f.size === 'number').map(named);
  if (!files.length) return;
  const rule = attachRule(thread);
  const now = state.attachments.get(key) || [];
  const problem = attachProblem(rule, [...now.map((a) => a.file), ...files]);
  if (problem) {
    attachRefused(rule, problem);
    renderTray(key);
    if (now.length) showAttachError(key, problem);
    return;
  }
  state.attachments.set(key, [...now, ...files.map((file) => {
    attachSeq += 1;
    return { id: `a${attachSeq}`, file, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
  })]);
  renderTray(key);
  $('reply')?.focus();
}

function removeFile(key, id) {
  const list = state.attachments.get(key) || [];
  const gone = list.find((a) => a.id === id);
  if (gone?.url) URL.revokeObjectURL(gone.url);
  const rest = list.filter((a) => a.id !== id);
  if (rest.length) state.attachments.set(key, rest); else state.attachments.delete(key);
  renderTray(key);
}

const fileChip = (a) => `<div class="chip ${a.url ? 'img' : 'file'}" title="${esc(`${a.file.name} · ${fileSize(a.file.size)}`)}">
    ${a.url ? `<img src="${esc(a.url)}" alt="">` : `<span class="ico" aria-hidden="true">${esc((a.file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase())}</span><span class="nm">${esc(a.file.name)}</span><span class="sz">${fileSize(a.file.size)}</span>`}
    <button type="button" class="x" data-rm="${a.id}" aria-label="Remove ${esc(a.file.name)}" title="Remove">×</button></div>`;

/** The tray: the files waiting to go with the reply, each with an × to take it off. */
function renderTray(key) {
  const tray = $('tray');
  if (!tray || !inPane(key)) return;
  const list = state.attachments.get(key) || [];
  tray.hidden = !list.length;
  tray.innerHTML = list.map(fileChip).join('');
  tray.onclick = (e) => {
    const b = e.target.closest('[data-rm]');
    if (b) { removeFile(key, b.dataset.rm); $('reply')?.focus(); }
  };
}

/** The files of a reply being sent, as the message will show them once it arrives. */
function pendingFiles(files) {
  const images = files.filter((f) => f.url).map((f) => `<img class="att" src="${esc(f.url)}" alt="${esc(f.name)}">`);
  const others = files.filter((f) => !f.url).map((f) => Markdown.fileCard({ name: esc(f.name), note: 'Sending…', preview: false }));
  return `${images.length > 1 ? `<div class="gallery">${images.join('')}</div>` : images.join('')}${others.length ? `<div class="files">${others.join('')}</div>` : ''}`;
}

/**
 * A message's body without the list of files ingestion puts at its end ("Attachments:", then
 * only images and links to files, src/normalize.js). Text of its own that starts a line with
 * "Attachments:" stays.
 */
const FILE_LINE = /^(!\[[^\]]*\]\([^)]*\)|- \[[^\]]*\]\([^)]*\)|- .*\(shared from another workspace; opspile cannot see it\))$/;
function withoutAttachments(body) {
  const text = String(body || '');
  const at = text.search(/(^|\n)[ \t]*Attachments:[ \t]*(\n|$)(?![\s\S]*\nAttachments:)/);
  if (at < 0) return text;
  const list = text.slice(at).replace(/^\n?[ \t]*Attachments:[ \t]*/, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return list.length && list.every((l) => FILE_LINE.test(l)) ? text.slice(0, at) : text;
}
/** What the author of a message wrote: no files, nor the messages it quotes (they stay as they are). */
const ownText = (body) => Markdown.withoutQuotes(withoutAttachments(body)).trim();

/** The 📎 button, paste in the reply box. Dropping is wired once, on the pane (wireDrop). */
function wireAttach(key, thread) {
  const btn = $('attach');
  const input = $('attach-input');
  const box = $('reply');
  if (!btn || !input || !box) return;
  renderTray(key);
  btn.onclick = () => {
    const rule = attachRule(thread);
    if (!rule.count) { attachRefused(rule, `Cannot attach files here: ${rule.why}.`); return; }
    input.click();
  };
  input.onchange = () => { addFiles(key, thread, input.files); input.value = ''; };
  box.onpaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    // Text that comes with files is their name (a file copied in the Finder), or the text
    // itself (a picture of it from a word processor): only the first is taken for the files.
    const text = e.clipboardData.getData('text/plain').trim();
    if (text && !files.some((f) => f.name === text || text.endsWith(f.name))) return;
    e.preventDefault();
    addFiles(key, thread, files);
  };
}

/**
 * Files dragged over the open thread: the pane shows where they go (or why they cannot), and
 * dropping them anywhere on it adds them to the reply.
 */
function wireDrop() {
  const pane = $('pane');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  // The open thread, and what its reply may carry; without a reply box, why there is none.
  const target = () => {
    const key = state.compose ? NEW : state.open;
    const thread = state.compose ? state.compose.channel : key && state.cache.get(key)?.data?.thread;
    if (state.compose && !thread) return { key, thread, rule: { count: 0, why: 'pick a channel first' } };
    if (!thread) return null;
    let rule = attachRule(thread);
    if (!$('reply')) {
      let why = `connect your ${accountOf(thread.source)} account to ${state.compose ? 'post' : 'reply'} here first`;
      if (state.data?.me?.readonly) why = 'this inbox is read-only while you view it as someone else';
      else if (thread.source === 'discord') why = 'replies to Discord are written in Discord, where the inbox cannot post as you';
      rule = { count: 0, why };
    }
    return { key, thread, rule };
  };
  const hide = () => { depth = 0; pane.querySelector(':scope > .dropzone')?.remove(); pane.classList.remove('dropping'); };
  const show = ({ rule }) => {
    let zone = pane.querySelector(':scope > .dropzone');
    if (!zone) {
      zone = document.createElement('div');
      zone.className = 'dropzone';
      pane.append(zone);
    }
    zone.classList.toggle('refused', !rule.count);
    zone.innerHTML = `<div>${PAPERCLIP}<b>${rule.count ? `Drop to attach ${rule.other ? 'files' : 'images'}` : 'Cannot attach files here'}</b><span>${esc(rule.count ? `Up to ${rule.count}, ${fileSize(rule.total)} in all; they go with your ${state.compose ? 'message' : 'reply'}.` : `${rule.why[0].toUpperCase()}${rule.why.slice(1)}.`)}</span></div>`;
    pane.classList.add('dropping');
  };
  pane.addEventListener('dragenter', (e) => {
    const t = hasFiles(e) && target();
    if (!t) return;
    e.preventDefault();
    depth += 1;
    if (depth === 1) show(t);
  });
  pane.addEventListener('dragover', (e) => {
    const t = hasFiles(e) && target();
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = t.rule.count ? 'copy' : 'none';
  });
  pane.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) hide();
  });
  pane.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    const t = target();
    hide();
    if (!t) return;
    e.preventDefault();
    if (!t.rule.count) { attachRefused(t.rule, `Cannot attach files here: ${t.rule.why}.`); return; }
    addFiles(t.key, t.thread, e.dataTransfer.files);
  });
  // Files dropped next to the pane would open in the tab, and the reply would be lost.
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) { e.preventDefault(); hide(); } });
}

/**
 * POSTs `payload` as the signed-in person, as JSON, or with `files` as multipart (the JSON as
 * `payload`, each file as `files`). `{ ok, status, data }`.
 */
async function postWith(path, payload, files = []) {
  if (!files.length) return request('POST', path, payload);
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const f of files) form.append('files', f, f.name);
  const headers = state.as ? { 'x-opspile-as': String(state.as) } : {};
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers, body: form });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `could not send: ${e.message}` } };
  }
}

// ---------------------------------------------------------------- mentions
// Typing @ suggests people opspile knows on the thread's platform (D1 accounts): customers in
// the thread first, then the Adobe people who know what it is about (`expert`), then the rest of
// the thread and the channel's members, and on Teams the bots of the thread's Teams team.
// What follows the @ matches the start of any word of the name, login or mail, in any case
// (src/mention-match.js).
// Picking one writes @Name and remembers the account, and the reply sends its id along, so
// the server turns @Name into a real Slack or Teams mention.
const mention = {
  kind: 'person', list: [], i: 0, from: -1, seq: 0, timer: null, waiting: null, picked: new Map(), names: new Set(),
};
// The box suggestions are for: the reply box, or the message being edited, whichever has the
// focus; the list of suggestions next to it.
/** What /api/mentionable is asked about: the thread, or the channel a new one goes to (none yet). */
function mentionScope(key) {
  if (key !== NEW) return `thread=${encodeURIComponent(key)}`;
  const c = state.compose?.channel;
  return c ? `channel=${encodeURIComponent(c.ref)}` : null;
}
const mentionBox = () => (document.activeElement?.classList?.contains('editbox') ? document.activeElement : $('reply'));
const mentionList = () => mentionBox()?.parentElement?.querySelector(':scope > ul.mentions') || null;
const MENTION_AT = /(?:^|[\s(])@([\p{L}\p{N}._'-]*(?: [\p{L}\p{N}._'-]*){0,2})$/u;

function mentionQuery(box, key) {
  if (box.selectionStart !== box.selectionEnd) return null;
  const m = MENTION_AT.exec(box.value.slice(0, box.selectionStart));
  if (!m || m[1].length > 40 || m[1].startsWith(' ')) return null;
  // Right after a picked mention: that one is done.
  if ([...(mention.picked.get(key)?.keys() || [])].some((name) => m[1].startsWith(`${name} `) || m[1] === name)) return null;
  return { q: m[1], from: box.selectionStart - m[1].length - 1 };
}

// Everything a thread's suggestions are picked from (`pool` of /api/mentionable, asked for
// with the first suggestions of a thread), by `mentionScope`: with it, what is typed after the
// @ is ranked here as the Worker ranks it (`Markdown.suggestMentions`, src/mention-match.js),
// at once, instead of asking the Worker for every letter. A pool older than POOL_FRESH_MS is
// still used, and asked for again in the background.
// Kept by who is asking too (`state.as`): the experts leave the viewer out.
const mentionPools = new Map(); // viewer and scope -> { pool, at, asking }
const POOL_FRESH_MS = 2 * 60 * 1000;
const POOLS_MAX = 20;
const poolKey = (where) => `${state.as || ''}|${where}`;
const keptPool = (where) => mentionPools.get(poolKey(where))?.pool;

/** Keeps the pool of `where` from an answer of /api/mentionable that has one. */
function keepPool(where, pool) {
  mentionPools.delete(poolKey(where));
  mentionPools.set(poolKey(where), { pool, at: Date.now(), asking: false });
  while (mentionPools.size > POOLS_MAX) mentionPools.delete(mentionPools.keys().next().value);
}

/** Whether the next question about `where` should ask for its pool too (and that it does). */
function askPool(where) {
  const p = mentionPools.get(poolKey(where)) || {};
  if (p.asking || (p.pool && Date.now() - p.at < POOL_FRESH_MS)) return false;
  mentionPools.set(poolKey(where), { ...p, asking: true });
  return true;
}

async function askMentionable(where, q, pool) {
  try {
    const data = await get(`/api/mentionable?${where}&q=${encodeURIComponent(q)}${pool ? '&pool=1' : ''}`);
    if (data.pool) keepPool(where, data.pool);
    return data.people || [];
  } finally {
    const p = mentionPools.get(poolKey(where));
    if (pool && p?.asking) mentionPools.set(poolKey(where), { ...p, asking: false });
  }
}

function showPeople(key, hit, people) {
  // A space after a name that matches nobody ends the mention.
  if (!people.length && /\s/.test(hit.q)) { closeMentions(); return; }
  Object.assign(mention, { kind: 'person', list: people, i: 0, from: hit.from });
  renderMentions(key);
}

function suggest(key) {
  const box = mentionBox();
  clearTimeout(mention.timer);
  mention.waiting = null;
  const em = box && emojiQuery(box);
  if (em) { suggestEmoji(key, em); return; }
  const hit = box && mentionQuery(box, key);
  const where = mentionScope(key);
  if (!hit || !where) { closeMentions(); return; }
  const seq = ++mention.seq;
  const kept = keptPool(where);
  if (kept) {
    showPeople(key, hit, Markdown.suggestMentions(kept, hit.q));
    // Stale: asked again for the next time, as the @ opening the suggestions asks.
    if (askPool(where)) askMentionable(where, '', true).catch(() => {});
    return;
  }
  mention.waiting = where;
  mention.timer = setTimeout(async () => {
    const pool = askPool(where);
    let people = [];
    try {
      people = await askMentionable(where, hit.q, pool);
    } catch { /* no suggestions */ }
    if (!inPane(key)) return;
    if (seq === mention.seq) {
      mention.waiting = null;
      showPeople(key, hit, people);
    } else if (pool && mention.waiting === where && keptPool(where)) {
      // More was typed while the pool came: what is waiting for the Worker is ranked here.
      suggest(key);
    }
  }, hit.q ? 120 : 0);
}

// Typing : and two more characters of a name suggests emoji, by Slack's names (which replies
// to every platform take, src/shortcodes.js): first those whose name (or another platform's
// name for them) has what was typed (src/emojinames.js `matchEmoji`), at once, in a Slack
// thread the workspace's own emoji too; then, until
// the list is full, those Clef thinks were meant (GET /api/emoji: its candidates by Clef's
// probability, no threshold), so `:celebr` finds 🥳 too. Picking one writes `:name: `; the
// reply goes out as the platform knows it.
const EMOJI_AT = /(?:^|[\s(]):([a-z0-9_+-]{2,40})$/i;
const EMOJI_MAX = 8;
// Clef's rankings by what was typed, as promises, so typing back and forth asks once.
const clefEmoji = new Map();

function emojiQuery(box) {
  if (box.selectionStart !== box.selectionEnd) return null;
  const m = EMOJI_AT.exec(box.value.slice(0, box.selectionStart));
  return m ? { q: m[1].toLowerCase(), from: box.selectionStart - m[1].length - 1 } : null;
}

function clefRanking(q) {
  if (!clefEmoji.has(q)) {
    if (clefEmoji.size >= 200) clefEmoji.delete(clefEmoji.keys().next().value);
    clefEmoji.set(q, get(`/api/emoji?q=${encodeURIComponent(q)}`).then((d) => d.emoji || [], () => {
      clefEmoji.delete(q);
      return [];
    }));
  }
  return clefEmoji.get(q);
}

function suggestEmoji(key, hit) {
  const slack = /^slack:/.test(key === NEW ? state.compose?.channel?.ref : key);
  const found = Markdown.matchEmoji(slack ? ownEmoji.names : SLACK_EMOJI.names, slack ? ownEmoji.alike : SLACK_EMOJI.aliases || {}, hit.q, EMOJI_MAX)
    .map((name) => ({ emoji: name }));
  if (!found.length) closeMentions();
  const seq = ++mention.seq;
  Object.assign(mention, { kind: 'emoji', list: found, i: 0, from: hit.from });
  if (found.length) renderMentions(key);
  if (found.length >= EMOJI_MAX || !/[a-z]/.test(hit.q)) return;
  mention.timer = setTimeout(async () => {
    const ranked = await clefRanking(hit.q);
    if (seq !== mention.seq || !inPane(key)) return;
    // One line per emoji: Clef's that are not in the list yet, until it is full.
    const have = new Set(mention.list.map((e) => emojiByName(e.emoji)));
    const more = [];
    for (const name of ranked) {
      const c = emojiByName(name);
      if (more.length >= EMOJI_MAX - mention.list.length) break;
      if (c && !have.has(c)) { have.add(c); more.push({ emoji: name, clef: true }); }
    }
    if (!more.length) return;
    mention.list = [...mention.list, ...more];
    renderMentions(key);
  }, clefEmoji.has(hit.q) ? 0 : 200);
}

function renderMentions(key) {
  const ul = mentionList();
  const box = mentionBox();
  if (!ul || !box) return;
  if (!mention.list.length) { closeMentions(); return; }
  ul.setAttribute('aria-label', mention.kind === 'emoji' ? 'Emoji' : 'People to mention');
  ul.innerHTML = mention.list.map((p, i) => `<li role="option" id="mention-${i}" class="${i === mention.i ? 'on' : ''}" aria-selected="${i === mention.i}" data-i="${i}">
    ${p.emoji ? emojiOption(p) : `${avatar(p.name, p.avatar)}<span>${esc(p.name)}</span>${p.kind === 'bot' ? '<span class="hint">bot</span>' : p.here ? '<span class="hint">in thread</span>' : p.expert ? '<span class="hint" title="Has written about what this thread is about">Adobe · related</span>' : p.member ? '<span class="hint">in channel</span>' : p.staff ? '<span class="hint">Adobe</span>' : ''}`}</li>`).join('');
  ul.hidden = false;
  box.setAttribute('aria-expanded', 'true');
  box.setAttribute('aria-activedescendant', `mention-${mention.i}`);
  ul.onmousedown = (e) => e.preventDefault();
  ul.onclick = (e) => { const li = e.target.closest('li'); if (li) pickMention(key, Number(li.dataset.i)); };
}

/** An emoji suggestion: the emoji, its name, and whether Clef suggested it. */
const emojiOption = (p) => `<span class="glyph" aria-hidden="true">${emojiChip(p.emoji)}</span><span>:${esc(p.emoji)}:</span>${p.clef ? '<span class="hint" title="Suggested by Clef">Clef</span>' : ''}`;

function closeMentions() {
  mention.list = [];
  mention.waiting = null;
  mention.seq += 1;
  clearTimeout(mention.timer);
  for (const ul of document.querySelectorAll('#pane ul.mentions')) { ul.hidden = true; ul.innerHTML = ''; }
  for (const box of document.querySelectorAll('#reply, #pane .editbox')) {
    box.setAttribute('aria-expanded', 'false');
    box.removeAttribute('aria-activedescendant');
  }
}

/** Keys while suggestions show: arrows move, Enter or Tab picks, Escape closes. */
function mentionKey(e, key) {
  if (!mention.list.length || e.isComposing) return false;
  const n = mention.list.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    mention.i = (mention.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMentions(key);
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    pickMention(key, mention.i);
  } else if (e.key === 'Escape') {
    closeMentions();
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

function pickMention(key, i) {
  const box = mentionBox();
  const p = mention.list[i];
  if (!box || !p) return;
  const insert = p.emoji ? `:${p.emoji}: ` : `@${p.name} `;
  box.value = box.value.slice(0, mention.from) + insert + box.value.slice(box.selectionStart);
  const at = mention.from + insert.length;
  box.focus();
  box.setSelectionRange(at, at);
  if (!p.emoji) {
    if (!mention.picked.has(key)) mention.picked.set(key, new Map());
    mention.picked.get(key).set(p.name, p);
    mention.names.add(p.name);
  }
  closeMentions();
  if (box.classList.contains('editbox') && state.editing) {
    Object.assign(state.editing, { text: box.value, caret: at });
  }
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.classList.contains('editbox') ? 320 : 180, box.scrollHeight)}px`;
}

/** Who a picked account is, for its mention's class: a bot, or Adobe (the picker knows staff). */
const pickedKind = (p) => (p.kind === 'bot' ? 'bot' : (p.staff ? 'adobe' : null));

/** Accounts picked for this reply whose @Name is still in the text. */
function mentionsIn(key, body) {
  return [...(mention.picked.get(key)?.values() || [])]
    .filter((p) => new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(body))
    .map((p) => ({ id: p.id, name: p.name }));
}

/** A short note at the bottom; `action` adds a link (`href`) or a button (`run`). */
function toast(text, action) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  if (action) {
    const a = document.createElement(action.href ? 'a' : 'button');
    a.textContent = action.label;
    if (action.href) a.href = action.href;
    else a.onclick = () => { el.remove(); action.run(); };
    el.append(a);
  }
  document.body.append(el);
  setTimeout(() => el.remove(), action ? 8000 : 5000);
}

// ---------------------------------------------------------------- reactions, resolving
/** Writes as the signed-in person; read-only views send who they view as, so it is refused. */
async function request(method, path, body) {
  const headers = { 'content-type': 'application/json', ...(state.as ? { 'x-opspile-as': String(state.as) } : {}) };
  const res = await fetch(path, { method, credentials: 'same-origin', headers, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
/**
 * POSTs as the signed-in person. The response body, or `{ error }` (shown as a toast too).
 */
async function write(path, body) {
  const res = await request('POST', path, body);
  const { data } = res;
  if (res.ok) return data;
  const p = data.connect || data.reconnect;
  if (data.connect) state.me.connected = { ...state.me.connected, [data.connect]: false };
  toast(data.error || `failed (${res.status})`, p ? { label: data.reconnect ? 'Connect again' : 'Connect', href: `/api/auth/${p}/start` } : null);
  if (data.connect && state.open) openThread(state.open, { live: true });
  return { error: data.error || `failed (${res.status})`, failed: true };
}

async function react(id, emojiName, remove) {
  const at = id.indexOf('|');
  const res = await write('/api/react', { thread: id.slice(0, at), id: id.slice(at + 1), emoji: emojiName, remove });
  if (!res.failed) reloadSoon(state.open);
  return res;
}

async function resolveThread(key, undo) {
  const btn = state.open === key && $('resolve');
  if (btn) { btn.disabled = true; btn.textContent = undo ? 'Taking ✅ off…' : 'Resolving…'; }
  const res = await write('/api/resolve', { thread: key, undo });
  if (res.failed) { if (btn) openThread(key, { live: true }); return res; }
  toast(undo ? 'Your ✅ is off again.' : 'Resolved: ✅ on the first message, as you.', { label: 'Undo', run: () => resolveThread(key, !undo) });
  reloadSoon(key);
  return res;
}

function toggleResolve() {
  const key = state.open;
  if (!key || state.data?.me?.readonly || !$('resolve') || $('resolve').disabled) return;
  const r = state.cache.get(key)?.data?.resolution;
  resolveThread(key, Boolean(r && r.state === 'resolved' && r.mine));
}

function closePicker() {
  const p = document.querySelector('.picker');
  if (!p) return;
  p.closest('.col')?.querySelector('[data-picker]')?.setAttribute('aria-expanded', 'false');
  p.remove();
}

function openPicker(button) {
  const col = button.closest('.col');
  const open = col.querySelector('.picker');
  closePicker();
  if (open) return;
  const picker = toNode(`<div class="picker" role="menu">${PICKER.map((n) => `<button role="menuitem" data-pick="${n}" title=":${n}:">${emoji(n)}</button>`).join('')}</div>`);
  col.append(picker);
  button.setAttribute('aria-expanded', 'true');
  picker.querySelector('button').focus();
}

// ---------------------------------------------------------------- read state, live
/** A thread as seen from the open team's inbox (a shared channel is in several). */
const threadUrl = (key) => `/api/thread?thread=${encodeURIComponent(key)}${state.team && !personal() ? `&team=${encodeURIComponent(state.team)}` : ''}`;
const memberLast = (m, kind) => (kind === 'alert' ? m.any_at : m.last_at) || m.any_at;
function markRead(t) {
  if (!t || !t.thread || state.data?.me?.readonly) return;
  // A folded entry is several platform threads: each one is read up to its own end.
  for (const m of t.members || [{ thread: t.thread, last_at: t.last_at, any_at: t.any_at }]) {
    const at = memberLast(m, t.kind);
    if (!at) continue;
    const msg = { type: 'read', thread: m.thread, at };
    // A team's view sends it to the team's room; the personal view has a socket per team, and
    // the API picks the room (one of the viewer's teams whose inbox has the thread).
    const ws = !personal() && state.sockets.find((x) => x.team === state.team);
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    else fetch('/api/read', { method: 'POST', body: JSON.stringify({ ...msg, team: personal() ? undefined : state.team }), credentials: 'same-origin' });
  }
  if (!t.readers.includes(state.me.id)) t.readers.push(state.me.id);
  Object.assign(t, {
    unread: false, unseen: false, mentionedMe: false, unreadMentions: 0,
  });
  if (lastOf(t)) t.unseenByAdobe = false;
  const applies = { 'mentioned-team': t.mentionedTeam.length > 0 };
  t.attention = applies['mentioned-team'] ? 'mentioned-team' : null;
  render();
}
// Live updates reload the inbox (and the open thread, when it changed) half a second after the
// room's announcement. A tab in the background does not: most inbox loads were tabs nobody was
// looking at, several per person, each reloading on every message. It keeps the threads that
// changed and catches up when it is shown again; only a bell on the inbox on screen keeps it
// reloading, because bells are checked on its reloads (checkBells).
let reload;
const changed = new Set();
const STATUS_TICK_MS = 60 * 1000;
const hidden = () => document.visibilityState === 'hidden';
const belled = () => notifying() && (state.settings?.bells || []).some((b) => b.view === scopeKey());
function reloadSoon(thread) {
  if (thread) changed.add(thread);
  clearTimeout(reload);
  reload = hidden() && !belled() ? null : setTimeout(reloadChanged, 500);
}
async function reloadChanged() {
  reload = null;
  const threads = new Set(changed);
  changed.clear();
  const touched = (key) => threads.has(key) || state.data?.threads.find((t) => t.thread === key)?.members?.some((m) => threads.has(m.thread));
  // The open thread itself changed: fetch it alongside the inbox, not after it.
  const early = state.open && threads.has(state.open) ? state.open : null;
  if (early) openThread(early, { live: true });
  await loadInbox();
  if (state.open && state.open !== early && touched(state.open)) openThread(state.open, { live: true });
}
// A thread's status depends on the time too (waiting too long, customer silent), and nothing
// announces that: the list is looked at again every minute while it is on screen.
setInterval(() => { if (!hidden() && state.data) render(); }, STATUS_TICK_MS);
document.addEventListener('visibilitychange', () => {
  if (hidden() || !state.data) return;
  const open = state.open;
  const agent = open && state.agents.get(open);
  // Shown again: what changed meanwhile, and the agent's turn if it was due to be asked (and
  // the thread's reload did not ask already).
  const caught = changed.size && !reload ? reloadChanged() : null;
  if (agent?.due) {
    Promise.resolve(caught).then(() => {
      if (state.open === open && state.agents.get(open) === agent) loadAgent(open);
    });
  }
});
/** The teams of whoever the inbox is shown for (you, or the person you view as). */
async function loadWho() {
  const who = state.as ? await get('/api/me') : state.me;
  state.teams = who.teams;
  state.rooms = roomsOf(who);
  if (!who.teams.some((t) => t.slug === state.team)) state.team = who.teams[0]?.slug;
  renderUser();
}
/**
 * The toolbar's right end: you and the view on screen, and the menu behind them ("View as",
 * shortcuts, log out). Viewing as someone shows who, until left. The views are switched
 * above the thread list.
 */
function renderUser() {
  Header.user(state.me, personal() ? 'Personal' : state.teams?.find((t) => t.slug === state.team)?.name || '');
  const as = state.data?.me?.readonly ? state.data.me.name : null;
  $('viewing').hidden = !as;
  $('viewing').innerHTML = as ? `<span class="lbl">Viewing as</span><b>${esc(as)}</b><span class="x" aria-hidden="true">✕</span>` : '';
}

/**
 * Label review (admin team): a tool beside the pages while it is off, a mode on the right
 * ("Reviewing labels ✕") while it is on, as "View as" is.
 */
function showReview(on) {
  state.review = on;
  const can = Boolean(state.me?.admin);
  $('review').hidden = !can || on;
  $('toolsep').hidden = !can || on || $('pages').hidden;
  $('reviewing').hidden = !can || !on;
}

// The inbox comes in pages, newest activity first: the first page shows at once, older ones
// are fetched behind it (up to BACKFILL entries), and more on demand at the end of the list.
// Reloading the first page (live updates) keeps the older pages already here.
const BACKFILL = 1000;
const inboxUrl = () => (personal() ? '/api/inbox?view=personal' : `/api/inbox?team=${encodeURIComponent(state.team)}`);
const pageUrl = (before) => `${inboxUrl()}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
async function loadInbox(early = null) {
  const ahead = early && await early;
  const first = ahead && scopeOf(ahead) === scopeKey() ? ahead : await get(pageUrl());
  const prev = state.data && scopeOf(state.data) === scopeOf(first) && state.data.as === (state.as || null) ? state.data : null;
  first.as = state.as || null;
  first.page = first.page || { next: null };
  if (prev) {
    const keys = new Set(first.threads.map((t) => t.thread));
    first.threads = [...first.threads, ...prev.threads.filter((t) => !keys.has(t.thread))];
    first.people = { ...prev.people, ...first.people };
    // The deepest page loaded so far is where the next one starts.
    if (prev.page?.deeper) first.page = { ...first.page, next: prev.page.next, deeper: true };
  }
  state.data = first;
  // Personal's rooms grow once you are in a channel of another team: listen there too.
  if (first.rooms && !first.rooms.every((r) => state.rooms?.includes(r))) {
    state.rooms = first.rooms;
    syncSockets();
  }
  if (!state.as) checkBells(scopeKey(), first);
  mergeProfiles(state.data.profiles);
  renderUser();
  state.coPeople = coParticipants();
  state.scores = inPass(() => new Map(state.data.threads.map((t) => [t.thread, smartScore(t)])));
  render();
  backfill();
}

/** Adds an older page to the inbox: new entries only, with their scores and profiles. */
function addPage(p) {
  const keys = new Set(state.data.threads.map((t) => t.thread));
  const added = p.threads.filter((t) => !keys.has(t.thread));
  state.data.threads.push(...added);
  state.data.people = { ...(state.data.people || {}), ...(p.people || {}) };
  state.data.page = { ...state.data.page, next: p.page?.next || null, deeper: true };
  mergeProfiles(p.profiles);
  inPass(() => { for (const t of added) state.scores.set(t.thread, smartScore(t)); });
  state.coPeople = coParticipants();
  render();
}

let paging = null;
/** Fetches older pages one after the other, while idle, until `limit` entries are here. */
function backfill(limit = BACKFILL) {
  if (paging || !state.data?.page?.next || state.data.threads.length >= limit) return paging;
  const { as } = state.data;
  const scope = scopeOf(state.data);
  const same = () => state.data && scopeOf(state.data) === scope && state.data.as === as;
  paging = (async () => {
    while (same() && state.data.page?.next
      && state.data.threads.length < limit) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { if (window.requestIdleCallback) requestIdleCallback(r, { timeout: 1500 }); else setTimeout(r, 50); });
      // eslint-disable-next-line no-await-in-loop
      const p = await get(pageUrl(state.data.page.next)).catch(() => null);
      if (!p || !same()) break;
      addPage(p);
    }
  })().finally(() => { paging = null; if (state.data) renderThreads(); });
  return paging;
}
/** "Load older threads": one more page past what is here. */
function loadOlder() {
  backfill(state.data.threads.length + 1);
}
// Threads are fetched ahead, so opening one is instant: a queue, not a drop. A row that
// scrolls into view, the rows next to the open one and a row under the pointer all queue
// their thread; urgent ones (pointer, neighbours) go to the front. Six at a time.
const inflight = new Map(); // key -> the request, resolving with the thread or null
const queued = [];
const PREFETCH_AT_ONCE = 6;
// A fetched thread stays fresh for a minute, and for ten while its inbox entry says nothing
// happened in it (activity, messages, reactions, draft): rows that scroll into view again do not
// fetch their threads again (one person's tab fetched a thread 17 times in 40 minutes). Opening
// one fetches it again anyway, behind the copy (openThread).
const entrySig = (key) => {
  const t = searchEntry(key);
  return t ? [t.any_at, t.last_at, t.messages, (t.reactions || []).reduce((n, r) => n + r.count, 0), t.draft?.updated_at].join('|') : null;
};
const fresh = (key) => {
  const hit = state.cache.get(key);
  if (!hit) return false;
  const age = Date.now() - hit.at;
  return age < 60000 || (age < 600000 && hit.sig != null && hit.sig === entrySig(key));
};
function prefetch(key, { urgent = false } = {}) {
  if (!key || inflight.has(key) || fresh(key)) return;
  const at = queued.indexOf(key);
  if (at >= 0) { if (!urgent) return; queued.splice(at, 1); }
  if (urgent) queued.unshift(key); else queued.push(key);
  pump();
}
function pump() {
  while (inflight.size < PREFETCH_AT_ONCE && queued.length) {
    const key = queued.shift();
    if (inflight.has(key) || fresh(key)) continue;
    // What the entry said when it was asked for: a change after that makes the copy stale.
    const sig = entrySig(key);
    inflight.set(key, get(threadUrl(key))
      .then((data) => {
        if (!fresh(key)) state.cache.set(key, { data, at: Date.now(), sig });
        // A row whose preview the inbox did not send takes it from the copy (`preview`).
        if (!searchEntry(key)?.last_text) previewSoon();
        return data;
      })
      .catch(() => null) // opening it will try again
      .finally(() => { inflight.delete(key); pump(); }));
  }
}
/** The rows again once fetched threads give them their previews, one frame later. */
let previewFrame = 0;
function previewSoon() {
  if (!previewFrame) previewFrame = requestAnimationFrame(() => { previewFrame = 0; renderThreads(); });
}
/** The threads just before and after the open one (j / k), first in the queue. */
function prefetchAround(key) {
  const i = state.order.indexOf(key);
  if (i < 0) return;
  for (const k of [state.order[i + 2], state.order[i - 1], state.order[i + 1]]) prefetch(k, { urgent: true });
}
/**
 * The rooms someone's Personal listens to (GET /api/me's `rooms`): their teams', and those of
 * the teams the channels they posted or were mentioned in are filed under.
 */
const roomsOf = (who) => who.rooms || (who.teams || []).map((t) => t.slug);
/** The rooms of the inbox on screen: its team's, or for Personal its rooms. */
const screenTeams = () => (personal() ? state.rooms || [] : [state.team]).filter(Boolean);
/** One socket per team: the ones on screen, and the ones the notifications need (notifyTeams). */
const wantedTeams = () => [...new Set([...screenTeams(), ...notifyTeams()])];
/**
 * Live updates: the room of the team on screen, or for the personal view the rooms of all the
 * viewer's teams (every thread in it is in one of their inboxes, and announced there), and the
 * rooms the notifications listen to.
 */
function connect() {
  state.live += 1;
  for (const ws of state.sockets.splice(0)) ws.close();
  for (const team of wantedTeams()) listen(team, state.live);
}
/** Connects again only if the teams it needs changed (a bell on another team, say). */
function syncSockets() {
  const have = new Set(state.sockets.map((ws) => ws.team));
  const want = wantedTeams();
  if (want.length !== have.size || want.some((t) => !have.has(t))) connect();
}
function listen(team, live) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live?team=${encodeURIComponent(team)}${state.as ? `&as=${state.as}` : ''}`);
  ws.team = team;
  state.sockets.push(ws);
  // Reconnecting is only shown when it takes a while (not for a view switch or a blip).
  ws.onopen = () => {
    if (state.sockets.some((x) => x.readyState !== 1)) return;
    clearTimeout(state.offline); state.offline = null; $('offline').hidden = true;
  };
  ws.onclose = () => {
    const i = state.sockets.indexOf(ws);
    if (i < 0) return;
    state.sockets.splice(i, 1);
    setTimeout(() => { if (state.live === live) listen(team, live); }, 3000);
    state.offline ??= setTimeout(() => {
      $('offline').hidden = false;
      // Signed out (Access answers with a redirect, which app.js shows), or offline?
      fetch('/api/me', { credentials: 'same-origin' }).catch(() => {});
    }, 5000);
  };
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    noteEvent(ev, team);
    // A room only the notifications listen to: the inbox on screen is not its.
    if (!screenTeams().includes(team)) return;
    if (ev.type === 'read' && ev.person === state.me.id) return;
    if (ev.type === 'read') reloadSoon(ev.thread);
    // Threads folded into a group (re-threading): the open one, if it is among them, reopens as
    // its group; cached copies of them and of the group are out of date.
    if (ev.type === 'thread') {
      if (ev.folded) for (const k of [ev.thread, ...ev.folded]) if (k !== state.open) state.cache.delete(k);
      // Re-filed under another org or team (a rule change): cached copies say where they were.
      if (ev.moved) for (const k of ev.moved) if (k !== state.open) state.cache.delete(k);
      const open = ev.folded?.includes(state.open) || ev.moved?.includes(state.open);
      reloadSoon(open ? state.open : ev.thread);
    }
    // A draft was saved or discarded (by anyone on the team, in any tab).
    if (ev.type === 'draft') { state.cache.delete(ev.thread); reloadSoon(ev.thread); }
    if (ev.type === 'experts') { state.experts.delete(ev.thread); if (state.open === ev.thread) loadExperts(ev.thread); }
  };
}

// ---------------------------------------------------------------- notifications
// This browser shows them while an inbox is open (a tab, or the installed app, in the background
// too), through the service worker, so that a click opens the thread (src/pwa.js). Three kinds,
// all settings of the person (GET/PUT /api/settings, in D1, so every device has them; the user
// menu changes them):
// - a message that mentions you, on unless turned off: the room's `thread` event names the
//   people a message just posted newly mentions (src/normalizer.js);
// - a message in a thread of yours (you posted in it, were mentioned in it or put 👀 on it), on
//   unless turned off: the same event names those people;
// - a bell on a view (a team's inbox, or Personal, with the filters set on it): a thread in it
//   gets a message you have not read. The view's filters are checked on the inbox of the team
//   whose room announced it: the one on screen, when it is that view, else its first page.
// Inboxes open in several tabs show one notification per thread (its tag). Nothing is shown
// while viewing as someone else.
const BELL = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path class="body" d="M4 11V7.2a4 4 0 0 1 8 0V11l1.2 1.5H2.8z"/><path d="M6.6 14.2a1.5 1.5 0 0 0 2.8 0" stroke-linecap="round"/></svg>';
const PERSONAL_VIEW = '~personal';
const canNotify = () => 'Notification' in window;
const allowed = () => canNotify() && Notification.permission === 'granted';
const notifying = () => !state.as && allowed();
/** The views this inbox watches: from loading the page or turning a bell on, later messages count. */
const watch = {
  since: new Date().toISOString(), known: new Map(), timers: new Map(), noted: new Set(),
};

/** The view on screen as a bell: its inbox, and the filters of the cards it shows. */
function currentBell() {
  const ids = new Set(viewFacets().map((f) => f.id));
  const pick = (sets) => Object.fromEntries(Object.entries(sets)
    .filter(([id, set]) => ids.has(id) && set.size).map(([id, set]) => [id, [...set].sort()]));
  return { view: scopeKey(), sel: pick(state.sel), not: pick(state.not) };
}
// As src/settings.js compares them.
const bellKey = (b) => JSON.stringify([b.view, Object.entries(b.sel || {}).sort(), Object.entries(b.not || {}).sort()]);
const bellOn = () => (state.settings?.bells || []).some((b) => bellKey(b) === bellKey(currentBell()));
const viewName = (view) => (view === PERSONAL_VIEW ? 'Personal' : state.teams?.find((t) => t.slug === view)?.name || view);
const valueLabel = (f, v) => (f && ((f.labelFn && f.labelFn(v)) || (f.label && f.label[v]))) || v;
/** A bell's name: the view, and its filters as the cards say them. */
function bellLabel(b) {
  const f = (id) => FACETS.find((x) => x.id === id);
  const parts = [
    ...Object.entries(b.sel).map(([id, vs]) => vs.map((v) => valueLabel(f(id), v)).join(' or ')),
    ...Object.entries(b.not).flatMap(([id, vs]) => vs.map((v) => `not ${valueLabel(f(id), v)}`)),
  ];
  return parts.length ? `${viewName(b.view)}: ${parts.join(', ')}` : viewName(b.view);
}
/** A bell's view as an address: the inbox with its filters. */
function bellHref(b) {
  const q = new URLSearchParams();
  if (b.view === PERSONAL_VIEW) q.set('view', 'personal'); else q.set('team', b.view);
  q.set('filters', '1');
  for (const [id, vs] of Object.entries(b.sel)) q.set(`f.${id}`, vs.join('|'));
  for (const [id, vs] of Object.entries(b.not)) q.set(`not.${id}`, vs.join('|'));
  return `/inbox?${q}`;
}

/**
 * Changes settings at once here, then on the server; back as they were if that fails. As
 * src/settings.js: `channelTraces` changes the channels it names (null: as everywhere again).
 */
async function saveSettings(patch) {
  const before = state.settings;
  const next = { ...before, ...patch };
  if (patch.channelTraces) {
    next.channelTraces = { ...before.channelTraces };
    for (const [id, on] of Object.entries(patch.channelTraces)) {
      if (on === null) delete next.channelTraces[id]; else next.channelTraces[id] = on;
    }
  }
  state.settings = next;
  const shown = () => { renderNotify(); renderTraces(); renderThreads(); };
  shown(); syncSockets(); tracesChanged(before);
  const res = await request('PUT', '/api/settings', patch).catch((e) => ({ ok: false, data: { error: e.message } }));
  if (res.ok) { state.settings = res.data; shown(); return true; }
  const tried = state.settings;
  state.settings = before;
  shown(); syncSockets(); tracesChanged(tried);
  toast(`Could not save your settings: ${res.data.error || res.status}`);
  return false;
}

// ---------------------------------------------------------------- the agent's thinking
// Whether the thread agent's thinking shows under the threads (agentItem), in the user menu:
// everywhere, and in the open thread's channel, which wins. The Agents page has them too, by
// channel. Not while viewing as someone else.

/** The open thread's channel, as the menu names it. */
function channelLabel(t) {
  const name = t.channel_name || t.channel_id;
  return t.source === 'teams' ? name : `#${name}`;
}

function renderTraces() {
  const box = $('tracesBox');
  box.hidden = Boolean(state.as) || !state.settings;
  if (box.hidden) return;
  const all = state.settings.traces !== false;
  $('tracesAll').setAttribute('aria-checked', String(all));
  const t = state.open && threadRow(state.open);
  $('tracesHere').hidden = !t?.channel_id;
  if (t?.channel_id) {
    const own = state.settings.channelTraces?.[t.channel_id];
    $('tracesChannelLabel').textContent = `In ${channelLabel(t)}, the open thread's channel`;
    $('tracesChannel').options[0].textContent = `As everywhere (${all ? 'shown' : 'hidden'})`;
    $('tracesChannel').value = typeof own === 'boolean' ? (own ? 'on' : 'off') : '';
  }
  const set = Object.keys(state.settings.channelTraces || {}).length;
  $('tracesHint').textContent = `What it is doing while it works, and its note once done; only for you.${set
    ? ` Set in ${set} channel${set === 1 ? '' : 's'} on ${set === 1 ? 'its' : 'their'} own, which win${set === 1 ? 's' : ''}: Agents lists them.` : ''}`;
}

/** The open thread's agent, after the settings changed from `before`: shown (asked again) or gone. */
function tracesChanged(before) {
  const key = state.open;
  const channel = key && threadRow(key)?.channel_id;
  if (!channel) return;
  const was = typeof before?.channelTraces?.[channel] === 'boolean' ? before.channelTraces[channel] : before?.traces !== false;
  if (was === tracesShown(channel)) return;
  if (tracesShown(channel)) loadAgent(key); else placeAgent(key);
}

function wireTraces() {
  $('tracesAll').onclick = () => saveSettings({ traces: state.settings.traces === false });
  $('tracesChannel').onchange = () => {
    const channel = state.open && threadRow(state.open)?.channel_id;
    if (!channel) return;
    const v = $('tracesChannel').value;
    saveSettings({ channelTraces: { [channel]: v === '' ? null : v === 'on' } });
  };
  // The open thread's channel, as the menu opens.
  $('menu').addEventListener('beforetoggle', (e) => { if (e.newState === 'open') renderTraces(); });
  renderTraces();
}

/** Asks the browser to allow notifications (only on a click). True if they are allowed. */
async function askToNotify() {
  if (!canNotify()) { toast('This browser does not show notifications.'); return false; }
  if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
  renderNotify();
  if (Notification.permission === 'denied') toast('Notifications are blocked for this site: allow them in this browser\'s site settings.');
  return Notification.permission === 'granted';
}

/** The bell above the list: on, for the view on screen with its filters, or off again. */
async function toggleBell() {
  if (state.as) return;
  const bell = currentBell();
  const bells = state.settings.bells || [];
  if (bellOn()) {
    if (await saveSettings({ bells: bells.filter((b) => bellKey(b) !== bellKey(bell)) })) toast(`No more notifications for ${bellLabel(bell)}.`);
    return;
  }
  if (bells.length >= 20) { toast('That is 20 views with notifications already: turn one off in the menu first.'); return; }
  const ok = await askToNotify();
  if (await saveSettings({ bells: [...bells, bell] })) {
    toast(`${ok ? 'You get a notification' : 'Once this browser allows notifications, you get one'} when a thread in ${bellLabel(bell)} gets a new message.`);
  }
}

/** The notifications section of the user menu. */
function renderNotify() {
  const box = $('notifyBox');
  box.hidden = Boolean(state.as);
  if (box.hidden) return;
  const s = state.settings;
  $('notifyMentions').setAttribute('aria-checked', String(Boolean(s.mentions)));
  $('notifyThreads').setAttribute('aria-checked', String(Boolean(s.threads)));
  $('bells').innerHTML = (s.bells || []).map((b, i) => `<div class="bell">${BELL}<a href="${esc(bellHref(b))}" title="${esc(bellLabel(b))}">${esc(bellLabel(b))}</a><button type="button" data-unbell="${i}" title="Turn off notifications for this view" aria-label="Turn off notifications for ${esc(bellLabel(b))}">✕</button></div>`).join('');
  const perm = canNotify() ? Notification.permission : 'unsupported';
  const wanted = s.mentions || s.threads || s.bells?.length;
  $('notifyHint').textContent = {
    unsupported: 'This browser does not show notifications.',
    denied: 'Blocked for this site in this browser: allow notifications in its site settings.',
    default: wanted ? 'This browser has not been allowed to show them yet.' : '',
    granted: '',
  }[perm] || '';
  if (perm === 'granted') $('notifyHint').textContent = s.bells?.length ? 'While the inbox is open, in a tab or as the app.' : 'While the inbox is open. The bell above the list adds the view on screen.';
  $('notifyAllow').hidden = perm !== 'default';
}
function wireNotify() {
  const toggle = (key) => async () => {
    const on = !state.settings[key];
    if (on) await askToNotify();
    saveSettings({ [key]: on });
  };
  $('notifyMentions').onclick = toggle('mentions');
  $('notifyThreads').onclick = toggle('threads');
  $('notifyAllow').onclick = () => askToNotify();
  $('bells').onclick = (e) => {
    const x = e.target.closest('[data-unbell]');
    if (!x) return;
    const bells = [...state.settings.bells];
    bells.splice(Number(x.dataset.unbell), 1);
    saveSettings({ bells });
  };
  // A click on a notification, in an inbox already open: it opens the thread here.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'opspile:open') openFromNote(e.data.url); });
    navigator.serviceWorker.startMessages?.();
  }
  renderNotify();
  // Mentions and your threads notify unless turned off, once the browser allows it: asked for
  // once, on a click.
  if (!state.as && (state.settings.mentions || state.settings.threads) && canNotify()
    && Notification.permission === 'default' && !localStorage.getItem('opspile.notify.asked')) {
    localStorage.setItem('opspile.notify.asked', '1');
    toast('Get a notification when someone mentions you or writes in your threads?', { label: 'Allow', run: askToNotify });
  }
}

/** The teams whose rooms the notifications need: all of yours for mentions, threads, Personal. */
function notifyTeams() {
  if (state.as || !state.settings) return [];
  const all = state.rooms || [];
  const bells = state.settings.bells || [];
  if (state.settings.mentions || state.settings.threads
    || bells.some((b) => b.view === PERSONAL_VIEW)) return all;
  return all.filter((slug) => bells.some((b) => b.view === slug));
}

const noteUrl = (scope, thread) => {
  const q = new URLSearchParams(scope === PERSONAL_VIEW ? { view: 'personal' } : { team: scope });
  q.set('t', thread);
  return `/inbox?${q}`;
};
/** Shows one, unless the thread is on screen in a focused window or this message was shown. */
async function showNote({
  thread, at, title, body, url,
}) {
  const id = `${thread}@${at}`;
  if (!notifying() || watch.noted.has(id)) return;
  if (document.hasFocus() && document.visibilityState === 'visible' && state.open === thread) return;
  watch.noted.add(id);
  const opts = {
    body, tag: `opspile:${thread}`, icon: '/icon-192.png', badge: '/icon-192.png', data: { url },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch {
    // no service worker: a plain one, below
  }
  const n = new Notification(title, opts);
  n.onclick = () => { window.focus(); n.close(); openFromNote(url); };
}
/** The thread a notification is about, in the inbox it names. */
async function openFromNote(url) {
  const q = new URL(url, location.href).searchParams;
  const view = q.get('view') === 'personal' ? null : q.get('team');
  if (view && !(state.teams || []).some((t) => t.slug === view)) return;
  window.focus();
  await switchView(view);
  if (q.get('t')) openThread(q.get('t'));
}

/** Text for a notification: emoji as characters, without markup, on one line, clipped. */
const clipNote = (s, n = 160) => {
  const v = String(s || '').replace(EMOJI_CODE, (m, name) => emojiByName(name) || m)
    .replace(/<@[^>]+>/g, '@…').replace(/[*_~`>#]/g, '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
/** A message that mentions you, or else is in a thread of yours: who wrote what, in which thread. */
async function noteMessage(ev, team) {
  const me = state.me.id;
  const atMe = state.settings?.mentions && ev.mentions?.includes(me);
  const mine = state.settings?.threads && ev.involved?.includes(me);
  if (!(atMe || mine) || !notifying() || ev.by === me) return;
  const known = state.data?.threads.find((t) => t.thread === ev.thread || t.members?.some((m) => m.thread === ev.thread));
  let data = null;
  try { data = await get(`/api/thread?thread=${encodeURIComponent(ev.thread)}&team=${encodeURIComponent(team)}`); } catch { /* the title is enough */ }
  const msg = data?.messages?.findLast((m) => m.at === ev.at) || data?.messages?.at(-1);
  const title = data?.thread?.title || known?.title || 'a thread';
  showNote({
    thread: known?.thread || ev.thread,
    at: ev.at,
    title: `${ev.author || 'Someone'} ${atMe ? 'mentioned you' : 'wrote in your thread'}`,
    body: `${clipNote(title, 80)}${msg?.body ? `\n${clipNote(msg.body)}` : ''}`,
    // A room that is not one of your teams' (you are on none): the thread is in Personal.
    url: noteUrl((state.teams || []).some((t) => t.slug === team) ? team : PERSONAL_VIEW, known?.thread || ev.thread),
  });
}

/**
 * Whether thread `t` of inbox `data` is in bell `b`'s view. The facets work on the inbox on
 * screen (`state`): it is swapped for the bell's for the moment of the check, which is
 * synchronous, so nothing on screen sees it.
 */
function inBell(b, data, t) {
  const keys = ['data', 'sort', 'team', 'sel', 'not', 'unread', 'list', 'coPeople'];
  const saved = Object.fromEntries(keys.map((k) => [k, state[k]]));
  const savedPass = pass;
  const sets = (o) => Object.fromEntries(Object.entries(o).map(([id, vs]) => [id, new Set(vs)]));
  try {
    pass = null;
    Object.assign(state, {
      data,
      sort: b.view === PERSONAL_VIEW ? 'personal' : 'team',
      team: b.view === PERSONAL_VIEW ? state.team : b.view,
      sel: sets(b.sel),
      not: sets(b.not),
      unread: false,
      list: newList(),
    });
    state.coPeople = coParticipants();
    return inPass(() => passes(t));
  } finally {
    Object.assign(state, saved);
    pass = savedPass;
  }
}
/**
 * An inbox (`scope`: a team's slug, or `~personal`) as it is now: its threads with a message
 * since it was last looked at (or since the page was loaded) that you have not read, and that
 * are in one of its bells' views, notify.
 */
function checkBells(scope, data) {
  const bells = (state.settings?.bells || []).filter((b) => b.view === scope);
  const known = watch.known.get(scope) || new Map();
  watch.known.set(scope, known);
  for (const t of data.threads || []) {
    const at = lastOf(t);
    const was = known.get(t.thread) || watch.since;
    if (at) known.set(t.thread, at > was ? at : was);
    if (!at || at <= was || !t.unread || !bells.length || state.as) continue;
    const b = bells.find((x) => inBell(x, data, t));
    if (!b) continue;
    showNote({
      thread: t.thread,
      at,
      title: clipNote(t.title || '(no text)', 80),
      body: `${t.last_author ? `${t.last_author} wrote` : 'New message'} · ${orgName(t)}\n🔔 ${bellLabel(b)}`,
      url: noteUrl(scope, t.thread),
    });
  }
}
/** A room announced activity: the bells on inboxes that are not on screen look again, soon. */
function bellsSoon(team) {
  if (state.as) return;
  const scopes = new Set((state.settings?.bells || []).map((b) => b.view)
    .filter((v) => v === team || (v === PERSONAL_VIEW && (state.rooms || []).includes(team))));
  for (const scope of scopes) {
    // The inbox on screen reloads on its own (reloadSoon), and is checked then.
    if (scope === scopeKey()) continue;
    clearTimeout(watch.timers.get(scope));
    watch.timers.set(scope, setTimeout(async () => {
      watch.timers.delete(scope);
      const url = scope === PERSONAL_VIEW ? '/api/inbox?view=personal' : `/api/inbox?team=${encodeURIComponent(scope)}`;
      const data = await get(url).catch(() => null);
      if (data && !state.as) checkBells(scope, data);
    }, 1500));
  }
}
/** Activity a room announced, for the notifications. */
function noteEvent(ev, team) {
  if (ev.type !== 'thread' || state.as) return;
  noteMessage(ev, team);
  bellsSoon(team);
}

/** Unread only, on or off: a new list (see syncList), which keeps the open thread. */
function setUnread(on) {
  state.unread = on;
}

// ---------------------------------------------------------------- URL state
function toUrl(push = true, entry = null) {
  const q = new URLSearchParams();
  if (personal()) q.set('view', 'personal'); else q.set('team', state.team);
  q.set('filters', '1');
  for (const [id, set] of Object.entries(state.sel)) if (set.size) q.set(`f.${id}`, [...set].join('|'));
  for (const [id, set] of Object.entries(state.not)) if (set.size) q.set(`not.${id}`, [...set].join('|'));
  if (state.open) q.set('t', state.open);
  if (state.compose) q.set('compose', '1');
  if (state.review) q.set('review', '1');
  if (state.unread) q.set('unread', '1');
  if (state.as) q.set('as', String(state.as));
  if (state.search.q) q.set('q', state.search.q);
  const url = `${location.pathname}?${q}`;
  if (url !== `${location.pathname}${location.search}`) history[push ? 'pushState' : 'replaceState'](entry, '', url);
}
/** The customer on screen: the open thread's, else the one filtered on. */
function customerOnScreen() {
  const open = state.open && (state.data?.threads.find((t) => t.thread === state.open)
    || state.cache.get(state.open)?.data?.thread);
  const customers = state.sel.customer;
  return open ? open.org : (customers?.size === 1 ? [...customers][0] : null);
}
/**
 * The knowledge-base editor for what is on screen: the customer's knowledge base (see
 * customerOnScreen), else the team's; the editor picks whichever of them exists.
 */
function kbHref() {
  const q = new URLSearchParams();
  const org = customerOnScreen();
  if (org) q.set('org', org);
  if (state.team && !personal()) q.set('team', state.team);
  return `/inbox/kb${q.size ? `?${q}` : ''}`;
}
/**
 * Whether an address asks for the personal view: it is the default, so any address without a
 * team does. `sort=personal` (and `recent`, before it) is how it was asked for before.
 */
const personalAsked = (q) => q.get('view') === 'personal' || ['personal', 'recent'].includes(q.get('sort'))
  || !q.get('team');
function fromUrl() {
  const q = new URLSearchParams(location.search);
  const team = q.get('team');
  state.team = team || state.me.teams[0]?.slug;
  if (q.has('filters')) {
    state.sel = {};
    state.not = {};
    for (const [k, v] of q) if (k.startsWith('f.') && v) state.sel[k.slice(2)] = new Set(v.split('|'));
    // Excluded wins over picked, should a hand-made URL have a value in both.
    for (const [k, v] of q) {
      if (!k.startsWith('not.') || !v) continue;
      const id = k.slice(4);
      state.not[id] = new Set(v.split('|'));
      for (const x of state.not[id]) state.sel[id]?.delete(x);
      if (!state.sel[id]?.size) delete state.sel[id];
    }
  }
  state.sort = personalAsked(q) ? 'personal' : 'team';
  onePick();
  setUnread(q.get('unread') === '1');
  state.as = Number(q.get('as')) || null;
  return {
    open: q.get('t'), compose: q.get('compose') === '1' && !state.as, review: q.get('review') === '1', q: q.get('q') || '',
  };
}

// ---------------------------------------------------------------- narrow screens
// Under 700px the list and the open thread take turns (`main.reading` while one is open), and
// under 1100px the filter cards are in a drawer (`main.filtering` while it is open).
const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
const syncReading = () => document.querySelector('main').classList.toggle('reading', Boolean(state.open || state.compose));
/** Back to the list: the browser's Back when the list is the entry before, so Forward reopens the thread. */
function closeThread() {
  dismissExperts();
  if (history.state?.list) { history.back(); return; }
  Object.assign(state, { open: null, compose: null, awaiting: null });
  closeMentions();
  syncReading();
  renderThreads();
  $('pane').innerHTML = '<div class="empty">Pick a thread.</div>';
  toUrl();
}
function setFiltering(on) {
  state.filtering = on;
  document.querySelector('main').classList.toggle('filtering', on);
  renderThreads();
}

/*
 * The filter column folded to a rail (`main.rail`), between the drawer and room for all of it:
 * in every view, from 1100px up to the width of a 13" MacBook's screen (1440px on a Pro,
 * 1470px on an Air), so the full column only shows on bigger screens. Under 1100px it is the
 * drawer (phones, tablets upright). `<html data-rail="on|off">` overrides that (the width
 * controls of `npm run ui:dev` set it). The rail slides out under
 * the pointer; on a touch screen, a tap on it slides it out (`main.railopen`) instead of
 * filtering, and a tap beside it folds it again.
 */
const RAIL_BAND = matchMedia('(min-width: 1100px) and (max-width: 1470px)');
const WIDE = matchMedia('(min-width: 1100px)');
let lastPointer = 'mouse';
function syncRail() {
  const main = document.querySelector('main');
  const force = document.documentElement.dataset.rail;
  const on = WIDE.matches && (force ? force === 'on' : RAIL_BAND.matches);
  main.classList.toggle('rail', on);
  if (!on) main.classList.remove('railopen');
}
function wireRail() {
  const main = document.querySelector('main');
  for (const mq of [RAIL_BAND, WIDE]) mq.addEventListener('change', syncRail);
  window.addEventListener('resize', syncRail);
  addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, { capture: true });
  // Before the filter cards' own click: a tap on the folded rail only slides it out.
  $('filters').addEventListener('click', (e) => {
    if (!main.classList.contains('rail') || main.classList.contains('railopen') || lastPointer === 'mouse') return;
    if (!e.target.closest('.card')) return;
    e.stopImmediatePropagation();
    main.classList.add('railopen');
  }, { capture: true });
  document.addEventListener('click', (e) => {
    if (main.classList.contains('railopen') && !e.target.closest('#filters')) main.classList.remove('railopen');
  }, { capture: true });
  syncRail();
}

// The filter drawer's swipes: one to the right over the list pulls it in, one to the left over
// it (or over the dimmed page beside it) pushes it out. The drawer follows the finger; when it
// lifts, a flick goes the way it went, a slow drag to the nearer end. Safari keeps a swipe from
// the screen's very edge for Back while there is a page to go back to.
const DRAWER = matchMedia('(max-width: 1099px)');
const TAKING_TURNS = matchMedia('(max-width: 699px)');
/** Whether the drawer ends up open: `pull` 0 (shut) to 1 (open), `speed` in px/ms, right positive. */
const drawerOpens = (pull, speed) => (Math.abs(speed) > 0.3 ? speed > 0 : pull > 0.5);
/** A touch that moved `dx`, `dy` from where it started: a swipe for the drawer, or the page's scroll. */
const drawerSwipe = (dx, dy, open) => Math.abs(dx) > 1.5 * Math.abs(dy) && (dx > 0) !== open;
function wireDrawerSwipes() {
  const main = document.querySelector('main');
  let s = null;
  main.addEventListener('touchstart', (e) => {
    s = null;
    if (!DRAWER.matches || e.touches.length !== 1) return;
    // Open: the drawer or the dimmed page beside it (main's ::after). Shut: the list, when it is on screen.
    const where = state.filtering ? e.target === main || e.target.closest('#filters')
      : e.target.closest('#threads') && !(TAKING_TURNS.matches && state.open);
    if (!where) return;
    const t = e.touches[0];
    s = {
      x: t.clientX, y: t.clientY, open: state.filtering, width: $('filters').offsetWidth || 1,
      swiping: null, pull: state.filtering ? 1 : 0, lastX: t.clientX, lastT: e.timeStamp, speed: 0,
    };
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (!s || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    if (s.swiping === null) {
      if (Math.hypot(dx, t.clientY - s.y) < 10) return;
      s.swiping = drawerSwipe(dx, t.clientY - s.y, s.open);
      if (s.swiping) main.classList.add('dragging');
    }
    if (!s.swiping) return;
    e.preventDefault();
    const dt = e.timeStamp - s.lastT;
    if (dt > 0) s.speed = 0.6 * ((t.clientX - s.lastX) / dt) + 0.4 * s.speed;
    s.lastX = t.clientX;
    s.lastT = e.timeStamp;
    s.pull = Math.min(1, Math.max(0, (s.open ? 1 : 0) + dx / s.width));
    main.style.setProperty('--pull', String(s.pull));
  }, { passive: false });
  const end = (e) => {
    const swipe = s;
    s = null;
    if (!swipe?.swiping) return;
    // The lifted finger taps nothing (no thread opens under it).
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    // A finger that stopped before it lifted is no flick.
    const speed = e.timeStamp - swipe.lastT > 100 ? 0 : swipe.speed;
    const open = e.type === 'touchend' ? drawerOpens(swipe.pull, speed) : swipe.open;
    main.classList.remove('dragging');
    main.style.removeProperty('--pull');
    if (open !== state.filtering) setFiltering(open);
  };
  main.addEventListener('touchend', end, { passive: false });
  main.addEventListener('touchcancel', end);
}

// ---------------------------------------------------------------- wiring
function move(step) {
  if (!state.order.length) return;
  const i = state.order.indexOf(state.open);
  const next = state.order[Math.max(0, Math.min(state.order.length - 1, i < 0 ? 0 : i + step))];
  if (next && next !== state.open) {
    if (searching()) openHit(next); else openThread(next);
    document.querySelector(`#threads .t[data-thread="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

/** Shows a team's inbox (`slug`), or the personal view (no slug). */
async function switchView(slug) {
  const was = scopeKey();
  if (slug) state.team = slug;
  state.sort = slug ? 'team' : 'personal';
  onePick();
  if (scopeKey() === was) { render(); toUrl(); return; }
  Object.assign(state, { open: null, compose: null, awaiting: null, prevKeys: null });
  // A thread of a shared channel shows the read state of the team it is looked at from.
  state.cache.clear();
  syncReading();
  renderUser();
  render();
  $('pane').innerHTML = '<div class="empty">Pick a thread.</div>';
  toUrl(); await loadInbox(); connect();
  // The search goes on in the other view.
  if (searching()) { state.search.data = null; const q = state.search.q; state.search.q = ''; runSearch(q); }
}

async function start() {
  // The view is known from the address (personal, unless it names a team): its inbox is
  // fetched alongside /api/me instead of after it. Viewing as someone else waits, as their
  // teams decide.
  const asked = new URLSearchParams(location.search);
  const early = asked.get('as') ? null
    : get(personalAsked(asked) ? '/api/inbox?view=personal' : `/api/inbox?team=${encodeURIComponent(asked.get('team'))}`).catch(() => null);
  try { state.me = await get('/api/me'); } catch (e) { $('threads').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  state.teams = state.me.teams;
  state.rooms = roomsOf(state.me);
  state.settings = state.me.settings || {
    mentions: true, bells: [], traces: true, channelTraces: {},
  };
  const q = new URLSearchParams(location.search);
  if (q.get('connected')) toast(q.get('connected') === 'discord' ? 'Connected your Discord account: your posts there count as yours.'
    : `Connected your ${accountOf(q.get('connected'))} account. Replies are sent as you.`);
  if (q.get('connect_error')) toast(`Could not connect: ${q.get('connect_error')}`);
  const initial = fromUrl();
  state.search.q = initial.q;
  // The thread the URL opens is open from the start: settling the URL keeps it, and opening it
  // adds no history entry (Back from here leaves the inbox, to where it came from).
  state.open = initial.open || null;
  syncReading();
  await loadWho();
  toUrl(false);
  $('filters').onclick = (e) => {
    const el = e.target.closest('.card');
    if (!el) return;
    if (e.target.dataset.clear) {
      for (const f of cardFacets(el.dataset.f)) { delete state.sel[f.id]; delete state.not[f.id]; }
      render(); toUrl(); return;
    }
    const r = e.target.closest('.fr');
    if (!r || r.dataset.v === undefined) return;
    toggleFilter(r.dataset.f, r.dataset.v, e.shiftKey || Boolean(e.target.closest('[data-not]')));
    render();
    toUrl();
  };
  // Shift-click excludes: it should not select the labels it passes over.
  $('filters').addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('.fr')) e.preventDefault(); });
  // A row under the pointer is about to be opened: fetch it first.
  $('threads').addEventListener('pointerover', (e) => {
    const t = e.target.closest('.t');
    if (t) prefetch(t.dataset.thread, { urgent: true });
  });
  $('threads').addEventListener('click', (e) => { if (e.target.closest('[data-older]')) loadOlder(); });
  $('threads').addEventListener('scroll', seenSoon, { passive: true });
  window.addEventListener('resize', seenSoon, { passive: true });
  $('threads').onclick = (e) => {
    if (e.target.closest('[data-filters]')) { setFiltering(!state.filtering); return; }
    const view = e.target.closest('[data-view]');
    // A click on the view already shown sorts it afresh, without the threads unread only kept.
    if (view) { if (view.getAttribute('aria-checked') === 'true') state.list.key = null; switchView(view.dataset.view || null); return; }
    if (e.target.closest('[data-unread]')) { setUnread(!state.unread); render(); toUrl(); return; }
    if (e.target.closest('[data-bell]')) { toggleBell(); return; }
    if (e.target.closest('[data-compose]')) { if (state.compose) closeThread(); else openCompose(); return; }
    if (e.target.closest('[data-clearq]')) { clearSearch(); $('q')?.focus(); return; }
    if (e.target.closest('[data-unfilter]')) { state.sel = {}; state.not = {}; setUnread(false); render(); toUrl(); return; }
    if (e.target.closest('a, .find')) return;
    const el = e.target.closest('.t');
    if (el && el.dataset.hit) openHit(el.dataset.thread);
    else if (el) { recordPick(el.dataset.thread); openThread(el.dataset.thread); }
  };
  // A tap on the dimmed page beside the filter drawer closes it.
  document.querySelector('main').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && state.filtering) setFiltering(false);
  });
  wireDrawerSwipes();
  wireRail();
  $('pane').onclick = async (e) => {
    if (e.target.closest('[data-close]')) { closeThread(); return; }
    if (e.target.closest('[data-rechannel]')) { setChannel(null); return; }
    const inbox = e.target.closest('a[data-inbox]');
    if (inbox && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button)) { e.preventDefault(); openInbox(inbox.getAttribute('href')); return; }
    const retry = e.target.closest('[data-retry]');
    if (retry) { retrySend(retry.dataset.retry); return; }
    const unsend = e.target.closest('[data-unsend]');
    if (unsend) { discardSend(unsend.dataset.unsend); return; }
    const msg = e.target.closest('.msg');
    const pick = e.target.closest('[data-pick]');
    const chip = e.target.closest('.rx button');
    if (msg && e.target.closest('[data-edit]')) { startEdit(msg.dataset.id); return; }
    if (msg && e.target.closest('[data-edit-save]')) { saveEdit(); return; }
    if (msg && e.target.closest('[data-edit-cancel]')) { cancelEdit(); return; }
    if (msg && e.target.closest('[data-picker]')) { openPicker(e.target.closest('[data-picker]')); return; }
    if (msg && pick) {
      const same = [...msg.querySelectorAll('.rx button')].find((b) => emoji(b.dataset.emoji) === emoji(pick.dataset.pick));
      const mine = same?.dataset.mine;
      closePicker();
      // Taking one off uses the name it is stored under (Slack has aliases).
      react(msg.dataset.id, mine ? same.dataset.emoji : pick.dataset.pick, Boolean(mine));
      return;
    }
    if (msg && chip) { react(msg.dataset.id, chip.dataset.emoji, Boolean(chip.dataset.mine)); return; }
    if (!e.target.closest('.picker')) closePicker();
    const panel = e.target.closest('.rv');
    const b = e.target.closest('.rv button');
    if (!panel || !b) return;
    const thread = panel.dataset.thread;
    const staged = state.staged[thread] || (state.staged[thread] = {});
    if (b.dataset.q) {
      if (staged[b.dataset.q] === b.dataset.v) delete staged[b.dataset.q]; else staged[b.dataset.q] = b.dataset.v;
      openThread(state.open, { live: true, cached: true });
      return;
    }
    // "All correct" confirms Clef's answers; "Apply" sends the picks.
    const model = state.cache.get(state.open)?.data?.model;
    const answers = b.dataset.confirm && model
      ? Object.fromEntries(Object.keys(QUESTION_LABEL).map((k) => [k, modelValue(model, k)]).filter(([, v]) => v != null))
      : staged;
    for (const [question, value] of Object.entries(answers)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch('/api/review', { method: 'POST', credentials: 'same-origin', body: JSON.stringify({ thread, question, value }) });
      // eslint-disable-next-line no-await-in-loop
      if (!res.ok) { toast((await res.json()).error || res.status); return; }
    }
    delete state.staged[thread];
    toast(`Saved ${Object.keys(answers).length} answer(s).`);
    openThread(state.open, { live: true });
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.filtering) { setFiltering(false); return; }
    if (e.key === 'Escape' && document.querySelector('.picker')) {
      const button = document.querySelector('.picker').closest('.col')?.querySelector('[data-picker]');
      closePicker();
      button?.focus();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === '/' && $('q')) { e.preventDefault(); if (TAKING_TURNS.matches && state.open) closeThread(); $('q').focus(); $('q').select(); return; }
    if (e.key === 'j') { e.preventDefault(); move(1); }
    if (e.key === 'k') { e.preventDefault(); move(-1); }
    if (e.key === 'e') { e.preventDefault(); toggleResolve(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.picker, [data-picker]')) closePicker(); });
  document.addEventListener('click', (e) => { if (state.expertsOpen && !e.target.closest('#experts')) closeExperts(state.expertsOpen); });
  // Leaving the page with the expert finder's ▾ list open: nobody was picked from it.
  addEventListener('pagehide', () => dismissExperts());
  // The Send button's menu closes on a tap or click anywhere else.
  document.addEventListener('pointerdown', (e) => { if ($('hold') && !e.target.closest('.sendwrap')) $('hold').hidden = true; });
  wireLightbox();
  wireFiles();
  wireDrop();
  window.addEventListener('popstate', async (e) => {
    // Safari's edge swipe has already slid the list or the thread into view: no second slide.
    const main = document.querySelector('main');
    main.classList.toggle('instant', Boolean(e.hasUAVisualTransition));
    const scope = scopeKey();
    const {
      open, compose, review, q: query,
    } = fromUrl();
    if (!compose) Object.assign(state, { compose: null, awaiting: null });
    renderUser();
    if (scope !== scopeKey()) { state.prevKeys = null; state.cache.clear(); state.search.data = null; await loadInbox(); connect(); }
    if (query !== state.search.q || !state.search.data) runSearch(query);
    showReview(review);
    render();
    if (compose) { if (!state.compose) openCompose({ push: false }); } else if (open && open !== state.open) openThread(open); else if (!open) { dismissExperts(); state.open = null; $('pane').innerHTML = '<div class="empty">Pick a thread.</div>'; }
    syncReading();
    // The styles are applied without transitions before they come back.
    main.getBoundingClientRect();
    main.classList.remove('instant');
  });
  // The pages (ui/header.js): the editor for every member of a team (read-only, but for their
  // own settings, unless they manage it), the admin pages for the admin team and team
  // managers. What is on screen picks what they open on: Agents and Orgs the customer on
  // screen, Teams the team picked (one you may manage); with nothing on screen they open as
  // they were left, and Agents, not opened yet in this tab, on the team. Stats (klickhaus) opens
  // on the customer on screen and the team whose inbox it is, either or both, else on all. The
  // open requests are the admin team's own, not shown while viewing as someone.
  const teamOnScreen = () => (!personal() && state.team
    && (state.me.admin || state.me.manages?.includes(state.team)) ? state.team : null);
  Header.init(state.me, {
    prefer: {
      agents: () => (customerOnScreen() ? kbHref() : null),
      teams: () => (teamOnScreen() ? `/inbox/admin?tab=teams&team=${encodeURIComponent(teamOnScreen())}` : null),
      orgs: () => (customerOnScreen() ? `/inbox/admin?tab=orgs&org=${encodeURIComponent(customerOnScreen())}` : null),
      stats: () => Header.stats({ org: customerOnScreen(), team: personal() ? null : state.team }),
    },
    fallback: { agents: kbHref },
    count: !state.as,
  });
  if (state.me.admin) {
    const sel = $('as');
    $('asBox').hidden = false;
    get('/api/people').then(({ people }) => {
      sel.innerHTML = `<option value="">Me</option>${people.filter((p) => p.id !== state.me.id).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}`;
      sel.value = state.as ? String(state.as) : '';
    });
    const viewAs = async (id) => {
      state.as = id;
      sel.value = id ? String(id) : '';
      state.cache.clear();
      state.prevKeys = null;
      Object.assign(state, { open: null, compose: null, awaiting: null });
      syncReading();
      $('pane').innerHTML = '<div class="empty">Pick a thread.</div>';
      await loadWho();
      renderNotify();
      toUrl();
      await loadInbox();
      connect();
    };
    sel.onchange = () => { $('menu').hidePopover(); viewAs(Number(sel.value) || null); };
    $('viewing').onclick = () => viewAs(null);
    get('/api/review/queue').then((r) => { state.answers = r.answers; });
    const toggle = () => {
      showReview(!state.review);
      toUrl();
      if (state.open) openThread(state.open, { live: true });
    };
    $('review').onclick = toggle;
    $('reviewing').onclick = toggle;
    showReview(state.review);
  }
  wireNotify();
  wireTraces();
  // A search in the address is asked for alongside the inbox.
  if (initial.q) runSearch(initial.q);
  await loadInbox(early);
  loadOwnEmoji();
  if (initial.review && state.me.admin) showReview(true);
  if (initial.compose) openCompose({ push: false });
  else if (initial.open) openThread(initial.open);
  connect();
  registerTools();
}
// ---------------------------------------------------------------- WebMCP
// Tools for an agent in the browser (https://developer.chrome.com/docs/ai/webmcp). They drive
// the page the way a person does, as the signed-in person: filters, the open thread and the
// reply box change on screen, and every write goes through the same endpoints as a click.
// Read-only views ("view as") refuse writes here as they do in the UI.
const clip = (s, n) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}\u2026` : v; };
const out = (v) => JSON.stringify(v);
const fail = (error) => out({ error });

// Tool argument -> facet id, and argument values -> facet values.
const FILTER_ARGS = {
  status: 'status', type: 'type', platform: 'platform', resolved: 'resolved', waiting_on: 'next', urgency: 'urgency', kind: 'kind', topic: 'topic', tech: 'tech', customer: 'customer', draft: 'draft',
};
// Filters whose values are ids the API names (src/label.js vocab): checked against them.
const VOCAB_ARGS = { topic: 'topics', tech: 'tech' };
const FILTER_VALUES = {
  status: STATUS_ORDER, type: ['conversation', 'alert'], platform: ['slack', 'teams', 'discord'], resolved: ['open', 'resolved'],
  waiting_on: ['us', 'customer', 'nobody'], urgency: ['critical', 'high', 'normal', 'low'], kind: Object.keys(KIND_EMOJI),
  draft: ['mine', 'team', 'none'],
};
const cap = (v) => v[0].toUpperCase() + v.slice(1);
const toFacet = { platform: cap, waiting_on: cap };
const fromFacet = { platform: (v) => v.toLowerCase(), next: (v) => v.toLowerCase() };

/** The filters on screen (or, given `state.not`, the values excluded), as tool arguments. */
function activeFilters(sets = state.sel) {
  const args = Object.fromEntries(Object.entries(FILTER_ARGS).map(([a, id]) => [id, a]));
  const shown = new Set(viewFacets().map((f) => f.id));
  return Object.fromEntries(Object.entries(sets).filter(([id, set]) => set.size && shown.has(id))
    .map(([id, set]) => [args[id] || id, [...set].map((v) => (fromFacet[id] ? fromFacet[id](v) : v))]));
}

/**
 * filter_threads' filter arguments (`args`, or its `exclude`) as facet values by argument,
 * `{ error }` when one is not a value the inbox knows.
 */
function filterArgs(args) {
  const next = {};
  for (const arg of Object.keys(FILTER_ARGS)) {
    if (!(arg in args) || args[arg] == null) continue;
    const given = [].concat(args[arg]).map((v) => String(v).trim()).filter(Boolean);
    if (VOCAB_ARGS[arg]) {
      const known = Object.keys(state.data.vocab?.[VOCAB_ARGS[arg]] || {});
      const vals = given.map((v) => v.toLowerCase());
      const bad = vals.filter((v) => !known.includes(v));
      if (bad.length) return { error: `Invalid ${arg} value(s) ${bad.join(', ')}. Use: ${known.join(', ')}.` };
      next[arg] = vals;
    } else if (arg === 'customer') {
      const orgs = [...new Set(state.data.threads.map((t) => t.org).filter(Boolean))];
      const picked = given.map((v) => orgs.find((o) => o.toLowerCase() === v.toLowerCase()));
      const miss = given.filter((v, i) => !picked[i]);
      if (miss.length) return { error: `No threads from customer ${miss.map((v) => `"${v}"`).join(', ')} in this team. Customers with threads: ${orgs.slice(0, 15).join(', ')}.` };
      next[arg] = picked;
    } else {
      const vals = given.map((v) => v.toLowerCase());
      const bad = vals.filter((v) => !FILTER_VALUES[arg].includes(v));
      if (bad.length) return { error: `Invalid ${arg} value(s) ${bad.join(', ')}. Use: ${FILTER_VALUES[arg].join(', ')}.` };
      next[arg] = vals.map((v) => (toFacet[arg] ? toFacet[arg](v) : v));
    }
  }
  return next;
}

function threadInfo(t) {
  const info = {
    thread: t.thread, title: clip(t.title || '(no text)', 90), customer: t.org, platform: platform(t).toLowerCase(),
    status: statusOf(t), waiting_on: waitingOn(t).toLowerCase(), urgency: urgencyOf(t), kind: kindOf(t),
    ...(topicsOf(t).length ? { topics: topicsOf(t) } : {}), ...(techOf(t).length ? { tech: techOf(t) } : {}),
    resolved: resolvedOf(t) === 'resolved', last: lastOf(t) || t.any_at || null,
  };
  if (t.unread) info.unread = true;
  if (t.unreadMentions) info.unread_mentions = t.unreadMentions;
  if (t.draft) info.draft = { by: draftBy(t.draft), saved: t.draft.updated_at };
  return info;
}

const teamThread = (key) => searchEntry(key);
const UNKNOWN_THREAD = 'Unknown thread. Use a `thread` value from list_threads; only threads of the view on screen (a team, or personal) are known.';
const READONLY = 'This inbox is a read-only "view as" of someone else. Ask the user to switch "View as" back to themselves.';

/**
 * Opens `key` in the pane (marks it read, as a click does) and returns its current data, or
 * null. Always from the API: an agent reads right after it writes.
 */
async function showThread(key) {
  if (state.open === key) await openThread(key, { live: true });
  else { state.cache.delete(key); await openThread(key); }
  document.querySelector(`#threads .t[data-thread="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  return state.open === key ? state.cache.get(key)?.data || null : null;
}

function replyBlocked(data) {
  if (state.data?.me?.readonly) return READONLY;
  const p = data.thread.source;
  if (p === 'discord') return 'opspile cannot reply on Discord (only bots can post through its API). The user replies in Discord itself; the thread has a link to it.';
  if (!state.me.connected?.[p]) return `The user has not connected their ${accountOf(p)} account, so opspile cannot post as them. Ask them to use the connect link in the reply box.`;
  if (!$('reply')) return 'The reply box is not available for this thread.';
  return null;
}

function fillReply(text) {
  endDraftPreview();
  const box = $('reply');
  box.value = text;
  box.dispatchEvent(new Event('input'));
  box.focus();
  box.setSelectionRange(text.length, text.length);
}

// filter_threads' filters, which it also takes in `exclude`.
const FILTER_PROPS = {
  status: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.status }, description: 'critical/hot: urgent and unseen by Adobe; you: needs the viewer; waiting: waits on us too long; silent: customer silent too long' },
  waiting_on: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.waiting_on }, description: 'Who has the next move' },
  urgency: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.urgency } },
  kind: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.kind } },
  resolved: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.resolved } },
  type: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.type }, description: 'Conversations with customers, or automated alerts' },
  platform: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.platform } },
  draft: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.draft }, description: 'Threads with a shared draft reply saved last by the viewer (mine) or a colleague (team), or without one (none)' },
  topic: { type: 'array', items: { type: 'string' }, description: 'What threads are about (cdn, auth, performance, …), as get_inbox_state counts them' },
  tech: { type: 'array', items: { type: 'string' }, description: 'The tech stack of the threads\' channels (akamai, sharepoint, …), as get_inbox_state counts them' },
  customer: { type: 'array', items: { type: 'string' }, description: 'Customer names as get_inbox_state lists them; case does not matter' },
};

const WEBMCP_TOOLS = [
  {
    name: 'get_inbox_state',
    description: 'Returns who is signed in, the view on screen (one of their ops teams, or "personal") and the teams they can switch to, the active filters, the open thread, and how many threads each filter value matches. Call it first to learn which filter values exist.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      if (!state.data) return fail('The inbox is still loading. Try again in a moment.');
      const counts = {};
      for (const [arg, id] of Object.entries(FILTER_ARGS)) {
        const f = FACETS.find((x) => x.id === id);
        const n = {};
        for (const t of state.data.threads) for (const v of valuesOf(f, t)) if (v !== '(none)') n[v] = (n[v] || 0) + 1;
        const rows = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, arg === 'customer' ? 10 : 20);
        counts[arg] = Object.fromEntries(rows.map(([v, c]) => [fromFacet[id] ? fromFacet[id](v) : v, c]));
      }
      return out({
        viewer: state.data.me?.name || state.me.name, readonly: Boolean(state.data.me?.readonly),
        view: personal() ? 'personal' : state.team, team: personal() ? null : state.team, teams: (state.teams || []).map((t) => t.slug), sort: state.sort,
        unread_only: state.unread, filters: activeFilters(), excluded: activeFilters(state.not), open_thread: state.open, shown: state.order.length, total: state.data.threads.length, counts,
      });
    },
  },
  {
    name: 'filter_threads',
    description: 'Sets the inbox filters and view (a team, or personal) on screen, like clicking the filter cards and the view switch. Each filter given replaces that filter; an empty list clears it; filters not given stay as they are. `exclude` leaves values out, as negative filters. Returns how many threads match. Then call list_threads.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear every filter first. The default view shows conversations only (type: ["conversation"]).' },
        ...FILTER_PROPS,
        exclude: {
          type: 'object', properties: FILTER_PROPS, additionalProperties: false,
          description: 'Values to leave out, by the same filters: e.g. { "platform": ["discord"] } hides Discord threads. Each one given replaces what that filter excludes; an empty list stops excluding. A value excluded is no longer picked.',
        },
        involves_me: { type: 'boolean', description: 'Only threads the viewer posted in or was mentioned in' },
        sort: { type: 'string', enum: ['team', 'personal'], description: 'team: the inbox of a team (`team`, else the last one shown), what needs the viewer most first, with every filter; personal: the channels the viewer posted or was mentioned in, whichever team they belong to, latest activity first, filtered on one customer at most and on platform (the other filters do not apply there, and alerts are not shown)' },
        unread_only: { type: 'boolean', description: 'Only threads the viewer has not read (a thread read while the list is shown stays in it)' },
        team: { type: 'string', description: 'Ops team slug from get_inbox_state: shows that team\'s inbox (sort "team"); switching the view closes the open thread' },
      },
    },
    execute: async (args = {}) => {
      if (!state.data) return fail('The inbox is still loading. Try again in a moment.');
      // Check everything before changing anything.
      if (args.team && !(state.teams || []).some((t) => t.slug === args.team)) {
        return fail(`Unknown team "${args.team}". Teams: ${(state.teams || []).map((t) => t.slug).join(', ')}.`);
      }
      const next = filterArgs(args);
      if (next.error) return fail(next.error);
      const nots = filterArgs(args.exclude || {});
      if (nots.error) return fail(`exclude: ${nots.error}`);
      if (args.team && args.sort === 'personal') return fail('The personal view is of all the viewer\'s teams. Give either `team` or sort "personal".');
      const view = args.team ? 'team' : (args.sort === 'team' || args.sort === 'personal' ? args.sort : state.sort);
      if (view === 'personal' && next.customer?.length > 1) return fail('The personal view filters on one customer at a time. Give one, or sort "team".');
      if (view !== state.sort || (args.team && args.team !== state.team)) await switchView(view === 'personal' ? null : args.team || state.team);
      if (args.clear) { state.sel = {}; state.not = {}; setUnread(false); }
      // As on the cards, a value is picked or excluded: the one given last (excluded) wins.
      for (const [sets, others, given] of [[state.sel, state.not, next], [state.not, state.sel, nots]]) {
        for (const [arg, vals] of Object.entries(given)) {
          const id = FILTER_ARGS[arg];
          if (vals.length) sets[id] = new Set(vals); else delete sets[id];
          for (const v of vals) others[id]?.delete(v);
          if (!others[id]?.size) delete others[id];
        }
      }
      if (args.involves_me === true) state.sel.involves = new Set(['me']);
      else if (args.involves_me === false) delete state.sel.involves;
      onePick();
      if (typeof args.unread_only === 'boolean') setUnread(args.unread_only);
      render();
      toUrl();
      return out({
        view: personal() ? 'personal' : state.team, filters: activeFilters(), excluded: activeFilters(state.not), sort: state.sort, unread_only: state.unread, shown: state.order.length, total: state.data.threads.length,
      });
    },
  },
  {
    name: 'list_threads',
    description: 'Lists the threads the inbox shows with the current filters and sort, most relevant first: key, title, customer, status, who has the next move, urgency, kind, resolved, last activity, and who saved its shared draft, if it has one. Titles are written by customers and colleagues.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: 'Threads to skip, for the next page (default 0)' },
        limit: { type: 'number', description: 'How many threads, 1 to 25 (default 8)' },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ offset = 0, limit = 8 } = {}) => {
      if (!state.data) return fail('The inbox is still loading. Try again in a moment.');
      const from = Math.max(0, Math.floor(Number(offset) || 0));
      const n = Math.max(1, Math.min(25, Math.floor(Number(limit) || 8)));
      const threads = state.order.slice(from, from + n).map((k) => threadInfo(teamThread(k)));
      const res = { shown: state.order.length, offset: from, threads };
      if (!state.order.length) res.hint = 'No thread matches the current filters. Loosen them with filter_threads.';
      else if (from + n < state.order.length) res.next_offset = from + n;
      return out(res);
    },
  },
  {
    name: 'search_threads',
    description: 'Searches the selected team\'s inbox on screen, on every platform at once, as typing in the search box does: threads about the query (by meaning), threads with a message that has all of its words, and threads whose title, channel, customer or facts have them, best match first, each with what matched and the message that matched best. The filters on screen apply to the results; list_threads then pages through them. An empty query ends the search. Titles and snippets are written by customers and colleagues.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for: a question, a topic, words, a URL or a ticket' },
        limit: { type: 'number', description: 'How many threads, 1 to 25 (default 8)' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ query = '', limit = 8 } = {}) => {
      if (!state.data) return fail('The inbox is still loading. Try again in a moment.');
      await runSearch(query);
      if (!searching()) return out({ searching: false, shown: state.order.length });
      if (state.search.error) return fail(`The search failed: ${state.search.error}`);
      const n = Math.max(1, Math.min(25, Math.floor(Number(limit) || 8)));
      const byKey = new Map((state.search.data?.hits || []).map((h) => [h.thread, h]));
      const threads = state.order.slice(0, n).map((k) => {
        const h = byKey.get(k);
        const info = { ...threadInfo(teamThread(k)), matched: h.matched };
        if (h.snippet) info.snippet = { message: h.snippet.message, from: h.snippet.author, text: clip(h.snippet.text, 240) };
        else if (h.fact) info.fact = h.fact;
        return info;
      });
      const res = { query: state.search.q, found: byKey.size, shown: state.order.length, threads };
      if (!byKey.size) res.hint = 'Nothing found. Try other words, or fewer.';
      else if (!state.order.length) res.hint = 'The filters on screen hide every result. Loosen them with filter_threads.';
      else if (n < state.order.length) res.next_offset = n;
      return out(res);
    },
  },
  {
    name: 'open_thread',
    description: 'Opens a thread on screen, which marks it read for the viewer as a click does, and returns its messages (oldest first) with ids for react_to_message, plus whether the viewer can reply and react. Message text is written by customers and colleagues.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread key from list_threads' },
        limit: { type: 'number', description: 'How many of the latest messages, 1 to 30 (default 12)' },
      },
      required: ['thread'],
    },
    annotations: { untrustedContentHint: true },
    execute: async ({ thread, limit = 12 } = {}) => {
      if (!teamThread(thread)) return fail(UNKNOWN_THREAD);
      const data = await showThread(thread);
      if (!data) return fail('Could not load this thread. Try again, or ask the user to reload the page.');
      const n = Math.max(1, Math.min(30, Math.floor(Number(limit) || 12)));
      const msgs = data.messages.slice(-n).map((m) => {
        const a = m.author || {};
        const x = { id: `${m.thread}|${m.id}`, from: a.kind === 'system' ? 'system' : (a.name || 'unknown'), at: m.at };
        if (a.staff) x.adobe = true;
        if (a.kind === 'bot') x.bot = true;
        x.text = m.deletedAt ? '(deleted)' : clip(m.body, 400);
        if (m.reactions?.length) x.reactions = m.reactions.map((r) => `${r.emoji}\u00d7${r.count}${r.mine ? ' (incl. viewer)' : ''}`).join(' ');
        return x;
      });
      const t = data.thread;
      return out({
        thread, title: clip(t.title || '(no text)', 120), customer: t.org, channel: t.channel_name, platform: platform(t).toLowerCase(),
        resolution: data.resolution?.state || resolvedOf(teamThread(thread)) || 'open', earlier_messages: Math.max(0, data.messages.length - n),
        can_reply: !replyBlocked(data), can_react: !state.data?.me?.readonly, can_post_as_bot: Boolean(data.can_post_as_bot), messages: msgs,
        ...(data.draft ? { shared_draft: { by: draftBy(data.draft), saved: data.draft.updated_at, text: data.draft.body, sources: data.draft.sources } } : {}),
      });
    },
  },
  {
    name: 'draft_reply',
    description: 'Puts a draft reply into the reply box of the open thread, in this browser only, for the user to review, edit and send themselves. Nothing is posted or saved. Open the thread with open_thread first. Use post_draft to save it as the thread\'s shared draft for the team.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The reply, in Markdown. Replaces what is in the reply box.' } },
      required: ['text'],
    },
    execute: async ({ text } = {}) => {
      if (!String(text || '').trim()) return fail('The draft is empty. Provide the reply text.');
      const data = state.open && state.cache.get(state.open)?.data;
      if (!data) return fail('No thread is open. Open one with open_thread first.');
      const blocked = replyBlocked(data);
      if (blocked) return fail(blocked);
      fillReply(String(text));
      return out({ ok: true, thread: state.open, note: 'The draft is in the reply box, in this browser only; the user sends it with Enter or Send, or saves it as the thread\'s shared draft for the team.' });
    },
  },
  {
    name: 'post_draft',
    description: 'Saves a reply as the shared draft of a thread, without posting anything: everyone in the team sees it in the inbox and can change, send or discard it. A thread has at most one; to replace the one open_thread shows, pass its `saved` as `base`. `sources` replaces the draft\'s sources: what it rests on, for the person who reviews it; only the team sees them, they are never sent.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread key from list_threads; defaults to the open thread' },
        text: { type: 'string', description: 'The whole reply, in Markdown (up to 8000 characters)' },
        base: { type: 'string', description: 'The `saved` of the shared draft this replaces, from open_thread' },
        sources: {
          type: 'array',
          description: 'What the draft rests on, for the person reviewing it before it is sent',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The http(s) address of the page' },
              title: { type: 'string', description: 'What it is, in a few words' },
              quote: { type: 'string', description: 'The passage that backs the draft, word for word, in Markdown' },
            },
            required: ['url'],
          },
        },
      },
      required: ['text'],
    },
    execute: async ({
      thread, text, base, sources,
    } = {}) => {
      if (state.data?.me?.readonly) return fail(READONLY);
      const body = String(text || '').trim();
      if (!body) return fail('The draft is empty. Provide the reply text.');
      const key = thread || state.open;
      if (!key) return fail('No thread is open. Pass `thread`, or open one with open_thread first.');
      if (!teamThread(key)) return fail(UNKNOWN_THREAD);
      const data = await showThread(key);
      if (!data) return fail('Could not load this thread. Try again, or ask the user to reload the page.');
      const res = await saveDraft(key, body, base || null, { sources: sources || [] });
      if (res.conflict) {
        const d = res.conflict;
        return fail(`${base ? 'The shared draft changed meanwhile' : 'The thread already has a shared draft'} (saved ${d.updated_at} by ${draftBy(d)}). Nothing was saved. To replace it, call post_draft again with base "${d.updated_at}". Its text: ${clip(d.body, 1200)}`);
      }
      if (res.error) return fail(res.error);
      return out({ ok: true, thread: key, shared_draft: { by: draftBy(res.draft), saved: res.draft.updated_at }, note: 'Saved as the thread\'s shared draft: nothing was posted. The team sees it in the inbox.' });
    },
  },
  {
    name: 'post_as_user',
    description: 'Posts a reply in a thread on Slack or Teams, as the signed-in person, visible to everyone in the channel including customers, after a confirmation dialog. Use draft_reply or post_draft instead when the user or the team should review the text first.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread key from list_threads; defaults to the open thread' },
        text: { type: 'string', description: 'The reply, in Markdown' },
      },
      required: ['text'],
    },
    annotations: { consequentialHint: true },
    // WebMCP calls execute(input, client).
    // eslint-disable-next-line default-param-last
    execute: async ({ thread, text } = {}, client) => {
      const body = String(text || '').trim();
      if (!body) return fail('The reply is empty. Provide the reply text.');
      const key = thread || state.open;
      if (!key) return fail('No thread is open. Pass `thread`, or open one with open_thread first.');
      if (!teamThread(key)) return fail(UNKNOWN_THREAD);
      const data = await showThread(key);
      if (!data) return fail('Could not load this thread. Try again, or ask the user to reload the page.');
      const blocked = replyBlocked(data);
      if (blocked) return fail(blocked);
      fillReply(body);
      // The person confirms what goes out under their name.
      const where = `${platform(data.thread)} (${data.thread.org || 'customer'})`;
      const ask = () => confirmInPage(`Post this reply in ${where} as you?`, body, client?.signal);
      const yes = client?.requestUserInteraction ? await client.requestUserInteraction(ask) : await ask();
      if (yes === null) return fail('Nobody confirmed within 2 minutes, so nothing was sent. The text is left in the reply box as a draft.');
      if (!yes) return fail('The user declined to send. The text is left in the reply box as a draft.');
      return await send(key, data.thread) ? out({ ok: true, thread: key, note: 'Sent; it shows as "sending" until Slack or Teams confirms it.' }) : fail(`${state.sendError || 'Could not send.'} The reply shows as not sent in the thread, where the user can retry it.`);
    },
  },
  {
    name: 'post_as_bot',
    description: 'Posts a reply in a thread as the opspile app (its Slack app, Teams bot or Discord bot), not as the signed-in person, visible to everyone in the channel including customers, after a confirmation dialog. Only in channels where the team lets the app post ("Post messages" in the knowledge-base editor). An @Name is a real mention where the user picked that person in the reply box, or the shared draft it sends mentions them; Discord takes up to 2000 characters. Pass `draft` (the shared draft\'s `saved`) when it sends that draft, so it is used up.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread key from list_threads; defaults to the open thread' },
        text: { type: 'string', description: 'The reply, in Markdown' },
        draft: { type: 'string', description: 'The `saved` of the shared draft this sends, from open_thread' },
      },
      required: ['text'],
    },
    annotations: { consequentialHint: true },
    // eslint-disable-next-line default-param-last
    execute: async ({ thread, text, draft } = {}, client) => {
      if (state.data?.me?.readonly) return fail(READONLY);
      const body = String(text || '').trim();
      if (!body) return fail('The reply is empty. Provide the reply text.');
      const key = thread || state.open;
      if (!key) return fail('No thread is open. Pass `thread`, or open one with open_thread first.');
      if (!teamThread(key)) return fail(UNKNOWN_THREAD);
      const data = await showThread(key);
      if (!data) return fail('Could not load this thread. Try again, or ask the user to reload the page.');
      const where = `${platform(data.thread)} (${data.thread.org || 'customer'})`;
      const ask = () => confirmInPage(`Post this reply in ${where} as the bot?`, body, client?.signal, 'Post as bot');
      const yes = client?.requestUserInteraction ? await client.requestUserInteraction(ask) : await ask();
      if (yes === null) return fail('Nobody confirmed within 2 minutes, so nothing was sent.');
      if (!yes) return fail('The user declined to send, so nothing was sent.');
      // The people the shared draft it sends mentions, and those picked in the reply box.
      const d = draft && data.draft?.updated_at === draft ? data.draft : null;
      const mentions = [...new Map([...(d?.mentions || []), ...mentionsIn(key, body)]
        .map((m) => [m.id, m])).values()];
      const error = await sendAsApp(key, body, draft, { mentions });
      return error ? fail(`Nothing was sent: ${error}.`) : out({ ok: true, thread: key, note: 'Sent as the opspile app; it shows in the thread once the platform delivers it.' });
    },
  },
  {
    name: 'react_to_message',
    description: 'Adds an emoji reaction to a message as the signed-in person, on Slack or Teams, or takes the viewer\'s reaction off again. Some steer the inbox: white_check_mark or heavy_check_mark resolves the thread; eyes: the viewer is on it; pray: nothing pending; ring_buoy: asks the team for help.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message id from open_thread' },
        emoji: { type: 'string', enum: PICKER },
        remove: { type: 'boolean', description: 'Take the viewer\'s reaction off instead of adding it' },
      },
      required: ['message', 'emoji'],
    },
    execute: async ({ message: id, emoji: name, remove = false } = {}) => {
      if (state.data?.me?.readonly) return fail(READONLY);
      if (!PICKER.includes(name)) return fail(`Unsupported emoji. Use one of: ${PICKER.join(', ')}.`);
      const m = state.open && state.cache.get(state.open)?.data?.messages.find((x) => `${x.thread}|${x.id}` === id);
      if (!m) return fail('No such message in the open thread. Use a message id from open_thread.');
      if (!canReact(m)) return fail('This message cannot take reactions (deleted, pending or a system message).');
      const res = await react(id, name, Boolean(remove));
      return res.failed ? fail(res.error) : out({ ok: true, message: id, emoji: name, removed: Boolean(remove) });
    },
  },
  {
    name: 'resolve_thread',
    description: 'Marks a thread resolved by putting the signed-in person\'s \u2705 on its first message on Slack or Teams, or takes that \u2705 off again (undo). Defaults to the open thread.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread key from list_threads; defaults to the open thread' },
        undo: { type: 'boolean', description: 'Take the viewer\'s \u2705 off instead (reopens the thread)' },
      },
    },
    execute: async ({ thread, undo = false } = {}) => {
      if (state.data?.me?.readonly) return fail(READONLY);
      const key = thread || state.open;
      if (!key) return fail('No thread is open. Pass `thread`, or open one with open_thread first.');
      const t = teamThread(key);
      if (!t) return fail(UNKNOWN_THREAD);
      if (!t.root_known) return fail('The first message of this thread predates opspile, so there is nothing to put the \u2705 on.');
      const res = await resolveThread(key, Boolean(undo));
      return res.failed ? fail(res.error) : out({ ok: true, thread: key, resolved: !undo });
    },
  },
];

/**
 * Asks the person on the page: true (post), false (cancel) or null (no answer in 2 minutes,
 * or the agent gave up). Not window.confirm(): that would freeze the page, and with it every
 * tool call, until someone answers.
 */
function confirmInPage(question, body, signal, yesLabel = 'Post as me') {
  return new Promise((resolve) => {
    const dlg = toNode(`<dialog class="confirm" aria-label="${esc(question)}"><form method="dialog">
      <p><b>${esc(question)}</b></p><div class="bubble">${md(clip(body, 1200))}</div>
      <div class="apply"><button value="no">Cancel</button><button value="yes" class="send">${esc(yesLabel)}</button></div></form></dialog>`);
    let answer = null;
    const timer = setTimeout(() => dlg.close(), 120000);
    const abort = () => dlg.close();
    signal?.addEventListener('abort', abort);
    dlg.addEventListener('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (dlg.returnValue === 'yes') answer = true;
      else if (dlg.returnValue === 'no') answer = false;
      dlg.remove();
      resolve(answer);
    });
    // Escape is an answer too.
    dlg.addEventListener('cancel', () => { dlg.returnValue = 'no'; });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[value="yes"]').focus();
  });
}

/**
 * Images in messages open full screen in a modal dialog: a click anywhere (but the link to
 * the original and the controls), the close button or Escape dismisses it, and focus goes back
 * to the image last shown. A message's images are one set: the arrow keys, Home and End, the
 * buttons at the sides, a swipe or the thumbnails below page through them. The image grows out
 * of its thumbnail (cropped as the thumbnail is) and shrinks back into it.
 */
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
// An image that failed to load has nothing to show.
const failed = (i) => i.complete && !i.naturalWidth;
const imageSrc = (i) => i.currentSrc || i.src;
// Runs `fn` once `anim` is over, or a little after it should be: a page in the background
// draws no frames, and its animations do not finish.
const settled = (anim, fn) => {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  anim.finished.then(once, once);
  setTimeout(once, anim.effect.getComputedTiming().endTime + 100);
};
const onScreen = (r) => r.width && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
/**
 * The keyframes that turn `el` (laid out where it ends) into the thumbnail at `from`, cropped
 * as the thumbnail crops it (`object-fit: cover`, from the top left).
 */
function morph(el, from) {
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height || !onScreen(from)) return null;
  const scale = Math.max(from.width / to.width, from.height / to.height);
  // Thumbnails are cropped from the top left (`object-position: left top`): what is cut off is
  // to the right and below.
  const x = Math.max(0, to.width - from.width / scale);
  const y = Math.max(0, to.height - from.height / scale);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2) + (scale * x) / 2;
  const dy = from.top + from.height / 2 - (to.top + to.height / 2) + (scale * y) / 2;
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, clipPath: `inset(0 ${x}px ${y}px 0 round ${8 / scale}px)` },
    { transform: 'none', clipPath: 'inset(0 round 6px)' },
  ];
}
function openLightbox(img) {
  const scope = img.closest('.bubble') || img.parentElement;
  const set = [...scope.querySelectorAll('img.att')].filter((i) => i === img || !failed(i));
  const many = set.length > 1;
  let at = -1;
  let shown = null;
  let closing = false;
  const dlg = toNode(`<dialog class="lightbox${many ? ' many' : ''}">
    <div class="stage"></div>
    ${many ? `<span class="count" aria-live="polite"></span>
    <button type="button" class="nav prev" aria-label="Previous image" title="Previous (←)">‹</button>
    <button type="button" class="nav next" aria-label="Next image" title="Next (→)">›</button>
    <div class="strip">${set.map((i, n) => `<button type="button" data-n="${n}" aria-label="Image ${n + 1}"><img src="${esc(imageSrc(i))}" alt=""></button>`).join('')}</div>` : ''}
    <div class="bar"><a target="_blank" rel="noopener">Open original ↗</a>
    <button type="button" class="close" aria-label="Close">✕</button></div></dialog>`);
  const stage = dlg.querySelector('.stage');
  const chrome = () => [...dlg.querySelectorAll('.bar, .count, .nav, .strip')];
  const motion = () => !REDUCED_MOTION.matches;

  const show = (n, dir = 0) => {
    const next = (n + set.length) % set.length;
    if (next === at) return;
    at = next;
    const from = set[at];
    const el = document.createElement('img');
    el.src = imageSrc(from);
    el.alt = from.alt;
    const old = shown;
    shown = el;
    stage.append(el);
    if (old) {
      old.classList.add('out');
      if (motion() && dir) {
        const leave = old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 12}%) scale(.94)` }], { duration: 240, easing: EASE, fill: 'forwards' });
        settled(leave, () => old.remove());
        el.animate([{ opacity: 0, transform: `translateX(${dir * 12}%) scale(.94)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
      } else if (motion()) {
        settled(old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }), () => old.remove());
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
      } else {
        old.remove();
      }
    }
    dlg.querySelector('.bar a').href = el.src;
    dlg.setAttribute('aria-label', many ? `Image ${at + 1} of ${set.length}${from.alt ? `: ${from.alt}` : ''}` : from.alt || 'Image');
    if (!many) return;
    dlg.querySelector('.count').textContent = `${at + 1} / ${set.length}`;
    for (const b of dlg.querySelectorAll('.strip button')) b.setAttribute('aria-current', String(Number(b.dataset.n) === at));
    const strip = dlg.querySelector('.strip');
    const thumb = strip.querySelector(`[data-n="${at}"]`);
    strip.scrollTo({ left: thumb.offsetLeft - (strip.clientWidth - thumb.offsetWidth) / 2, behavior: motion() ? 'smooth' : 'auto' });
    // The neighbours load while this one is looked at.
    for (const d of [-1, 1]) new Image().src = imageSrc(set[(at + d + set.length) % set.length]);
  };

  const dismiss = () => {
    if (closing || !dlg.isConnected) return;
    closing = true;
    const back = set[at];
    const done = () => {
      if (!dlg.isConnected) return;
      if (dlg.open) dlg.close();
      dlg.remove();
      back.focus({ preventScroll: true });
    };
    if (!motion() || !dlg.open) { done(); return; }
    // From where it is now, not from where a running animation has it.
    for (const a of shown.getAnimations()) a.finish();
    shown.style.translate = '';
    const frames = morph(shown, back.getBoundingClientRect());
    const fade = { duration: 220, easing: 'ease-in', fill: 'forwards' };
    for (const el of chrome()) el.animate([{ opacity: 1 }, { opacity: 0 }], { ...fade, duration: 150 });
    dlg.animate([{ opacity: 1 }, { opacity: 0 }], { ...fade, pseudoElement: '::backdrop' });
    const run = frames
      ? shown.animate([...frames].reverse(), { duration: 260, easing: EASE, fill: 'forwards' })
      : shown.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], fade);
    settled(run, done);
  };

  // Swipes: the image follows the finger, and goes on to the next one past a threshold.
  let swipe = null;
  let swiped = false;
  stage.addEventListener('pointerdown', (e) => {
    if (!many || e.button !== 0 || closing) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0 };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    swipe.dx = e.clientX - swipe.x;
    if (Math.abs(swipe.dx) > 8 && Math.abs(swipe.dx) > Math.abs(e.clientY - swipe.y)) {
      if (!stage.hasPointerCapture(e.pointerId)) stage.setPointerCapture(e.pointerId);
      shown.style.translate = `${swipe.dx}px 0`;
    }
  });
  const endSwipe = (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const { dx } = swipe;
    swipe = null;
    if (Math.abs(dx) <= 8) return;
    // The click that ends a swipe with a mouse does not dismiss (a finger's does not click).
    swiped = true;
    setTimeout(() => { swiped = false; });
    const el = shown;
    if (Math.abs(dx) > 60 && e.type === 'pointerup') {
      show(at + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    } else {
      el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: 200, easing: EASE });
      el.style.translate = '';
    }
  };
  stage.addEventListener('pointerup', endSwipe);
  stage.addEventListener('pointercancel', endSwipe);

  dlg.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    if (e.target.closest('a, .count')) return;
    const nav = e.target.closest('.nav, .strip [data-n]');
    if (nav) {
      const n = nav.dataset.n == null ? at + (nav.classList.contains('next') ? 1 : -1) : Number(nav.dataset.n);
      show(n, Math.sign(n - at));
      return;
    }
    if (!e.target.closest('.strip')) dismiss();
  });
  dlg.addEventListener('keydown', (e) => {
    if (!many || closing || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: set.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    show(to, Math.sign(to - at));
  });
  // Escape: tidy up right away instead of waiting for the close event.
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
  dlg.addEventListener('close', () => { if (!closing) { closing = true; dlg.remove(); set[at].focus({ preventScroll: true }); } });

  document.body.append(dlg);
  dlg.showModal();
  show(set.indexOf(img));
  dlg.querySelector('.close').focus();
  if (!motion()) return;
  const first = shown;
  const grow = () => {
    const frames = morph(first, img.getBoundingClientRect());
    if (frames) first.animate(frames, { duration: 340, easing: EASE });
    else first.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
  };
  // Its size is known once it decodes (at once, mostly: the thumbnail loaded it).
  if (first.complete && first.naturalWidth) {
    grow();
  } else {
    first.style.opacity = '0';
    first.decode().catch(() => {}).finally(() => { first.style.opacity = ''; if (!closing && first === shown) grow(); });
  }
  dlg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out', pseudoElement: '::backdrop' });
  for (const el of chrome()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 140, easing: 'ease-out', fill: 'backwards' });
}
// ---------------------------------------------------------------- file previews
// A CSV, TSV or text file's fileEl (fileCard, src/ui-markdown.js) has a Preview button: the file
// (GET /api/file, with the app's credentials) under the fileEl, as a table or as text
// (ui/table.js), and full screen from there. Each file is fetched once per page; a preview
// left open stays open when its message is drawn again (a reaction, an edit).
const fileTexts = new Map(); // `${thread}\u0000${link}` -> Promise<string>
const openPreviews = new Set(); // `${message data-id}\u0000${link}`
function fileText(thread, link) {
  const k = `${thread}\u0000${link}`;
  if (!fileTexts.has(k)) {
    const p = (async () => {
      const res = await fetch(`/api/file?t=${encodeURIComponent(thread)}&u=${encodeURIComponent(link)}`, {
        credentials: 'same-origin', headers: state.as ? { 'x-opspile-as': String(state.as) } : {},
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `could not load it (${res.status})`);
      return res.text();
    })();
    fileTexts.set(k, p);
    p.catch(() => fileTexts.delete(k));
  }
  return fileTexts.get(k);
}
/** The file a fileEl is of, and the message it is in. */
function cardFile(fileEl) {
  const a = fileEl.querySelector('a.file-name');
  const id = fileEl.closest('.msg[data-id]')?.dataset.id || '';
  return {
    id, thread: id.slice(0, id.lastIndexOf('|')), link: a?.getAttribute('href') || '', href: a?.href || '',
    name: a?.textContent || '', home: fileEl.dataset.home || '', kind: fileEl.querySelector('[data-preview]')?.dataset.preview,
  };
}
function setPreviewButton(btn, open) {
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Hide' : 'Preview';
}
async function openPreview(fileEl) {
  const btn = fileEl.querySelector('[data-preview]');
  const f = cardFile(fileEl);
  if (!btn || !f.thread || !f.link) return;
  openPreviews.add(`${f.id}\u0000${f.link}`);
  const box = document.createElement('div');
  box.className = 'file-view';
  box.dataset.kind = f.kind;
  box.innerHTML = '<div class="fv-wait"><span class="spin" aria-hidden="true"></span>Loading the file…</div>';
  fileEl.after(box);
  setPreviewButton(btn, true);
  try {
    const text = await fileText(f.thread, f.link);
    if (!box.isConnected) return;
    Table.mount(box, {
      text, kind: f.kind, name: f.name, onExpand: (shown) => Table.open({ ...f, text, start: shown }),
    });
  } catch (e) {
    if (!box.isConnected) return;
    box.classList.add('failed');
    box.textContent = `Cannot show ${f.name}: ${e.message}`;
  }
  const scroller = box.closest('.scroller');
  if (scroller) {
    // As much of it in view as fits, without moving the fileEl out of it.
    const r = box.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (r.bottom > s.bottom) scroller.scrollBy({ top: Math.min(r.bottom - s.bottom + 12, fileEl.getBoundingClientRect().top - s.top - 12), behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' });
  }
}
function closePreview(fileEl, view) {
  const f = cardFile(fileEl);
  openPreviews.delete(`${f.id}\u0000${f.link}`);
  view.remove();
  setPreviewButton(fileEl.querySelector('[data-preview]'), false);
}
/** The previews that were open in messages drawn again. */
function restorePreviews(pane) {
  if (!openPreviews.size) return;
  for (const fileEl of pane.querySelectorAll('.file:has([data-preview="table"], [data-preview="text"])')) {
    const f = cardFile(fileEl);
    if (openPreviews.has(`${f.id}\u0000${f.link}`) && !fileEl.nextElementSibling?.classList.contains('file-view')) {
      openPreviews.delete(`${f.id}\u0000${f.link}`);
      openPreview(fileEl);
    }
  }
}
function wireFiles() {
  // Players (fileCard): a video takes the shape of what it shows once that is known; one plays
  // at a time; one the browser cannot play (or opspile cannot load) says so, and links to it.
  document.addEventListener('loadedmetadata', (e) => {
    const v = e.target;
    if (v.matches?.('video.file-player') && v.videoWidth && v.videoHeight) v.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
  }, true);
  document.addEventListener('play', (e) => {
    if (!e.target.matches?.('.file-player')) return;
    for (const m of document.querySelectorAll('.file-player')) if (m !== e.target && !m.paused) m.pause();
  }, true);
  // A custom emoji Slack no longer has (or has replaced): its name, as before it loaded.
  document.addEventListener('error', (e) => {
    if (e.target.matches?.('img.emoji')) e.target.replaceWith(e.target.alt);
  }, true);
  document.addEventListener('error', (e) => {
    const m = e.target;
    if (!m.matches?.('.file-player') || !m.error) return;
    const fileEl = m.closest('.file');
    const sub = fileEl?.querySelector('.file-sub');
    fileEl?.classList.add('play-failed');
    if (sub) sub.textContent = `Cannot play it here${fileEl.dataset.home ? `: open it in ${fileEl.dataset.home}` : ''}`;
  }, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.file [data-preview]');
    if (!btn) return;
    e.preventDefault();
    const fileEl = btn.closest('.file');
    const view = fileEl.nextElementSibling?.classList.contains('file-view') ? fileEl.nextElementSibling : null;
    if (view) closePreview(fileEl, view); else openPreview(fileEl);
  });
}

function wireLightbox() {
  const target = (e) => {
    const img = e.target.closest?.('img.att');
    // Nothing to show for an image that did not load.
    return img && img.naturalWidth ? img : null;
  };
  document.addEventListener('click', (e) => {
    const img = target(e);
    if (!img || e.button !== 0) return;
    e.preventDefault();
    openLightbox(img);
  });
  document.addEventListener('keydown', (e) => {
    // The arrow keys move between a gallery's thumbnails.
    const thumb = e.target.closest?.('.gallery > img.att');
    if (thumb && /^Arrow(Left|Right)$/.test(e.key)) {
      const next = e.key === 'ArrowRight' ? thumb.nextElementSibling : thumb.previousElementSibling;
      if (next) { e.preventDefault(); next.focus(); }
      return;
    }
    const img = target(e);
    if (!img || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    openLightbox(img);
  });
}

async function registerTools() {
  const mc = document.modelContext || navigator.modelContext;
  if (!mc?.registerTool) return;
  for (const tool of WEBMCP_TOOLS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await mc.registerTool(tool);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`WebMCP: could not register ${tool.name}`, e);
    }
  }
}

wireCards();
start();
// Signed in again (app.js): what could not be loaded is, and live updates start again.
window.addEventListener('opspile:signedin', () => {
  if (!state.me) {
    start();
    return;
  }
  if (state.open) openThread(state.open, { live: true });
  loadInbox().then(connect, () => {});
});
