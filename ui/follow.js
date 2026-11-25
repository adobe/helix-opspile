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
 * Following and muting, every page's, as the global `Follow` (src/following.js has the rules).
 * Whatever may be followed has its Follow button wherever it is shown: a product (`tech`), a
 * topic (`area`), a customer (`org`) or a person (`person`). It is a toggle, Follow / Following,
 * for you; for someone who manages a team (and the admin team) it is a split button whose chevron
 * opens who follows it, you and each team you may follow for, to check or uncheck. Only your own
 * teams (those you are on) are shown as following it, in its count, title and dropdown: a team you
 * are not on is there only to be found by name, where you may follow for it (the admin team). In
 * a team's context (its page, `{ team }`), it is you and that team only. A person is
 * only ever your own follow. A customer has a Mute beside it, your own only: its threads leave
 * your personal view until you post in one of them, or follow it again; following and muting it
 * are one or the other.
 *
 * - `init({ me, request, say, readonly })`: who you are (`me.teams`, for which of the teams are
 *   yours), how the page sends a request (`request(method, path, body)`, answering
 *   `{ ok, status, data }`), how it says what happened (`say(text, undo)`, `undo` a function or
 *   none; a toast of its own without), and whether it changes nothing (viewing as someone).
 * - `set(state)`: what GET /api/follows answers, and what every button and list draws from.
 * - `button({ kind, id, name }, { mute, team })`: the button's HTML, `''` where there is nothing
 *   to follow (no state yet, read-only, an unassigned customer, a person known by an account
 *   only); `mute: false` leaves out a customer's Mute, `team` is the team whose page it is on,
 *   the only team its chevron has. Clicks are handled here, for the whole page.
 * - `on(fn)`: `fn(change)` after each change is done, `{ kind, id, name, team, follow, mute }`.
 * - `menu()`: the Following section of your menu (#menu), what you follow and mute, each to
 *   stop, and Find something to follow (ui/followsuggest.js, in a dialog).
 * - `follows(kind, id, who)`, `muted(kind, id)`, `teams(kind, id)`, `ready()`, `state()`.
 *
 * Its look is ui/spectrum.css's (`.fo`, `.fo-pop`). Everything in it is a name, written escaped.
 */
globalThis.Follow = (() => {
  const TEAM_KINDS = ['tech', 'area', 'org'];
  const MUTE_KINDS = ['org'];
  const NOUN = {
    tech: 'product', area: 'topic', org: 'customer', person: 'person',
  };
  // Past this many teams to follow for (the admin team's), the others are found by name.
  const SHOWN_TEAMS = 6;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '');

  /**
   * What happened, said where the page has no note of its own: S2's Toast at the bottom, with
   * Undo where it is undone, for a few seconds.
   */
  function toast(text, undo) {
    document.querySelectorAll('.fo-toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = 'fo-toast';
    el.setAttribute('role', 'status');
    const said = document.createElement('span');
    said.textContent = text;
    el.append(said);
    if (undo) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Undo';
      b.onclick = () => { el.remove(); undo(); };
      el.append(b);
    }
    document.body.append(el);
    setTimeout(() => el.remove(), undo ? 8000 : 5000);
  }

  const cfg = {
    me: null,
    readonly: false,
    say: toast,
    request: async (method, path, body) => {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        redirect: 'manual',
        headers: body ? { 'content-type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    },
  };
  let st = null;
  const listeners = new Set();
  // The names things were shown with, for the lists, beside those the state has.
  const shownAs = new Map();
  // The changes on their way, by `kind:id:who`: their buttons are busy.
  const busy = new Set();

  const key = (kind, id) => `${kind}:${id}`;
  const ids = (list) => (list || []).map(String);
  const nameOf = (kind, id) => shownAs.get(key(kind, id)) || st?.names?.[key(kind, id)] || String(id);
  const teamName = (slug) => st?.teamNames?.[slug] || slug;
  const mine = () => new Set((cfg.me?.teams || []).map((t) => t.slug || t));

  const ready = () => Boolean(st) && !cfg.readonly;
  const follows = (kind, id, who = 'me') => {
    if (!st) return false;
    const of = who === 'me' ? st.me : st.teams?.[who];
    return ids(of?.[kind]).includes(String(id));
  };
  const muted = (kind, id) => Boolean(st) && ids(st.muted?.[kind]).includes(String(id));
  /** The teams (of yours, or that you follow for) that follow it. */
  const teams = (kind, id) => Object.keys(st?.teams || {}).filter((t) => follows(kind, id, t));
  /** The teams you may follow `kind` for. */
  const mayFor = (kind) => (TEAM_KINDS.includes(kind) ? st?.may || [] : []);
  /**
   * The teams that matter to the button: `team`, in its context, where you are on it or may follow
   * for it; else the teams you are on. Only these show as following it.
   */
  const relevant = (kind, team) => {
    if (!TEAM_KINDS.includes(kind)) return [];
    if (team) return mine().has(team) || mayFor(kind).includes(team) ? [team] : [];
    return [...mine()];
  };
  /** Of the teams that matter (`relevant`), those that follow it. */
  const shownTeams = (kind, id, team) => relevant(kind, team).filter((t) => follows(kind, id, t));
  /** Whether `id` of `kind` is one that may be followed. */
  const followable = (kind, id) => {
    if (!NOUN[kind] || id === undefined || id === null || String(id) === '') return false;
    if (kind === 'person') return /^\d+$/.test(String(id));
    if (kind === 'org') return !String(id).startsWith('_');
    return true;
  };

  /** The button's title: what following it does, and who else does. */
  function followTitle(kind, id, name, team) {
    const on = follows(kind, id);
    const by = shownTeams(kind, id, team).map(teamName);
    const also = by.length ? ` ${and(by)} ${by.length === 1 ? 'follows' : 'follow'} it.` : '';
    return on ? `You follow ${name}: its threads are in your personal view. Click to stop.${also}`
      : `Follow ${name}: its threads come into your personal view, in any channel.${also}`;
  }

  /** What the button holds for `{ kind, id, name }`. */
  function inner(kind, id, name, withMute, team) {
    const on = follows(kind, id);
    const may = mayFor(kind);
    const n = shownTeams(kind, id, team).length;
    const meBusy = busy.has(`${key(kind, id)}:me`);
    const main = `<button type="button" class="fo-b" data-fo-act="me" aria-pressed="${on}"
      title="${esc(followTitle(kind, id, name, team))}"${meBusy ? ' disabled' : ''}>${on ? 'Following' : 'Follow'}</button>`;
    // The chevron: where you may follow for a team, or, on a team's page, where you are on it.
    const split = team ? relevant(kind, team).length > 0 : may.length > 0;
    const more = split ? `<button type="button" class="fo-more" data-fo-act="who" aria-haspopup="menu" aria-expanded="false"
      aria-label="${esc(`Who follows ${name}: you, or a team`)}" title="Who follows it: you, or a team you manage">${n ? `<span class="fo-n">${n}</span>` : ''}<span class="s2-chevron" aria-hidden="true"></span></button>` : '';
    const isMuted = withMute && muted(kind, id);
    const muteBtn = withMute ? `<button type="button" class="fo-mute" data-fo-act="mute" aria-pressed="${isMuted}"
      title="${esc(isMuted ? `You muted ${name}: its threads are back in your personal view once you post in one of them. Click to unmute.`
    : `Mute ${name}: its threads leave your personal view until you post in one of them, or follow it.`)}"${busy.has(`${key(kind, id)}:mute`) ? ' disabled' : ''}><span class="fo-ico" aria-hidden="true"></span>${isMuted ? 'Muted' : 'Mute'}</button>` : '';
    return `<span class="fo-follow${more ? ' split' : ''}">${main}${more}</span>${muteBtn}`;
  }

  function button({ kind, id, name }, { mute: muting = MUTE_KINDS.includes(kind), team = null } = {}) {
    if (!ready() || !followable(kind, id)) return '';
    const shown = name || nameOf(kind, id);
    if (name) shownAs.set(key(kind, id), name);
    const withMute = muting && MUTE_KINDS.includes(kind);
    const at = team && TEAM_KINDS.includes(kind) ? String(team) : null;
    return `<span class="fo" data-fo="${esc(kind)}" data-fo-id="${esc(id)}" data-fo-name="${esc(shown)}"${at ? ` data-fo-team="${esc(at)}"` : ''}${withMute ? ' data-fo-mute' : ''}>${inner(kind, String(id), shown, withMute, at)}</span>`;
  }

  /** Every button and list on the page, drawn again from the state. */
  function redraw() {
    for (const el of document.querySelectorAll('.fo[data-fo]')) {
      const {
        fo: kind, foId: id, foName: name, foTeam: team,
      } = el.dataset;
      el.innerHTML = ready() ? inner(kind, id, name, el.hasAttribute('data-fo-mute'), team || null) : '';
    }
    if (pop.el?.matches(':popover-open')) drawPop();
    menu();
  }

  function set(state) {
    st = state ? {
      me: {
        tech: [], area: [], org: [], person: [], ...(state.me || {}),
      },
      teams: state.teams || {},
      muted: { org: [], ...(state.muted || {}) },
      may: state.may || [],
      names: state.names || {},
      teamNames: state.teamNames || {},
    } : null;
    redraw();
  }

  // ---- changing it ------------------------------------------------------------------------

  /** The state with `kind:id` followed by `who` or not (`on`): what the buttons show at once. */
  function guess(kind, id, who, on) {
    const next = structuredClone(st);
    const of = who === 'me' ? next.me : (next.teams[who] ||= { tech: [], area: [], org: [] });
    const list = ids(of[kind]).filter((x) => x !== String(id));
    of[kind] = on ? [...list, String(id)] : list;
    if (who === 'me' && on && MUTE_KINDS.includes(kind)) next.muted[kind] = ids(next.muted[kind]).filter((x) => x !== String(id));
    return next;
  }

  /**
   * Sends `body` (PUT /api/follows) for `kind:id`, the buttons busy (`slot`) and showing `guessed`
   * meanwhile; then the state is what it answers. `said` is what to say once it is done, `undo`
   * what undoes it. Whether it was done.
   */
  async function send({
    kind, id, name, slot, body, guessed, said, undo, change,
  }) {
    const before = st;
    const b = `${key(kind, id)}:${slot}`;
    busy.add(b);
    if (guessed) st = guessed;
    redraw();
    const res = await cfg.request('PUT', '/api/follows', { kind, target: id, ...body })
      .catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
    busy.delete(b);
    if (!res.ok) {
      st = before;
      redraw();
      cfg.say(`Could not ${said.verb} ${name}: ${res.data?.error || res.status || 'no answer'}`);
      return false;
    }
    set(res.data);
    cfg.say(said.text, undo);
    for (const fn of listeners) fn({ kind, id: String(id), name, ...change });
    return true;
  }

  /** Follows `kind:id` as `who` (`me`, or a team's slug), or no more. */
  function toggle(kind, id, name, who = 'me') {
    if (!ready()) return Promise.resolve(false);
    const on = !follows(kind, id, who);
    const team = who === 'me' ? null : who;
    const inbox = kind === 'org' ? 'its channels are in its inbox, shared' : 'its threads are in its inbox';
    const text = team
      ? (on ? `${teamName(team)} follows ${name}: ${inbox}.` : `${teamName(team)} no longer follows ${name}.`)
      : (on ? `Following ${name}: its threads are in your personal view.` : `No longer following ${name}.`);
    const wasMuted = !team && on && muted(kind, id);
    return send({
      kind,
      id,
      name,
      slot: who,
      body: { follow: on, ...(team ? { team } : {}) },
      guessed: guess(kind, id, who, on),
      said: { verb: on ? 'follow' : 'unfollow', text },
      // Undone: the follow as it was, and the mute it lifted.
      undo: () => (wasMuted ? mute(kind, id, name) : toggle(kind, id, name, who)),
      change: { team, follow: on },
    });
  }

  /** Mutes customer `id`, or no more. */
  function mute(kind, id, name) {
    if (!ready() || !MUTE_KINDS.includes(kind)) return Promise.resolve(false);
    const on = !muted(kind, id);
    const wasFollowing = on && follows(kind, id);
    const guessed = structuredClone(st);
    guessed.muted[kind] = on ? [...ids(guessed.muted[kind]), String(id)] : ids(guessed.muted[kind]).filter((x) => x !== String(id));
    if (on) guessed.me[kind] = ids(guessed.me[kind]).filter((x) => x !== String(id));
    return send({
      kind,
      id,
      name,
      slot: 'mute',
      body: { mute: on },
      guessed,
      said: {
        verb: on ? 'mute' : 'unmute',
        text: on ? `Muted ${name}: its threads are back once you post in one of them.${wasFollowing ? ' You no longer follow it.' : ''}`
          : `${name} is no longer muted.`,
      },
      // Undone: unmuted, and followed again if it was.
      undo: () => (wasFollowing ? toggle(kind, id, name) : mute(kind, id, name)),
      change: { mute: on },
    });
  }

  // ---- who follows it: the dropdown -------------------------------------------------------

  const pop = { el: null, at: null, find: '' };

  /** The dropdown's element: one for the page, in the top layer, so nothing clips it. */
  function popEl() {
    if (pop.el) return pop.el;
    const el = document.createElement('div');
    el.className = 'menu fo-pop';
    el.popover = 'auto';
    el.setAttribute('role', 'menu');
    el.addEventListener('toggle', (e) => {
      if (e.newState === 'closed') {
        pop.at?.querySelector('[data-fo-act="who"]')?.setAttribute('aria-expanded', 'false');
        pop.at = null;
        pop.find = '';
      }
    });
    el.addEventListener('input', (e) => {
      if (!e.target.matches('.fo-find')) return;
      pop.find = e.target.value;
      drawPop({ keepFind: true });
    });
    document.body.append(el);
    pop.el = el;
    return el;
  }

  /** A row of the dropdown: `who` follows it, or not; `may` whether you change that. */
  const row = (who, label, on, may, sub = '') => `<button type="button" class="item" role="menuitemcheckbox" data-fo-who="${esc(who)}"
    aria-checked="${on}"${may && !busy.has(`${pop.key}:${who}`) ? '' : ' disabled'}><span class="ck s2-check" aria-hidden="true"></span><span class="fo-who">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;

  function drawPop({ keepFind = false } = {}) {
    const at = pop.at;
    if (!at || !at.isConnected) { pop.el?.hidePopover(); return; }
    const {
      fo: kind, foId: id, foName: name, foTeam: team,
    } = at.dataset;
    pop.key = key(kind, id);
    const may = mayFor(kind);
    const yours = mine();
    const following = teams(kind, id);
    // On a team's page, that team only; else yours, then (past SHOWN_TEAMS) the rest by name: a
    // team you are not on is not shown for following it, only found where you may follow for it.
    const first = team ? may.filter((t) => t === team) : may.filter((t) => yours.has(t));
    const rest = team ? [] : may.filter((t) => !first.includes(t));
    const all = rest.length + first.length <= SHOWN_TEAMS;
    const q = pop.find.trim().toLowerCase();
    const found = all ? rest : (q ? rest.filter((t) => teamName(t).toLowerCase().includes(q) || t.includes(q)) : []);
    // Yours that you do not manage, shown but not changed: those that follow it; on its page, the team.
    const ro = relevant(kind, team || null)
      .filter((t) => !may.includes(t) && (team || following.includes(t)));
    const sorted = (list) => [...list].sort((a, b) => teamName(a).localeCompare(teamName(b)));
    const what = kind === 'org' ? 'every channel of it is in its inbox, shared, now and later'
      : 'its threads are in its inbox, in any team\'s channels';
    const html = `<div class="fo-h">Who follows ${esc(name)}</div>
      ${row('me', 'You', follows(kind, id), true, 'your personal view')}
      <div class="fo-sep" role="separator"></div><div class="fo-h sub">Teams</div>
      ${sorted([...first, ...(all ? rest : [])]).map((t) => row(t, teamName(t), follows(kind, id, t), true)).join('')}
      ${sorted(ro).map((t) => row(t, teamName(t), following.includes(t), false, 'you do not manage it')).join('')}
      ${all ? '' : `<label class="fo-another"><span class="hint">Another team</span><input type="search" class="fo-find" autocomplete="off" spellcheck="false" value="${esc(pop.find)}"></label>
        ${sorted(found).slice(0, SHOWN_TEAMS).map((t) => row(t, teamName(t), follows(kind, id, t), true)).join('')}`}
      <p class="hint fo-hint">A team that follows it: ${what}.</p>`;
    const el = popEl();
    const focused = keepFind && document.activeElement?.matches?.('.fo-find');
    // The row that had the focus keeps it, drawn again.
    const was = el.contains(document.activeElement) ? document.activeElement.dataset?.foWho : null;
    el.innerHTML = html;
    el.setAttribute('aria-label', `Who follows ${name}`);
    if (focused) {
      const input = el.querySelector('.fo-find');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (was) el.querySelector(`[data-fo-who="${CSS.escape(was)}"]`)?.focus();
  }

  /** Places the dropdown under (or over) the Follow of `at`, from its start, inside the window. */
  function place(at) {
    const el = pop.el;
    const r = (at.querySelector('.fo-follow') || at).getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = r.bottom + h + 8 <= window.innerHeight || r.top < h + 8;
    el.style.top = `${Math.max(8, below ? r.bottom + 4 : r.top - h - 4)}px`;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  }

  function openPop(at) {
    const el = popEl();
    if (el.matches(':popover-open') && pop.at === at) { el.hidePopover(); return; }
    pop.at = at;
    pop.find = '';
    drawPop();
    el.showPopover();
    place(at);
    at.querySelector('[data-fo-act="who"]')?.setAttribute('aria-expanded', 'true');
    el.querySelector('.item:not([disabled])')?.focus();
  }

  // Clicks, for the whole page: before the page's own (capture), which never see them, so that a
  // button in a row, or in a dropdown of the page, does only what it says.
  document.addEventListener('click', (e) => {
    const inPop = pop.el && e.target.closest?.('.fo-pop');
    const act = e.target.closest?.('.fo [data-fo-act]');
    if (!inPop && !act) return;
    e.stopPropagation();
    if (inPop) {
      const who = e.target.closest('[data-fo-who]');
      if (!who || who.disabled || !pop.at) return;
      const { fo: kind, foId: id, foName: name } = pop.at.dataset;
      toggle(kind, id, name, who.dataset.foWho);
      return;
    }
    e.preventDefault();
    if (act.disabled) return;
    const at = act.closest('.fo');
    const { fo: kind, foId: id, foName: name } = at.dataset;
    if (act.dataset.foAct === 'who') openPop(at);
    else if (act.dataset.foAct === 'mute') mute(kind, id, name);
    else toggle(kind, id, name);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!pop.el?.matches(':popover-open') || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const items = [...pop.el.querySelectorAll('.item:not([disabled]), .fo-find')];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    if (next) { e.preventDefault(); next.focus(); }
  });

  // ---- your menu's Following ----------------------------------------------------------------

  /** The section of your menu (#menu): made where the page has none (Teams, Customers, Topics). */
  function menuBox() {
    let box = document.getElementById('followBox');
    if (box) return box;
    const m = document.getElementById('menu');
    if (!m) return null;
    box = document.createElement('section');
    box.id = 'followBox';
    box.hidden = true;
    box.innerHTML = `<h4>Following</h4><div id="followList"></div><p class="hint" id="followHint"></p>
      <button class="item allow" id="followFind" aria-haspopup="dialog">Find something to follow</button>`;
    const after = m.querySelector('.id');
    if (after) after.after(box); else m.prepend(box);
    return box;
  }

  function menu() {
    const box = menuBox();
    if (!box) return;
    box.hidden = !ready();
    if (box.hidden) return;
    const list = box.querySelector('#followList');
    const order = ['tech', 'area', 'org', 'person'];
    const followed = order.flatMap((k) => ids(st.me[k]).map((id) => [k, id]))
      .sort(([ka, a], [kb, b]) => order.indexOf(ka) - order.indexOf(kb) || nameOf(ka, a).localeCompare(nameOf(kb, b)));
    const mutedList = ids(st.muted.org).map((id) => ['org', id]);
    const item = (kind, id, act, title) => `<button class="item" role="switch" aria-checked="true" data-fo-menu="${act}" data-kind="${esc(kind)}" data-id="${esc(id)}"
      title="${esc(title)}"><span class="${act === 'mute' ? 'fo-ico' : 'ck s2-check'}" aria-hidden="true"></span><span class="fo-who">${esc(nameOf(kind, id))}</span><small>${esc(NOUN[kind])}</small></button>`;
    list.innerHTML = followed.map(([k, id]) => item(k, id, 'follow', `A ${NOUN[k]}: click to stop following it`)).join('')
      + (mutedList.length ? `<div class="fo-h sub">Muted</div>${mutedList.map(([k, id]) => item(k, id, 'mute', 'Muted: its threads are back once you post in one of them. Click to unmute it')).join('')}` : '');
    const yours = mine();
    const said = Object.entries(st.teams).filter(([t]) => yours.has(t))
      .map(([t, f]) => [t, ['tech', 'area', 'org'].flatMap((k) => ids(f[k]).map((id) => nameOf(k, id)))])
      .filter(([, names]) => names.length)
      .map(([t, names]) => `${teamName(t)} follows ${and(names)} in its inbox.`);
    box.querySelector('#followHint').textContent = `${followed.length
      ? 'Their threads are in your personal view, in any channel. Click one to stop.'
      : 'Follow products, topics, customers and people: their threads come into your personal view, in any channel.'}${said.length ? ` ${said.join(' ')}` : ''}`;
    if (!box.dataset.wired) {
      box.dataset.wired = '1';
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-fo-menu]');
        if (!b) return;
        const { kind, id } = b.dataset;
        if (b.dataset.foMenu === 'mute') mute(kind, id, nameOf(kind, id));
        else toggle(kind, id, nameOf(kind, id));
      });
      box.querySelector('#followFind').addEventListener('click', () => suggest());
    }
  }

  // ---- what to follow, suggested --------------------------------------------------------------

  /** The suggestions and the search (ui/followsuggest.js) in `box`, their buttons this one's. */
  function mountSuggest(box, intro = '') {
    return FollowSuggest.mount(box, {
      intro,
      load: async (q) => {
        const res = await cfg.request('GET', `/api/follows/suggest${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        if (!res.ok) throw new Error(res.data?.error || String(res.status));
        return res.data;
      },
    });
  }

  /** Find something to follow, in a dialog. */
  function suggest() {
    document.getElementById('menu')?.hidePopover?.();
    if (!ready() || !globalThis.FollowSuggest) return;
    const holder = document.createElement('div');
    holder.innerHTML = `<dialog class="followsheet" aria-labelledby="followsheet-title"><form method="dialog">
      <div class="top"><h2 id="followsheet-title">Follow what you work on</h2><button class="close" aria-label="Close" title="Close (Esc)"><span class="s2-cross" aria-hidden="true"></span></button></div>
      <div class="fs-body"></div></form></dialog>`;
    const dlg = holder.firstElementChild;
    dlg.addEventListener('close', () => (globalThis.Dialog ? Dialog.remove(dlg) : dlg.remove()));
    // Enter in the search field finds; it does not close the dialog.
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault(); });
    document.body.append(dlg);
    const picker = mountSuggest(dlg.querySelector('.fs-body'), '<p class="fs-lead">Their threads come into your personal view, in any channel. Suggested from the channels you are in and what is talked about most lately.</p>');
    dlg.showModal();
    picker.focus();
  }

  function init(opts = {}) {
    Object.assign(cfg, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
    redraw();
  }

  return {
    init,
    set,
    state: () => st,
    ready,
    follows,
    muted,
    teams,
    name: nameOf,
    button,
    toggle,
    mute,
    menu,
    suggest,
    mountSuggest,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    NOUN,
  };
})();
