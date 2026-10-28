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
  me: null, team: null, data: null, open: null, ws: null, review: null, answers: null,
  sel: { type: new Set(['conversation']) },
  order: [], prevKeys: null, shownIds: null, sending: [], sort: 'team', unread: false, keep: new Set(), scores: new Map(),
  cache: new Map(), staged: {}, profiles: new Map(), composers: new Map(), filtering: false,
  // The thread agents' latest turns, by inbox entry: { turn, latest, timer }.
  agents: new Map(),
};

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
const favicon = (domain) => (/^https:\/\//.test(domain) ? domain
  : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`);
// An org as the admin team set it up (/inbox/admin): its name and icon, else the slug and
// the favicon of the customer's usual mail domain. `favicon()` takes either.
const orgName = (t) => t.org_name || t.org;
const orgIcon = (t) => t.org_icon || t.customerDomain || null;
const ORG_TYPE = { partner: 'Partner', vendor: 'Vendor' };
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
// emoji. Anything else is shown by name.
const SLACK_EMOJI = /* SLACK_EMOJI */ { names: {}, skin: [] };
const EMOJI = Object.assign(Object.create(null), {
  like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😠', facepalm: '🤦', rofl: '🤣',
  ack: '✅', done: '✅', yes: '✅', no: '❌', thank_you: '🙏', thanks: '🙏',
  // Used by the reaction bar; also in Slack's table, here so dev and tests show them too.
  white_check_mark: '✅', heavy_check_mark: '✔️', eyes: '👀', pray: '🙏', '+1': '👍', thumbsup: '👍',
  grinning: '😀', rocket: '🚀', ring_buoy: '🛟', joy: '😂', open_mouth: '😮', tada: '🎉',
}, SLACK_EMOJI.names);
const SKIN_TONES = new Set(SLACK_EMOJI.skin);
// `wave::skin-tone-3`: the tone modifier goes after the first code point, in place of a VS16.
function emojiByName(name) {
  const [base, tone] = String(name).split('::skin-tone-');
  const c = EMOJI[base];
  if (!c || !/^[2-6]$/.test(tone || '') || !SKIN_TONES.has(base)) return c;
  const [first, ...rest] = [...c];
  if (rest[0] === '\uFE0F') rest.shift();
  return [first, String.fromCodePoint(0x1f3fb + Number(tone) - 2), ...rest].join('');
}
const emoji = (name) => emojiByName(name) || (/^\p{Extended_Pictographic}/u.test(name) ? name : `:${name}:`);
// `:name:` in text, with an optional `::skin-tone-N`.
const EMOJI_CODE = /:([a-z0-9_+-]+(?:::skin-tone-[2-6])?):/g;
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
const proxied = (u) => (/^https:\/\/(files\.slack\.com\/|graph\.microsoft\.com\/|(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/)/.test(u) ? `/api/media?u=${encodeURIComponent(u)}` : u);
// Rendered once per text and set of known names: opening a thread again, or a live update,
// renders only the messages that are new or changed.
const rendered = new Map();
const RENDERED_MAX = 4000;
function md(src) {
  const k = `${mentionSet}\u0000${src}`;
  let html = rendered.get(k);
  if (html === undefined) {
    html = Markdown.render(src, { mentions: mentionNames, emoji: emojiByName, proxy: proxied, kindOf: mentionKindOf });
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
  incident: '🔥', security: '🔒', question: '❓', request: '🙋', access: '🔑', alert: '🚨', other: '💬',
};
const URGENCY_ICON = { critical: '🆘', high: '⚡', normal: '🔹', low: '▫️' };
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
const involvesColor = (v) => {
  if (v === 'me') return 'c-me';
  if (v.startsWith('team:')) return 'c-team';
  return `c-${personKind(v.slice(7))}`;
};
// Orgs by type, as the admin team set it; "other" when nobody outside Adobe writes there.
const ORG_GROUPS = ['partner', 'vendor', 'customer', 'other'];
const ORG_GROUP_LABEL = {
  partner: 'Partners', vendor: 'Vendors', customer: 'Customers', other: 'Other',
};
function orgGroup(org) {
  const ts = (state.data?.threads || []).filter((t) => t.org === org && t.kind !== 'alert');
  if (!ts.some((t) => (t.participants || []).some((x) => !x.staff))) return 'other';
  return ORG_TYPE[ts[0].org_type] ? ts[0].org_type : 'customer';
}
const ORG_COLOR = {
  partner: 'c-partner', vendor: 'c-vendor', customer: 'c-customer', other: 'c-none',
};
const URGENCY_COLOR = {
  critical: 'c-red', high: 'c-gold', normal: 'c-blue', low: 'c-none',
};
const KIND_COLOR = {
  incident: 'c-orange', security: 'c-gold', question: 'c-red', request: 'c-pink', access: 'c-brown', alert: 'c-crimson', other: 'c-none',
};
const colorOf = (map) => (v) => map[v] || 'c-none';

// The cards in this order. A facet with `into` is shown in that facet's card, below its own
// rows, and still filters on its own (both must match).
const FACETS = [
  { id: 'status', title: 'Status', value: statusOf, order: STATUS_ORDER, label: STATUS_LABEL, hint: STATUS_HINT,
    color: (v) => `c-${v}` },
  { id: 'urgency', title: 'Urgency', value: urgencyOf, order: ['critical', 'high', 'normal', 'low'],
    emoji: (v) => URGENCY_ICON[v], color: colorOf(URGENCY_COLOR) },
  { id: 'resolved', title: 'Resolved', value: resolvedOf, order: ['open', 'resolved'],
    label: { open: 'Unresolved', resolved: 'Resolved' }, color: colorOf({ open: 'c-red', resolved: 'c-green' }) },
  { id: 'draft', into: 'resolved', title: 'Draft', value: draftState, order: ['mine', 'team', 'none'], label: DRAFT_LABEL, hint: DRAFT_HINT,
    emoji: (v) => (v === 'none' ? '' : '✎'), color: colorOf({ mine: 'c-blue', team: 'c-blue' }) },
  { id: 'customer', title: 'Customer', value: (t) => t.org, icon: (v, ts) => { const t = ts.find((x) => x.org === v && orgIcon(x)); return t && orgIcon(t); },
    labelFn: (v) => { const t = (state.data?.threads || []).find((x) => x.org === v); return t ? orgName(t) : v; }, limit: 12,
    group: orgGroup, groups: ORG_GROUPS, groupLabel: ORG_GROUP_LABEL, color: (v) => ORG_COLOR[orgGroup(v)] },
  { id: 'kind', title: 'Kind', value: kindOf, emoji: (v) => KIND_EMOJI[v], color: colorOf(KIND_COLOR),
    order: ['incident', 'security', 'question', 'request', 'access', 'alert', 'other'] },
  { id: 'next', title: 'Waiting on', value: waitingOn, order: ['Us', 'Customer', 'Nobody'],
    color: colorOf({ Us: 'c-red', Customer: 'c-silent' }) },
  { id: 'involves', title: 'Involves', value: involvement, multi: true, labelFn: involvesLabel, color: involvesColor,
    order: () => ['me', ...Object.keys(state.data?.teams || {}).map((s) => `team:${s}`),
      ...(state.coPeople || []).map((p) => `person:${p}`)
        .sort((x, y) => PERSON_KINDS.indexOf(personKind(x.slice(7))) - PERSON_KINDS.indexOf(personKind(y.slice(7))))] },
  { id: 'type', title: 'Type', value: (t) => (t.kind === 'alert' ? 'alert' : 'conversation'), order: ['conversation', 'alert'],
    label: { conversation: 'Conversations', alert: 'Alerts' }, color: colorOf({ conversation: 'c-blue', alert: 'c-crimson' }) },
  { id: 'platform', title: 'Platform', value: platform, order: ['Slack', 'Teams', 'Discord'],
    color: colorOf({ Slack: 'c-slack', Teams: 'c-msteams', Discord: 'c-discord' }) },
];
// The personal view (latest activity first) keeps the customer card only, and picks one
// customer at a time; it shows conversations, not alerts. The team view has every card.
// Filters on the cards a view does not show do not apply in it, and are kept for the other.
const PERSONAL_FACETS = FACETS.filter((f) => f.id === 'customer');
const personal = () => state.sort === 'personal';
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
// Unread only keeps the threads read since it was turned on, so a row does not vanish
// when you open it.
const passes = (t, except) => (!state.unread || t.unread || state.keep.has(t.thread))
  && (!personal() || t.kind !== 'alert')
  && viewFacets().every((f) => f.id === except || !state.sel[f.id]?.size
    || valuesOf(f, t).some((v) => state.sel[f.id].has(v)));

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

function facetRows(f) {
  const all = state.data?.threads || [];
  const pool = all.filter((t) => passes(t, f.id));
  const counts = new Map();
  const mix = new Map(); // value -> { red, yellow, green, none }
  const unread = new Set(); // values with threads the viewer has not read
  for (const t of pool) {
    for (const v of valuesOf(f, t)) {
      counts.set(v, (counts.get(v) || 0) + 1);
      if (t.unread) unread.add(v);
      const m = mix.get(v) || {};
      m[statusOf(t)] = (m[statusOf(t)] || 0) + 1;
      mix.set(v, m);
    }
  }
  if (f.multi) counts.delete('(none)');
  for (const v of state.sel[f.id] || []) if (!counts.has(v)) counts.set(v, 0);
  let rows = [...counts];
  const order = typeof f.order === 'function' ? f.order() : f.order;
  if (f.multi) for (const v of order || []) if (!counts.has(v)) counts.set(v, 0);
  rows.sort((a, b) => (order ? (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99) : b[1] - a[1]));
  if (f.limit) rows = rows.slice(0, f.limit);
  if (f.group) rows.sort((a, b) => f.groups.indexOf(f.group(a[0])) - f.groups.indexOf(f.group(b[0])));
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const on = state.sel[f.id] || new Set();
  let group = null;
  return rows.map(([v, n]) => {
    const color = f.color ? f.color(v) : 'c-accent';
    const ic = f.icon && f.icon(v, all);
    const em = f.emoji && f.emoji(v);
    const g = f.group && f.group(v);
    const head = g && g !== group ? `<div class="fg">${esc(f.groupLabel[g])}</div>` : '';
    group = g;
    return `${head}<div class="fr ${on.has(v) ? 'on' : ''}" data-f="${f.id}" data-v="${esc(v)}" title="${esc((f.hint && f.hint[v]) || v)}">
      <span class="ind ${v === '(none)' ? 'c-none' : color}"></span>
      ${ic ? `<img class="ico" src="${esc(favicon(ic))}" alt="" loading="lazy">` : (em ? `<span class="ico em">${em}</span>` : '<span></span>')}
      <span class="lab${v === '(none)' ? ' dim' : ''}${unread.has(v) ? ' new' : ''}"${unread.has(v) ? ' aria-description="unread threads"' : ''}>${esc((f.labelFn && f.labelFn(v)) || (f.label && f.label[v]) || v)}</span>
      <span class="n">${n}</span>
      ${bar(f, v, n, max, mix.get(v), color)}</div>`;
  }).join('') || '<div class="fr"><span></span><span></span><span class="lab dim">nothing</span></div>';
}

const cardFacets = (id) => viewFacets().filter((f) => f.id === id || f.into === id);

function renderFilters() { inPass(filterCards); }
function filterCards() {
  const cards = viewFacets().filter((f) => !f.into).map((f) => {
    const parts = cardFacets(f.id);
    const on = parts.some((x) => state.sel[x.id]?.size);
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
// `:name:` to the character, for titles (the body renderer does the same).
const emojify = (text) => esc(text).replace(EMOJI_CODE, (m, n) => emojiByName(n) || m);
/** Text without what platforms rewrite: emoji (characters or :codes:), markup, spacing. */
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
  const rx = [...(t.reactions || [])].filter((r) => !/^:.*:$/.test(emoji(r.emoji)))
    .sort((a, b) => b.count - a.count).slice(0, 5);
  for (const r of rx) out.push(`<span class="em" title="${esc(`${r.emoji} × ${r.count}`)}">${esc(emoji(r.emoji))}</span>`);
  return out.length ? `<span class="moods">${out.join('')}</span>` : '';
}

function row(t) {
  const status = statusOf(t);
  const faces = (t.participants || []).map((p) => avatar(p.name || '?', p.avatar, '', {
    key: profileKey(p.key, { ...p, platform: t.source }), tab: true,
  })).join('');
  const replies = Math.max(0, (t.messages || 1) - 1);
  const fresh = state.prevKeys && !state.prevKeys.has(t.thread) ? 'enter' : '';
  const n = t.occurrences || (t.members || []).length;
  const occurrences = n > 1 ? `<span class="replies">${n}×</span>` : '';
  return `<div class="t ${t.unread ? 'unread' : ''} ${state.open === t.thread ? 'sel' : ''} ${fresh}" data-thread="${esc(t.thread)}">
    <div class="l1"><span class="dot ${status === 'quiet' ? '' : `c-${status}`} ${ourMove(t) ? 'ring' : ''}" title="${esc(STATUS_HINT[status])}${ourMove(t) ? ' · our move' : ''}"></span>
      ${t.draft ? `<span class="drafted" title="${esc(`Draft by ${draftBy(t.draft)}, ${ago(t.draft.updated_at)}: ${t.draft.preview}`)}">✎ Draft</span>` : ''}
      <span class="title">${t.root_known ? '' : '↳ '}${emojify(t.title || '(no text)')}</span>
      <span class="when" title="${esc(lastOf(t) || '')}">${ago(lastOf(t))}</span></div>
    <div class="l2">
      <span class="cust">${orgIcon(t) ? `<img src="${esc(favicon(orgIcon(t)))}" alt="" loading="lazy">` : ''}${esc(orgName(t))}</span>
      <span class="faces">${faces}</span>
      ${occurrences}${replies && !occurrences ? `<span class="replies re">${replies} ${replies === 1 ? 'reply' : 'replies'}</span>` : ''}
      <span class="tags">${moods(t)}</span>
    </div></div>`;
}

// Team order: what needs me most, first. Recency always counts; a thread that waits on
// us counts more the longer it waits, the more urgent and unresolved it is, and the closer
// it is to me (mentioned me > I posted > mentioned the team > the team posted).
const STATUS_WEIGHT = {
  critical: 6, hot: 5, you: 4, waiting: 3, silent: 2, team: 1.5, quiet: 1,
};
function smartScore(t) {
  return STATUS_WEIGHT[statusOf(t)] * 100 + baseScore(t);
}
function baseScore(t) {
  const now = Date.now();
  const last = Date.parse(lastOf(t) || t.any_at || 0) || 0;
  const ageH = Math.max(0, (now - last) / 3600000);
  const recency = Math.exp(-ageH / 48);
  const urgency = 1 + (t.label?.urgency ?? 0.5);
  const open = 1 - 0.8 * resolvedP(t);
  const me = viewerId();
  const team = teamIds();
  let near = 1;
  if ((t.mentioned || []).some((m) => m.person === me) || t.mentionedMe) near = 3;
  else if ((t.posters || []).includes(me) || signals(t).mine) near = 2;
  else if ((t.mentioned || []).some((m) => team.has(m.person))) near = 1.5;
  else if ((t.posters || []).some((p) => team.has(p))) near = 1.2;
  const waitsOnUs = t.waiting_on === 'us';
  const waiting = waitsOnUs ? 1 + Math.log2(1 + ageH / 2) : 0.3;
  const unseen = t.unseenByAdobe ? 1.5 : 1;
  const alert = t.kind === 'alert' ? 0.3 : 1;
  const sig = signals(t);
  // 👀 by a colleague lowers it for you; 🛟 by a colleague raises it.
  const steer = (sig.others && !sig.mine ? 0.5 : 1) * (sig.help ? 2 : 1);
  return alert * (2 * recency + urgency * open * waiting * near * unseen * steer);
}

const tpl = document.createElement('template');
const toNode = (html) => { tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };

// Threads in view are fetched ahead, so opening one is instant.
const preload = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) prefetch(e.target.dataset.thread);
}, { root: $('threads'), rootMargin: '200px' });

const FUNNEL = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h12M4.5 8h7M7 12h2"/></svg>';
const SLIDERS = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4.5h6M11 4.5h3M2 11.5h2M7 11.5h7"/><circle cx="9.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/></svg>';

function renderThreads() { inPass(threadRows); }
function threadRows() {
  const box = $('threads');
  if (!state.data) return;
  const shown = state.data.threads.filter((t) => passes(t));
  if (personal()) shown.sort((a, b) => String(lastOf(b)).localeCompare(String(lastOf(a))));
  // Team order is computed when the inbox loads, not when you read a thread, so a click
  // never moves the row you clicked.
  else shown.sort((a, b) => (state.scores.get(b.thread) ?? smartScore(b)) - (state.scores.get(a.thread) ?? smartScore(a)));
  if (!box.querySelector('.rows')) box.innerHTML = '<div class="count"></div><div class="rows"></div>';
  const mine = personal();
  const unread = `<button class="unread" data-unread aria-pressed="${state.unread}" title="${state.unread ? 'Showing unread threads only' : 'Show unread threads only'}" aria-label="Unread only">${FUNNEL}</button>`;
  const sorter = `<button class="order" data-sort="${mine ? 'team' : 'personal'}" role="switch" aria-checked="${mine}" aria-label="Personal view" title="${mine ? 'Personal: latest activity first, filtered by customer only' : 'Team: what needs you most first, with every filter'}">`
    + `<span class="${mine ? '' : 'on'}">Team</span><span class="${mine ? 'on' : ''}">Personal</span></button>`;
  // Narrower screens keep the filter cards in a drawer, opened from here (see the styles).
  const on = viewFacets().reduce((n, f) => n + (state.sel[f.id]?.size || 0), 0);
  const filt = `<button class="filt" data-filters aria-controls="filters" aria-expanded="${state.filtering}" title="Show the filters">${SLIDERS}Filters${on ? `<b>${on}</b>` : ''}</button>`;
  // Filters (narrow screens) and unread only on the left, the view switch on the right.
  const count = `${filt}${unread}<span class="sort">${sorter}</span>`;
  const head = box.querySelector('.count');
  if (head.__html !== count) { head.innerHTML = count; head.__html = count; }
  // Patch the list instead of rebuilding it: unchanged rows keep their DOM (and images),
  // also rows a filter hid for a while, which are kept aside for when they show again.
  const list = box.querySelector('.rows');
  const existing = state.rowNodes || (state.rowNodes = new Map());
  for (const c of list.children) if (c.dataset.thread) existing.set(c.dataset.thread, c);
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
}
function render() { inPass(() => { renderFilters(); renderThreads(); }); }

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
const TECH_LABEL = {
  eds: 'Edge Delivery', da: 'Document Authoring', ue: 'Universal Editor', sharepoint: 'SharePoint',
  gdrive: 'Google Drive', aemcs: 'AEM Cloud Service', assets: 'Assets', forms: 'Forms', commerce: 'Commerce',
  cloudflare: 'Cloudflare', akamai: 'Akamai', fastly: 'Fastly', cloudfront: 'CloudFront', github: 'GitHub',
  bitbucket: 'Bitbucket / Cloud Manager git', target: 'Target', analytics: 'Analytics',
};
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

function message(m, prev, fresh) {
  const a = m.author || {};
  const id = `${m.thread}|${m.id}`;
  const enter = fresh ? 'enter' : '';
  if (a.kind === 'system') return `<div class="sys ${enter}" data-id="${esc(id)}">${md(m.body)} · ${clock(m.at)}</div>`;
  const adobe = Boolean(a.staff);
  const cont = prev && prev.author?.name === a.name && prev.author?.kind === a.kind && prev.thread === m.thread
    && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60 * 1000 && dayLabel(prev.at) === dayLabel(m.at);
  const key = profileKey(m.authorKey, {
    name: a.name, staff: a.staff, kind: a.kind, domain: a.org, avatar: m.avatar, platform: m.source,
  });
  const who = `<b data-p="${esc(key)}" role="button" tabindex="0">${esc(a.name || 'unknown')}</b>${a.kind === 'bot' ? ' bot' : ''} · ${clock(m.at)}`;
  const face = `<span class="face">${avatar(a.name || '?', m.avatar, '', { key })}${!adobe && a.org ? `<img class="badge-ico" src="${esc(favicon(a.org))}" alt="" title="${esc(a.org)}" loading="lazy">` : ''}</span>`;
  // Reactions: who reacted on hover; a click adds yours, or takes it off again.
  const can = canReact(m);
  const rx = (m.reactions || []).map((r) => {
    const tip = esc(`${r.names.join(', ') || r.emoji}${can ? (r.mine ? ' · click to take yours off' : ' · click to add yours') : ''}`);
    const chip = `${esc(emoji(r.emoji))} ${r.count}`;
    return can ? `<button class="${r.mine ? 'mine' : ''}" data-emoji="${esc(r.emoji)}" data-mine="${r.mine ? '1' : ''}" aria-pressed="${Boolean(r.mine)}" title="${tip}">${chip}</button>`
      : `<span title="${tip}">${chip}</span>`;
  }).join('');
  const quick = can ? `<div class="quick" role="toolbar" aria-label="React, as you">${QUICK.map((n) => {
    const mine = (m.reactions || []).some((r) => r.mine && emoji(r.emoji) === emoji(n));
    return `<button data-pick="${n}" aria-pressed="${mine}" title="${esc(`${emoji(n)} ${SIGNAL_HINT[n] || `:${n}:`}${mine ? ' · click to take yours off' : ''}`)}">${emoji(n)}</button>`;
  }).join('')}<button class="more" data-picker="1" aria-haspopup="true" aria-expanded="false" title="More reactions">☺</button></div>` : '';
  return `<div class="msg ${adobe ? 'adobe' : ''} ${cont ? 'cont' : ''} ${m.deletedAt ? 'deleted' : ''} ${m.pending ? 'pending' : ''} ${enter}" data-id="${esc(id)}">
    ${face}
    <div class="col">${quick}<div class="who">${who}</div>
      <div class="bubble">${m.deletedAt ? 'This message was deleted.' : md(m.body)}</div>
      ${rx ? `<div class="rx">${rx}</div>` : ''}
      ${m.editedAt || m.pending ? `<div class="meta">${m.pending ? 'sending… ' : ''}${m.editedAt ? 'edited' : ''}</div>` : ''}
    </div></div>`;
}

// ---------------------------------------------------------------- the thread agent
// Its latest turn, under the last message (GET /api/agent): what it is doing while it works,
// its note for the team once done. Asked when a thread opens or changes, and every few
// seconds while it works, or while a new message waits for it to start.
const AGENT_NAME = 'Opspile Agent';
const AGENT_POLL_MS = 4000;
const AGENT_WAIT_MS = 2 * 60 * 1000;

function agentItem(key) {
  const { turn, latest } = state.agents.get(key) || {};
  if (!turn) return '';
  // A note is about the thread as it was: someone posted since (or is sending), it is gone.
  if (turn.state !== 'working' && latest && latest > (turn.endedAt || turn.startedAt)) return '';
  const body = turn.state === 'working' ? `<span class="spin" aria-hidden="true"></span>${esc(turn.text)}…` : md(turn.text);
  const label = turn.state === 'working' ? 'The thread agent is working' : 'The thread agent\'s note on its latest turn';
  return `<div class="msg adobe agent ${turn.state === 'done' ? '' : turn.state}" aria-label="${label}"${turn.state === 'working' ? ' aria-live="polite"' : ''}>
    <span class="face">${avatar(AGENT_NAME, '/icon-192.png')}</span>
    <div class="col"><div class="who"><b>${AGENT_NAME}</b></div><div class="bubble">${body}</div></div></div>`;
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
    entry.timer = setTimeout(() => { if (state.open === key) loadAgent(key); }, AGENT_POLL_MS);
  }
}

/** The thread's draft, read-only: who saved it, when, and how it starts. */
const draftLine = (d) => (d ? `<div class="draftbar"><span class="pen">✎ Draft</span>
  <span class="pv" title="${esc(d.body)}">by ${esc(draftBy(d))}, ${ago(d.updated_at)}: ${esc(d.body)}</span></div>` : '');

// Only a touch screen, no pointer that hovers (phones): no Shift+Enter on the on-screen
// keyboard, so Enter starts a new line there and Send sends, as in the Slack and Teams apps.
const TOUCH_ONLY = matchMedia('(any-hover: none)');

function composer(thread, draft, resolve = '') {
  if (state.data?.me?.readonly) return `<div class="composer">${draftLine(draft)}<span class="connect">Viewing as ${esc(state.data.me.name)}: read-only.</span></div>`;
  const p = thread.source;
  const name = accountOf(p);
  if (p === 'discord') {
    // Discord lets only bots post through its API, and opspile posts as the person or not at
    // all: the reply is written in Discord. Connecting the account makes its posts count as yours.
    const connect = state.me.connectable?.discord && !state.me.connected?.discord
      ? ` <a href="/api/auth/discord/start">Connect your Discord account</a> so opspile knows which posts are yours.` : '';
    return `<div class="composer">${draftLine(draft)}<span class="connect">Replies to Discord are written in Discord: ${backlink(thread, 'reply in Discord ↗')}.${connect}</span></div>`;
  }
  if (!state.me.connected?.[p]) {
    return `<div class="composer">${draftLine(draft)}<span class="connect">To reply as yourself, <a href="/api/auth/${p}/start">connect your ${name} account</a>.</span></div>`;
  }
  return `<div class="composer"><div class="draftbar" id="draftbar" hidden></div><ul class="mentions" id="mention-list" role="listbox" hidden></ul>
    <textarea id="reply" rows="1" role="combobox" aria-autocomplete="list" aria-controls="mention-list" aria-expanded="false"
      placeholder="Reply in thread"></textarea>
    <span class="sendwrap"><span class="hold" id="hold" hidden><button class="savedraft" id="savedraft" title="Save as the thread's draft: everyone on the team sees it, and can send it (⌘S)">✎ Save draft</button>${resolve}</span><button class="send" id="send">Send</button></span></div>`;
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
  syncReading();
  if (switching) prefetchAround(key);
  if (switching) toUrl(true, fromList ? { list: true } : null);
  renderThreads();
  const pane = $('pane');
  const prevScroller = pane.querySelector('.scroller');
  const wasNear = prevScroller ? nearBottom(prevScroller) : true;
  const keepTop = prevScroller ? prevScroller.scrollTop : 0;
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
    return openThread(entryKey, { cached: true });
  }
  mergeProfiles(data.profiles);
  // Shown from the preload: fetch the current state behind it.
  if (hit && !cached && Date.now() - hit.at > 5000) setTimeout(() => { if (state.open === key) openThread(key, { live: true }); }, 0);
  const { thread, members = [], messages, watermarks, label, model, reviews, facts, resolution } = data;
  if (state.open !== key) return;
  const group = members.length > 1;
  const t = state.data?.threads.find((x) => x.thread === key) || {};
  // Where I was: the last time I had read any member of this entry.
  const myRead = watermarks.filter((w) => w.person === state.me.id).map((w) => w.read_at).sort().pop() || null;
  const ids = new Set(messages.map((m) => `${m.thread}|${m.id}`));
  const fresh = (m) => live && state.shownIds && !state.shownIds.has(`${m.thread}|${m.id}`);
  // Replies I sent that have not arrived yet: a reply has arrived once a message has the id
  // the platform gave it, or (no id) my text, compared loosely, because the platform rewrites
  // it (emoji as :shortcodes:, Slack's *bold* and _italics_, mentions).
  state.sending = state.sending.filter((p) => p.thread === key && Date.now() - p.sentAt < 60000
    && !messages.some((m) => (p.postedId ? String(m.id) === String(p.postedId)
      : m.author?.name === state.me.name && looseText(m.body) === looseText(p.body))));
  const shown = [...messages, ...state.sending.map((p) => ({
    ...p, author: { kind: 'person', name: state.me.name, staff: true }, pending: true,
  }))];
  // Who they are: the server's answer for the names the messages mention, then what the
  // thread's authors, the inbox's people and the picked mentions say.
  const kinds = new Map(Object.entries(data.mentioned || {}));
  const known = (name, kind) => { if (name && kind && !kinds.has(name)) kinds.set(name, kind); };
  for (const m of shown) {
    const a = m.author || {};
    if (a.kind === 'system') continue;
    known(a.name, state.profiles.get(m.authorKey)?.relation || (a.kind === 'bot' ? 'bot' : (a.staff ? 'adobe' : 'customer')));
  }
  for (const p of Object.values(state.data?.people || {})) known(p.name, p.relation || (p.staff ? 'adobe' : null));
  for (const p of mention.picked.get(key)?.values() || []) known(p.name, p.kind === 'bot' ? 'bot' : (p.staff ? 'adobe' : null));
  setMentionNames([
    ...shown.map((m) => m.author?.name),
    ...Object.values(state.data?.people || {}).map((p) => p.name),
    ...mention.names,
    ...kinds.keys(),
  ], kinds);
  // The feed, one element per item; `enter` marks the messages that just arrived.
  const items = thread.root_at ? [] : [{ html: '<div class="sys">Earlier messages were posted before opspile started listening.</div>' }];
  let prev = null;
  let day = null;
  shown.forEach((m, i) => {
    if (dayLabel(m.at) !== day) { day = dayLabel(m.at); items.push({ html: `<div class="day"><span>${esc(day)}</span></div>` }); prev = null; }
    if (group && prev && prev.thread !== m.thread) { items.push({ html: `<div class="post">new post · ${clock(m.at)}</div>` }); prev = null; }
    if (!group && i === 1 && thread.root_at && messages.length > 1) { items.push({ html: `<div class="divider">${messages.length - 1} ${messages.length === 2 ? 'reply' : 'replies'}</div>` }); prev = null; }
    items.push({ html: message(m, prev, false), enter: fresh(m) });
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
  const stack = (data.tech || []).map((x) => `<span class="tag tech" title="${Math.round(x.p * 100)}%">${esc(TECH_LABEL[x.tech] || x.tech)}</span>`).join('');
  const head = `<div class="ph"><button class="close" data-close title="Back to the threads" aria-label="Back to the threads">${BACK}</button><h2>${emojify(thread.title || '(no text)')} ${backlink(thread, `Open in ${platform(thread)} ↗`)}</h2>
      <div class="sub">${orgIcon({ ...t, ...thread }) ? `<img src="${esc(favicon(orgIcon({ ...t, ...thread })))}" alt="">` : ''}<span>${esc(orgName(thread))}</span>${ORG_TYPE[thread.org_type] ? ` <span class="tag">${ORG_TYPE[thread.org_type]}</span>` : ''} ·
        <span>${esc(thread.channel_name || '')}</span>
        ${group ? `· <span class="tag">${members.length} posts folded into one thread</span>` : ''}
        ${sites ? `· ${sites}` : ''} ${chips} ${resolveNote(resolution)}</div>
      ${stack ? `<div class="sub stack">${stack}</div>` : ''}</div>`;
  const review = state.review && state.me.admin && model ? reviewPanel({ thread: thread.label_thread || thread.thread }, model, reviews) : '';
  const reply = composer(thread, data.draft, resolveButton(thread, resolution));
  renderPane(pane, key, {
    head, review, items, reply, patch: !switching,
  });
  state.shownIds = ids;
  cardGone();
  loadAgent(key, { latest });
  const scroller = pane.querySelector('.scroller');
  if (live && !switching) {
    // New messages scroll up into view if I was at the bottom; otherwise stay put.
    scroller.scrollTop = keepTop;
    if (wasNear) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  } else {
    const firstUnread = myRead && messages.find((m) => m.at > myRead && m.author?.name !== state.me.name);
    const el = firstUnread && scroller.querySelector(`[data-id="${CSS.escape(`${firstUnread.thread}|${firstUnread.id}`)}"]`);
    if (el) scroller.scrollTop = Math.max(0, el.offsetTop - scroller.offsetTop - 80);
    else scroller.scrollTop = scroller.scrollHeight;
  }
  const box = $('reply');
  if (box) {
    const c = composerFor(key, data.draft);
    box.value = c.text;
    if (focused && !switching) { box.focus(); if (typed === c.text) box.setSelectionRange(...caret); }
    renderDraftBar(key);
    const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(180, box.scrollHeight)}px`; };
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
      if (mentionKey(e, key)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH_ONLY.matches) { e.preventDefault(); send(key, thread); }
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); saveDraft(key, box.value); }
    };
    $('send').onclick = (e) => { if (!sendHold.held) send(key, thread); e.preventDefault(); };
    wireHoldMenu(key, thread);
  }
  if (state.data?.threads.some((x) => x.thread === key) && (switching || !live)) markRead(t);
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
  save.onclick = () => { hide(); saveDraft(key, $('reply')?.value || ''); };
  if (!btn) return;
  btn.onclick = async () => {
    hide();
    if (!btn.dataset.mine && $('reply')?.value.trim() && !(await send(key, thread))) return;
    toggleResolve();
  };
}

// ---------------------------------------------------------------- drafts
// A thread carries at most one draft, which everyone on the team that owns the channel sees
// and may change, send or discard. Each thread also remembers what you typed in it and did
// not save (in this tab only). The composer of a thread is "untouched" while its text is the
// draft it was loaded from: then it follows the draft as colleagues change or discard it.
/** The composer state of a thread: its text, and the draft version it was written from. */
function composerFor(key, draft) {
  let c = state.composers.get(key);
  if (!c || c.text === c.from) {
    c = { text: draft?.body || '', from: draft?.body || '', base: draft?.updated_at || null };
    state.composers.set(key, c);
    if (draft?.mentions?.length) {
      mention.picked.set(key, new Map(draft.mentions.map((m) => [m.name, m])));
      for (const m of draft.mentions) mention.names.add(m.name);
    }
  }
  return c;
}

function renderDraftBar(key) {
  const bar = $('draftbar');
  if (!bar || state.open !== key) return;
  const d = state.cache.get(key)?.data?.draft;
  const c = state.composers.get(key);
  if (!d) { bar.hidden = true; bar.innerHTML = ''; return; }
  const differs = c && c.text !== d.body;
  const stale = c && c.base && c.base !== d.updated_at;
  bar.hidden = false;
  bar.innerHTML = `<span class="pen">✎ Draft</span>
    <span class="pv" title="${esc(d.body)}">by ${esc(draftBy(d))}, ${ago(d.updated_at)}${differs ? (stale ? ` · changed since you started: ${esc(d.body)}` : ' · your text differs') : ''}</span>
    <span class="act">${differs ? '<button data-draft="load" title="Replace your text with the draft">Load draft</button>' : ''}<button data-draft="discard" title="Throw the draft away, for everyone on the team">Discard</button></span>`;
  bar.onclick = (e) => {
    const b = e.target.closest('[data-draft]');
    if (!b) return;
    if (b.dataset.draft === 'load') loadDraft(key);
    else discardDraft(key);
  };
}

function loadDraft(key) {
  const d = state.cache.get(key)?.data?.draft;
  state.composers.delete(key);
  const c = composerFor(key, d);
  const box = $('reply');
  if (box && state.open === key) {
    box.value = c.text;
    box.dispatchEvent(new Event('input'));
    box.focus();
  }
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

async function saveDraft(key, text, base) {
  if (state.data?.me?.readonly || !text.trim()) return { error: 'nothing to save' };
  const c = state.composers.get(key) || { text, from: '', base: null };
  const res = await request('PUT', '/api/draft', {
    thread: key, text, mentions: mentionsIn(key, text), base: base === undefined ? c.base : base,
  });
  if (res.status === 409 && res.data.draft) {
    // A colleague saved (or changed) it meanwhile: show theirs, and offer to overwrite it.
    setCachedDraft(key, res.data.draft);
    toast(`${res.data.error}.`, { label: 'Overwrite', run: () => saveDraft(key, text, res.data.draft.updated_at) });
    return { error: res.data.error, conflict: res.data.draft };
  }
  if (!res.ok) {
    const error = res.data.error || `could not save the draft (${res.status})`;
    toast(error);
    return { error };
  }
  const d = res.data.draft;
  // What the box holds now (it may have changed while saving) stays; the draft is the base.
  const now = state.composers.get(key);
  state.composers.set(key, { text: now ? now.text : text, from: text, base: d.updated_at });
  const box = state.open === key && $('reply');
  if (box && box.value !== state.composers.get(key).text) {
    box.value = state.composers.get(key).text;
    box.dispatchEvent(new Event('input'));
  }
  setCachedDraft(key, d);
  const team = state.data?.teams?.[state.team]?.name || 'the team';
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
      // An untouched composer gets the draft back too.
      const now = state.composers.get(key);
      if (!now || now.text === now.from) state.composers.delete(key);
      saveDraft(key, d.body, null);
    },
  });
}

async function send(key, thread) {
  const box = $('reply');
  const body = box.value.trim();
  state.sendError = null;
  if (!body) return false;
  $('send').disabled = true;
  closeMentions();
  const mentions = mentionsIn(key, body);
  // Sent from the thread's draft: that uses it up (unless a colleague changed it since).
  const base = state.composers.get(key)?.base;
  const res = await fetch('/api/post', { method: 'POST', credentials: 'same-origin', body: JSON.stringify({ thread: key, text: body, mentions, ...(base ? { draft: base } : {}) }) });
  const data = await res.json().catch(() => ({}));
  $('send').disabled = false;
  if (!res.ok) {
    if (data.connect) { state.me.connected = { ...state.me.connected, [data.connect]: false }; }
    state.sendError = data.error || `could not send (${res.status})`;
    toast(state.sendError);
    if (data.connect) openThread(key, { live: true });
    return false;
  }
  box.value = '';
  state.composers.set(key, { text: '', from: '', base: null });
  if (base && state.cache.get(key)?.data?.draft?.updated_at === base) setCachedDraft(key, null);
  mention.picked.delete(key);
  const last = state.shownIds ? [...state.shownIds].pop() : null;
  state.sending.push({
    thread: key, body, at: new Date().toISOString(), sentAt: Date.now(), id: `pending-${Date.now()}`, postedId: data.id || null, source: thread.source, last,
  });
  openThread(key, { live: true });
  return true;
}

/**
 * Posts `text` in the thread as the opspile app (POST /api/post/app), where the channel lets
 * the app post; `base` is the version of the shared draft it sends, which it uses up. Resolves
 * to null, or the error.
 */
async function sendAsApp(key, text, base) {
  const res = await request('POST', '/api/post/app', { thread: key, text, ...(base ? { draft: base } : {}) });
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

// ---------------------------------------------------------------- mentions
// Typing @ suggests people opspile already knows on the thread's platform (D1 accounts),
// those in the thread first, and on Teams the bots of the thread's Teams team.
// Picking one writes @Name and remembers the account, and the reply sends its id along, so
// the server turns @Name into a real Slack or Teams mention.
const mention = { list: [], i: 0, from: -1, seq: 0, timer: null, picked: new Map(), names: new Set() };
const MENTION_AT = /(?:^|[\s(])@([\p{L}\p{N}._'-]*(?: [\p{L}\p{N}._'-]*){0,2})$/u;

function mentionQuery(box, key) {
  if (box.selectionStart !== box.selectionEnd) return null;
  const m = MENTION_AT.exec(box.value.slice(0, box.selectionStart));
  if (!m || m[1].length > 40 || m[1].startsWith(' ')) return null;
  // Right after a picked mention: that one is done.
  if ([...(mention.picked.get(key)?.keys() || [])].some((name) => m[1].startsWith(`${name} `) || m[1] === name)) return null;
  return { q: m[1], from: box.selectionStart - m[1].length - 1 };
}

function suggest(key) {
  const box = $('reply');
  const hit = box && mentionQuery(box, key);
  clearTimeout(mention.timer);
  if (!hit) { closeMentions(); return; }
  const seq = ++mention.seq;
  mention.timer = setTimeout(async () => {
    let people = [];
    try {
      ({ people } = await get(`/api/mentionable?thread=${encodeURIComponent(key)}&q=${encodeURIComponent(hit.q)}`));
    } catch { /* no suggestions */ }
    if (seq !== mention.seq || state.open !== key) return;
    // A space after a name that matches nobody ends the mention.
    if (!people.length && /\s/.test(hit.q)) { closeMentions(); return; }
    Object.assign(mention, { list: people, i: 0, from: hit.from });
    renderMentions(key);
  }, hit.q ? 120 : 0);
}

function renderMentions(key) {
  const ul = $('mention-list');
  const box = $('reply');
  if (!ul || !box) return;
  if (!mention.list.length) { closeMentions(); return; }
  ul.innerHTML = mention.list.map((p, i) => `<li role="option" id="mention-${i}" class="${i === mention.i ? 'on' : ''}" aria-selected="${i === mention.i}" data-i="${i}">
    ${avatar(p.name, p.avatar)}<span>${esc(p.name)}</span>${p.kind === 'bot' ? '<span class="hint">bot</span>' : p.here ? '<span class="hint">in thread</span>' : p.staff ? '<span class="hint">Adobe</span>' : ''}</li>`).join('');
  ul.hidden = false;
  box.setAttribute('aria-expanded', 'true');
  box.setAttribute('aria-activedescendant', `mention-${mention.i}`);
  ul.onmousedown = (e) => e.preventDefault();
  ul.onclick = (e) => { const li = e.target.closest('li'); if (li) pickMention(key, Number(li.dataset.i)); };
}

function closeMentions() {
  mention.list = [];
  mention.seq += 1;
  clearTimeout(mention.timer);
  const ul = $('mention-list');
  if (ul) { ul.hidden = true; ul.innerHTML = ''; }
  $('reply')?.setAttribute('aria-expanded', 'false');
  $('reply')?.removeAttribute('aria-activedescendant');
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
  const box = $('reply');
  const p = mention.list[i];
  if (!box || !p) return;
  const insert = `@${p.name} `;
  box.value = box.value.slice(0, mention.from) + insert + box.value.slice(box.selectionStart);
  const at = mention.from + insert.length;
  box.focus();
  box.setSelectionRange(at, at);
  if (!mention.picked.has(key)) mention.picked.set(key, new Map());
  mention.picked.get(key).set(p.name, p);
  mention.names.add(p.name);
  closeMentions();
  box.style.height = 'auto';
  box.style.height = `${Math.min(180, box.scrollHeight)}px`;
}

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
const threadUrl = (key) => `/api/thread?thread=${encodeURIComponent(key)}${state.team ? `&team=${encodeURIComponent(state.team)}` : ''}`;
const memberLast = (m, kind) => (kind === 'alert' ? m.any_at : m.last_at) || m.any_at;
function markRead(t) {
  if (!t || !t.thread || state.data?.me?.readonly) return;
  // A folded entry is several platform threads: each one is read up to its own end.
  for (const m of t.members || [{ thread: t.thread, last_at: t.last_at, any_at: t.any_at }]) {
    const at = memberLast(m, t.kind);
    if (!at) continue;
    const msg = { type: 'read', thread: m.thread, at };
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
    else fetch('/api/read', { method: 'POST', body: JSON.stringify({ ...msg, team: state.team }), credentials: 'same-origin' });
  }
  if (!t.readers.includes(state.me.id)) t.readers.push(state.me.id);
  if (state.unread && t.unread) state.keep.add(t.thread);
  Object.assign(t, { unread: false, unseen: false, mentionedMe: false });
  if (lastOf(t)) t.unseenByAdobe = false;
  const applies = { 'mentioned-team': t.mentionedTeam.length > 0 };
  t.attention = applies['mentioned-team'] ? 'mentioned-team' : null;
  render();
}
let reload;
function reloadSoon(thread) {
  clearTimeout(reload);
  reload = setTimeout(async () => {
    // The open thread itself changed: fetch it alongside the inbox, not after it.
    const early = state.open && state.open === thread ? state.open : null;
    if (early) openThread(early, { live: true });
    await loadInbox();
    if (state.open && state.open !== early && (state.open === thread || state.data.threads.find((t) => t.thread === state.open)?.members?.some((m) => m.thread === thread))) {
      openThread(state.open, { live: true });
    }
  }, 500);
}
/** The teams of whoever the inbox is shown for (you, or the person you view as). */
async function loadWho() {
  const who = state.as ? await get('/api/me') : state.me;
  state.teams = who.teams;
  if (!who.teams.some((t) => t.slug === state.team)) state.team = who.teams[0]?.slug;
  renderUser();
}
const CHECK = '<svg class="ck" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" '
  + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/**
 * The toolbar's right end: you and the team on screen, and the menu behind them (the teams to
 * switch to, "View as", shortcuts, log out). Viewing as someone shows who, until left.
 */
function renderUser() {
  const name = state.me.name || state.me.email;
  $('me').textContent = name;
  $('teamName').textContent = state.teams?.find((t) => t.slug === state.team)?.name || '';
  for (const id of ['userAv', 'menuAv']) {
    $(id).textContent = initials(name);
    $(id).style.background = hue(name);
  }
  $('menuName').textContent = name;
  $('menuEmail').textContent = state.me.email || '';
  $('teams').innerHTML = (state.teams || []).map((t) => `<button class="item" role="radio" aria-checked="${t.slug === state.team}"
    data-team="${esc(t.slug)}">${CHECK}${esc(t.name)}</button>`).join('');
  const as = state.data?.me?.readonly ? state.data.me.name : null;
  $('viewing').hidden = !as;
  $('viewing').innerHTML = as ? `<span class="lbl">Viewing as</span><b>${esc(as)}</b><span class="x" aria-hidden="true">✕</span>` : '';
}

// The inbox comes in pages, newest activity first: the first page shows at once, older ones
// are fetched behind it (up to BACKFILL entries), and more on demand at the end of the list.
// Reloading the first page (live updates) keeps the older pages already here.
const BACKFILL = 1000;
const pageUrl = (before) => `/api/inbox?team=${encodeURIComponent(state.team)}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
async function loadInbox(early = null) {
  const ahead = early && await early;
  const first = ahead && ahead.team === state.team ? ahead : await get(pageUrl());
  const prev = state.data && state.data.team === first.team && state.data.as === (state.as || null) ? state.data : null;
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
  mergeProfiles(state.data.profiles);
  renderUser();
  state.coPeople = coParticipants();
  state.scores = inPass(() => new Map(state.data.threads.map((t) => [t.thread, smartScore(t)])));
  render();
  syncPages();
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
  const { team, as } = state.data;
  paging = (async () => {
    while (state.data?.team === team && state.data.as === as && state.data.page?.next
      && state.data.threads.length < limit) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 1500 }) : setTimeout(r, 50)));
      // eslint-disable-next-line no-await-in-loop
      const p = await get(pageUrl(state.data.page.next)).catch(() => null);
      if (!p || state.data?.team !== team || state.data.as !== as) break;
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
const fresh = (key) => { const hit = state.cache.get(key); return hit && Date.now() - hit.at < 60000; };
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
    inflight.set(key, get(threadUrl(key))
      .then((data) => { if (!fresh(key)) state.cache.set(key, { data, at: Date.now() }); return data; })
      .catch(() => null) // opening it will try again
      .finally(() => { inflight.delete(key); pump(); }));
  }
}
/** The threads just before and after the open one (j / k), first in the queue. */
function prefetchAround(key) {
  const i = state.order.indexOf(key);
  if (i < 0) return;
  for (const k of [state.order[i + 2], state.order[i - 1], state.order[i + 1]]) prefetch(k, { urgent: true });
}
function connect() {
  state.ws?.close();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live?team=${encodeURIComponent(state.team)}${state.as ? `&as=${state.as}` : ''}`);
  state.ws = ws;
  // Reconnecting is only shown when it takes a while (not for a team switch or a blip).
  ws.onopen = () => { clearTimeout(state.offline); state.offline = null; $('offline').hidden = true; };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    setTimeout(connect, 3000);
    state.offline ??= setTimeout(() => { $('offline').hidden = false; }, 5000);
  };
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'read' && ev.person === state.me.id) return;
    if (ev.type === 'read') reloadSoon(ev.thread);
    // Threads folded into a group (re-threading): the open one, if it is among them, reopens as
    // its group; cached copies of them and of the group are out of date.
    if (ev.type === 'thread') {
      if (ev.folded) for (const k of [ev.thread, ...ev.folded]) if (k !== state.open) state.cache.delete(k);
      reloadSoon(ev.folded?.includes(state.open) ? state.open : ev.thread);
    }
    // A draft was saved or discarded (by anyone on the team, in any tab).
    if (ev.type === 'draft') { state.cache.delete(ev.thread); reloadSoon(ev.thread); }
  };
}

function setUnread(on, open = state.open) {
  if (on !== state.unread) state.keep = new Set(on && open ? [open] : []);
  state.unread = on;
}

// ---------------------------------------------------------------- URL state
function toUrl(push = true, entry = null) {
  const q = new URLSearchParams();
  q.set('team', state.team);
  q.set('filters', '1');
  for (const [id, set] of Object.entries(state.sel)) if (set.size) q.set(`f.${id}`, [...set].join('|'));
  if (state.open) q.set('t', state.open);
  if (state.review) q.set('review', '1');
  if (state.sort !== 'team') q.set('sort', state.sort);
  if (state.unread) q.set('unread', '1');
  if (state.as) q.set('as', String(state.as));
  const url = `${location.pathname}?${q}`;
  if (url !== `${location.pathname}${location.search}`) history[push ? 'pushState' : 'replaceState'](entry, '', url);
  syncPages();
}
/**
 * The switch to the knowledge-base editor (admin team) opens the knowledge base that fits what
 * is on screen: the open thread's customer's (or the one customer filtered on), else the team's;
 * the editor picks whichever of them exists. `back` is this inbox as it is now, so the editor's
 * "Inbox" returns to it: team, filters, sort, unread, the open thread and "view as".
 */
function kbHref() {
  const q = new URLSearchParams();
  const open = state.open && (state.data?.threads.find((t) => t.thread === state.open)
    || state.cache.get(state.open)?.data?.thread);
  const customers = state.sel.customer;
  const org = open ? open.org : (customers?.size === 1 ? [...customers][0] : null);
  if (org) q.set('org', org);
  if (state.team) q.set('team', state.team);
  q.set('back', `${location.pathname}${location.search}`);
  return `/inbox/kb?${q}`;
}
function syncPages() {
  $('inbox').href = `${location.pathname}${location.search}`;
  $('kb').href = kbHref();
}
function fromUrl() {
  const q = new URLSearchParams(location.search);
  const team = q.get('team');
  state.team = team || state.me.teams[0]?.slug;
  if (q.has('filters')) {
    state.sel = {};
    for (const [k, v] of q) if (k.startsWith('f.') && v) state.sel[k.slice(2)] = new Set(v.split('|'));
  }
  // `recent` is what the personal view was called before.
  state.sort = ['personal', 'recent'].includes(q.get('sort')) ? 'personal' : 'team';
  onePick();
  setUnread(q.get('unread') === '1', q.get('t'));
  state.as = Number(q.get('as')) || null;
  return { open: q.get('t'), review: q.get('review') === '1' };
}

// ---------------------------------------------------------------- narrow screens
// Under 700px the list and the open thread take turns (`main.reading` while one is open), and
// under 1100px the filter cards are in a drawer (`main.filtering` while it is open).
const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
const syncReading = () => document.querySelector('main').classList.toggle('reading', Boolean(state.open));
/** Back to the list: the browser's Back when the list is the entry before, so Forward reopens the thread. */
function closeThread() {
  if (history.state?.list) { history.back(); return; }
  state.open = null;
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
    openThread(next);
    document.querySelector(`#threads .t[data-thread="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

async function switchTeam(slug) {
  state.team = slug; state.open = null; state.prevKeys = null;
  // A thread of a shared channel shows the read state of the team it is looked at from.
  state.cache.clear();
  syncReading();
  renderUser();
  $('pane').innerHTML = '<div class="empty">Pick a thread.</div>';
  toUrl(); await loadInbox(); connect();
}

async function start() {
  // The team is in the address (after the first visit): its inbox is fetched alongside
  // /api/me instead of after it. Viewing as someone else waits, as their teams decide.
  const asked = new URLSearchParams(location.search);
  const early = asked.get('team') && !asked.get('as')
    ? get(`/api/inbox?team=${encodeURIComponent(asked.get('team'))}`).catch(() => null) : null;
  try { state.me = await get('/api/me'); } catch (e) { $('threads').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  state.teams = state.me.teams;
  const q = new URLSearchParams(location.search);
  if (q.get('connected')) toast(q.get('connected') === 'discord' ? 'Connected your Discord account: your posts there count as yours.'
    : `Connected your ${accountOf(q.get('connected'))} account. Replies are sent as you.`);
  if (q.get('connect_error')) toast(`Could not connect: ${q.get('connect_error')}`);
  const initial = fromUrl();
  // The thread the URL opens is open from the start: settling the URL keeps it, and opening it
  // adds no history entry (Back from here leaves the inbox, to where it came from).
  state.open = initial.open || null;
  syncReading();
  await loadWho();
  toUrl(false);
  $('teams').onclick = (e) => {
    const b = e.target.closest('[data-team]');
    if (!b) return;
    $('menu').hidePopover();
    if (b.dataset.team !== state.team) switchTeam(b.dataset.team);
  };
  $('menu').addEventListener('toggle', (e) => $('user').setAttribute('aria-expanded', String(e.newState === 'open')));
  $('filters').onclick = (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (e.target.dataset.clear) {
      for (const f of cardFacets(card.dataset.f)) delete state.sel[f.id];
      render(); toUrl(); return;
    }
    const r = e.target.closest('.fr');
    if (!r || r.dataset.v === undefined) return;
    const id = r.dataset.f;
    const set = single(id) ? new Set() : (state.sel[id] || new Set());
    if (state.sel[id]?.has(r.dataset.v)) set.delete(r.dataset.v); else set.add(r.dataset.v);
    if (set.size) state.sel[id] = set; else delete state.sel[id];
    render();
    toUrl();
  };
  // A row under the pointer is about to be opened: fetch it first.
  $('threads').addEventListener('pointerover', (e) => {
    const row = e.target.closest('.t');
    if (row) prefetch(row.dataset.thread, { urgent: true });
  });
  $('threads').addEventListener('click', (e) => { if (e.target.closest('[data-older]')) loadOlder(); });
  $('threads').onclick = (e) => {
    if (e.target.closest('[data-filters]')) { setFiltering(!state.filtering); return; }
    const sort = e.target.closest('[data-sort]');
    if (sort) { state.sort = sort.dataset.sort; onePick(); render(); toUrl(); return; }
    if (e.target.closest('[data-unread]')) { setUnread(!state.unread); render(); toUrl(); return; }
    if (e.target.closest('a')) return;
    const el = e.target.closest('.t');
    if (el) openThread(el.dataset.thread);
  };
  // A tap on the dimmed page beside the filter drawer closes it.
  document.querySelector('main').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && state.filtering) setFiltering(false);
  });
  wireDrawerSwipes();
  $('pane').onclick = async (e) => {
    if (e.target.closest('[data-close]')) { closeThread(); return; }
    const msg = e.target.closest('.msg');
    const pick = e.target.closest('[data-pick]');
    const chip = e.target.closest('.rx button');
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
      ? Object.fromEntries(Object.keys(QUESTION_LABEL).map((q) => [q, modelValue(model, q)]).filter(([, v]) => v != null))
      : staged;
    for (const [question, value] of Object.entries(answers)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch('/api/review', { method: 'POST', credentials: 'same-origin', body: JSON.stringify({ thread, question, value }) });
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
    if (e.key === 'j') { e.preventDefault(); move(1); }
    if (e.key === 'k') { e.preventDefault(); move(-1); }
    if (e.key === 'e') { e.preventDefault(); toggleResolve(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.picker, [data-picker]')) closePicker(); });
  // The Send button's menu closes on a tap or click anywhere else.
  document.addEventListener('pointerdown', (e) => { if ($('hold') && !e.target.closest('.sendwrap')) $('hold').hidden = true; });
  wireLightbox();
  window.addEventListener('popstate', async (e) => {
    // Safari's edge swipe has already slid the list or the thread into view: no second slide.
    const main = document.querySelector('main');
    main.classList.toggle('instant', Boolean(e.hasUAVisualTransition));
    const team = state.team;
    const { open, review } = fromUrl();
    renderUser();
    if (team !== state.team) { state.prevKeys = null; await loadInbox(); connect(); }
    state.review = review;
    $('review').setAttribute('aria-pressed', String(review));
    render();
    if (open && open !== state.open) openThread(open); else if (!open) { state.open = null; $('pane').innerHTML = '<div class="empty">Pick a thread.</div>'; }
    syncReading();
    syncPages();
    // The styles are applied without transitions before they come back.
    main.getBoundingClientRect();
    main.classList.remove('instant');
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
      state.open = null;
      syncReading();
      $('pane').innerHTML = '<div class="empty">Pick a thread.</div>';
      await loadWho();
      toUrl();
      await loadInbox();
      connect();
    };
    sel.onchange = () => { $('menu').hidePopover(); viewAs(Number(sel.value) || null); };
    $('viewing').onclick = () => viewAs(null);
    $('review').hidden = false;
    get('/api/review/queue').then((r) => { state.answers = r.answers; });
    $('review').onclick = () => {
      state.review = !state.review;
      $('review').setAttribute('aria-pressed', String(state.review));
      toUrl();
      if (state.open) openThread(state.open, { live: true });
    };
  }
  // The switch to the editor and the admin pages: the admin team, and team managers (who see
  // their teams' members and knowledge bases there).
  if (state.me.admin || state.me.manages?.length) {
    $('pages').hidden = false;
    $('inbox').onclick = (e) => e.preventDefault();
    // Channels team managers asked for, waiting for the admin team: their number on Admin.
    if (state.me.admin && !state.as) {
      get('/api/admin/requests?count=1').then(({ open }) => {
        if (!open) return;
        $('adminPage').insertAdjacentHTML('beforeend', `<span class="count">${Number(open)}</span>`);
        $('adminPage').title = `${open} channel request${open === 1 ? '' : 's'} from team managers to confirm or decline`;
        $('adminPage').href = '/inbox/admin?tab=requests';
      }).catch(() => {});
    }
    // Fresh at the moment it is used (the open thread's customer may have loaded since).
    for (const ev of ['pointerenter', 'focus']) $('kb').addEventListener(ev, syncPages);
  }
  await loadInbox(early);
  if (initial.review && state.me.admin) { state.review = true; $('review').setAttribute('aria-pressed', 'true'); }
  if (initial.open) openThread(initial.open);
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
  status: 'status', type: 'type', platform: 'platform', resolved: 'resolved', waiting_on: 'next', urgency: 'urgency', kind: 'kind', customer: 'customer', draft: 'draft',
};
const FILTER_VALUES = {
  status: STATUS_ORDER, type: ['conversation', 'alert'], platform: ['slack', 'teams', 'discord'], resolved: ['open', 'resolved'],
  waiting_on: ['us', 'customer', 'nobody'], urgency: ['critical', 'high', 'normal', 'low'], kind: Object.keys(KIND_EMOJI),
  draft: ['mine', 'team', 'none'],
};
const cap = (v) => v[0].toUpperCase() + v.slice(1);
const toFacet = { platform: cap, waiting_on: cap };
const fromFacet = { platform: (v) => v.toLowerCase(), next: (v) => v.toLowerCase() };

function activeFilters() {
  const args = Object.fromEntries(Object.entries(FILTER_ARGS).map(([a, id]) => [id, a]));
  const shown = new Set(viewFacets().map((f) => f.id));
  return Object.fromEntries(Object.entries(state.sel).filter(([id, set]) => set.size && shown.has(id))
    .map(([id, set]) => [args[id] || id, [...set].map((v) => (fromFacet[id] ? fromFacet[id](v) : v))]));
}

function threadInfo(t) {
  const info = {
    thread: t.thread, title: clip(t.title || '(no text)', 90), customer: t.org, platform: platform(t).toLowerCase(),
    status: statusOf(t), waiting_on: waitingOn(t).toLowerCase(), urgency: urgencyOf(t), kind: kindOf(t),
    resolved: resolvedOf(t) === 'resolved', last: lastOf(t) || t.any_at || null,
  };
  if (t.unread) info.unread = true;
  if (t.draft) info.draft = { by: draftBy(t.draft), saved: t.draft.updated_at };
  return info;
}

const teamThread = (key) => state.data?.threads.find((t) => t.thread === key);
const UNKNOWN_THREAD = 'Unknown thread. Use a `thread` value from list_threads; only threads of the selected team are known.';
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
  const box = $('reply');
  box.value = text;
  box.dispatchEvent(new Event('input'));
  box.focus();
  box.setSelectionRange(text.length, text.length);
}

const WEBMCP_TOOLS = [
  {
    name: 'get_inbox_state',
    description: 'Returns who is signed in, the selected ops team and the teams they can switch to, the active filters and sort, the open thread, and how many threads each filter value matches. Call it first to learn which filter values exist.',
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
        team: state.team, teams: (state.teams || []).map((t) => t.slug), sort: state.sort,
        unread_only: state.unread, filters: activeFilters(), open_thread: state.open, shown: state.order.length, total: state.data.threads.length, counts,
      });
    },
  },
  {
    name: 'filter_threads',
    description: 'Sets the inbox filters, sort and team on screen, like clicking the filter cards. Each filter given replaces that filter; an empty list clears it; filters not given stay as they are. Returns how many threads match. Then call list_threads.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear every filter first. The default view shows conversations only (type: ["conversation"]).' },
        status: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.status }, description: 'critical/hot: urgent and unseen by Adobe; you: needs the viewer; waiting: waits on us too long; silent: customer silent too long' },
        waiting_on: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.waiting_on }, description: 'Who has the next move' },
        urgency: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.urgency } },
        kind: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.kind } },
        resolved: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.resolved } },
        type: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.type }, description: 'Conversations with customers, or automated alerts' },
        platform: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.platform } },
        draft: { type: 'array', items: { type: 'string', enum: FILTER_VALUES.draft }, description: 'Threads with a shared draft reply saved last by the viewer (mine) or a colleague (team), or without one (none)' },
        customer: { type: 'array', items: { type: 'string' }, description: 'Customer names as get_inbox_state lists them; case does not matter' },
        involves_me: { type: 'boolean', description: 'Only threads the viewer posted in or was mentioned in' },
        sort: { type: 'string', enum: ['team', 'personal'], description: 'team: what needs the viewer most first, with every filter; personal: latest activity first, filtered on one customer at most (the other filters do not apply there, and alerts are not shown)' },
        unread_only: { type: 'boolean', description: 'Only threads the viewer has not read' },
        team: { type: 'string', description: 'Ops team slug from get_inbox_state; switching team closes the open thread' },
      },
    },
    execute: async (args = {}) => {
      if (!state.data) return fail('The inbox is still loading. Try again in a moment.');
      // Check everything before changing anything.
      if (args.team && !(state.teams || []).some((t) => t.slug === args.team)) {
        return fail(`Unknown team "${args.team}". Teams: ${(state.teams || []).map((t) => t.slug).join(', ')}.`);
      }
      const next = {};
      for (const arg of Object.keys(FILTER_ARGS)) {
        if (!(arg in args) || args[arg] == null) continue;
        const given = [].concat(args[arg]).map((v) => String(v).trim()).filter(Boolean);
        if (arg === 'customer') {
          const orgs = [...new Set(state.data.threads.map((t) => t.org).filter(Boolean))];
          const picked = given.map((v) => orgs.find((o) => o.toLowerCase() === v.toLowerCase()));
          const miss = given.filter((v, i) => !picked[i]);
          if (miss.length) return fail(`No threads from customer ${miss.map((v) => `"${v}"`).join(', ')} in this team. Customers with threads: ${orgs.slice(0, 15).join(', ')}.`);
          next[arg] = picked;
        } else {
          const vals = given.map((v) => v.toLowerCase());
          const bad = vals.filter((v) => !FILTER_VALUES[arg].includes(v));
          if (bad.length) return fail(`Invalid ${arg} value(s) ${bad.join(', ')}. Use: ${FILTER_VALUES[arg].join(', ')}.`);
          next[arg] = vals.map((v) => (toFacet[arg] ? toFacet[arg](v) : v));
        }
      }
      const view = args.sort === 'team' || args.sort === 'personal' ? args.sort : state.sort;
      if (view === 'personal' && next.customer?.length > 1) return fail('The personal view filters on one customer at a time. Give one, or sort "team".');
      if (args.team && args.team !== state.team) await switchTeam(args.team);
      if (args.clear) { state.sel = {}; setUnread(false); }
      for (const [arg, vals] of Object.entries(next)) {
        if (vals.length) state.sel[FILTER_ARGS[arg]] = new Set(vals); else delete state.sel[FILTER_ARGS[arg]];
      }
      if (args.involves_me === true) state.sel.involves = new Set(['me']);
      else if (args.involves_me === false) delete state.sel.involves;
      if (args.sort === 'team' || args.sort === 'personal') state.sort = args.sort;
      onePick();
      if (typeof args.unread_only === 'boolean') setUnread(args.unread_only);
      render();
      toUrl();
      return out({ team: state.team, filters: activeFilters(), sort: state.sort, unread_only: state.unread, shown: state.order.length, total: state.data.threads.length });
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
        can_reply: !replyBlocked(data), can_react: !state.data?.me?.readonly, messages: msgs,
        ...(data.draft ? { shared_draft: { by: draftBy(data.draft), saved: data.draft.updated_at, text: data.draft.body } } : {}),
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
    description: 'Saves a reply as the shared draft of a thread, without posting anything: everyone in the team sees it in the inbox and can change, send or discard it. A thread has at most one; to replace the one open_thread shows, pass its `saved` as `base`.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread key from list_threads; defaults to the open thread' },
        text: { type: 'string', description: 'The whole reply, in Markdown (up to 8000 characters)' },
        base: { type: 'string', description: 'The `saved` of the shared draft this replaces, from open_thread' },
      },
      required: ['text'],
    },
    execute: async ({ thread, text, base } = {}) => {
      if (state.data?.me?.readonly) return fail(READONLY);
      const body = String(text || '').trim();
      if (!body) return fail('The draft is empty. Provide the reply text.');
      const key = thread || state.open;
      if (!key) return fail('No thread is open. Pass `thread`, or open one with open_thread first.');
      if (!teamThread(key)) return fail(UNKNOWN_THREAD);
      const data = await showThread(key);
      if (!data) return fail('Could not load this thread. Try again, or ask the user to reload the page.');
      const res = await saveDraft(key, body, base || null);
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
      return await send(key, data.thread) ? out({ ok: true, thread: key, note: 'Sent; it shows as "sending" until Slack or Teams confirms it.' }) : fail(state.sendError || 'Could not send.');
    },
  },
  {
    name: 'post_as_bot',
    description: 'Posts a reply in a thread as the opspile app (its Slack app, Teams bot or Discord bot), not as the signed-in person, visible to everyone in the channel including customers, after a confirmation dialog. Only in channels where the team lets the app post ("Post messages" in the knowledge-base editor). No mentions; Discord takes up to 2000 characters. Pass `draft` (the shared draft\'s `saved`) when it sends that draft, so it is used up.',
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
      const ask = () => confirmInPage(`Post this reply in ${where} as the opspile app?`, body, client?.signal, 'Post as opspile');
      const yes = client?.requestUserInteraction ? await client.requestUserInteraction(ask) : await ask();
      if (yes === null) return fail('Nobody confirmed within 2 minutes, so nothing was sent.');
      if (!yes) return fail('The user declined to send, so nothing was sent.');
      const error = await sendAsApp(key, body, draft);
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
 * the original), the close button or Escape dismisses it, and focus goes back to the image.
 */
function openLightbox(img) {
  const src = img.currentSrc || img.src;
  const dlg = toNode(`<dialog class="lightbox" aria-label="${esc(img.alt || 'Image')}">
    <img src="${esc(src)}" alt="${esc(img.alt)}">
    <div class="bar"><a href="${esc(src)}" target="_blank" rel="noopener">Open original ↗</a>
    <button type="button" aria-label="Close">✕</button></div></dialog>`);
  const dismiss = () => {
    if (!dlg.isConnected) return;
    if (dlg.open) dlg.close();
    dlg.remove();
    img.focus({ preventScroll: true });
  };
  dlg.addEventListener('click', (e) => { if (!e.target.closest('a')) dismiss(); });
  // Escape: tidy up right away instead of waiting for the close event.
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
  dlg.addEventListener('close', dismiss);
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector('button').focus();
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
      console.warn(`WebMCP: could not register ${tool.name}`, e);
    }
  }
}

wireCards();
start();
