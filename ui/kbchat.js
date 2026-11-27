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
 * The knowledge base's sidebar (src/kbchat.js), on a team's or a customer's page (ui/admin.js):
 * whoever may look at its knowledge base talks there to its knowledge-base agent, which reads the
 * knowledge bases and every thread of the inbox, and for the people on its team (`write`)
 * changes that knowledge base and runs commands on its computer, some of which it asks you to run
 * (a card in the conversation, with Run and Deny: POST /api/kb/chat/bash). It is
 * a panel beside the page (`#kbchat`), on every section of it; on a narrow screen it comes over
 * the page. Its tab (`#kbchatTab`) is the inbox's sidebar's: purple, on the right edge of what is
 * picked, halfway down, where the panel comes from; a click opens or closes it, and pulled, the
 * panel comes with it and stays or goes by where it is let go. Where the page is wide enough
 * (ROOM) the panel shows by itself, unless you closed it there (kept in the browser); where it
 * comes over the page it shows only when you open it. The tab wiggles when the agent answers,
 * and has a dot while an answer came with the panel closed. Each conversation is yours alone:
 * **New conversation** starts another,
 * and the earlier ones are a pick away. Over GET and POST /api/kb/chat; while the agent works
 * on an answer the panel asks every few seconds, shows what it is doing, and when it answers,
 * the page shows the knowledge base as it is now (`onAnswer`, Agent.changed). What it says is
 * markdown (ui/markdown.js), rendered as the inbox renders messages; nothing else is HTML.
 *
 * On the Topics page (ui/topics.js) it is the agent of what is picked there (a product's, the
 * team's whose catalog has it), offered only (`init({ auto: false })`): a knowledge base `about`
 * something has `examples` of its own, and `ask` opens it with a question in its box.
 */
globalThis.KbChat = (() => {
  const NAME = 'Knowledge Base Agent';
  const ICON = '/icon-192.png';
  const KEEP = 'opspile.kbchat';
  const POLL_MS = 3000;
  // Past this, the panel stops asking; a message or opening it asks again.
  const WAIT_MS = 15 * 60 * 1000;
  const MAX = 8000;
  // Beside the page from here (ui/spectrum-kbchat.css), over it below; and from ROOM, where what
  // is picked keeps room enough beside it, shown by itself.
  const BESIDE = matchMedia('(min-width: 1100px)');
  const ROOM = matchMedia('(min-width: 1400px)');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  // How far a press moves before it pulls the panel instead of clicking, and how fast a flick is
  // (px/ms): as the inbox's sidebar's tab.
  const PULL_SLOP = 4;
  const PULL_FLICK = 0.4;
  const OPEN_HINT = `Ask the ${NAME}`;
  const CLOSE_HINT = `Close the ${NAME} (Esc)`;
  const CHAT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 11H8l-3.2 2.6V11H3a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 3 2.5z"/></svg>';
  const EXAMPLES = {
    team: [
      'What does the knowledge base say about our most common issues, and what is missing?',
      'Look through this month\'s threads for fixes the knowledge base does not have yet, and add them.',
      'Find duplicate or misfiled concepts, and merge or move them.',
    ],
    org: [
      'What do we know about this customer\'s sites and setup? What is out of date?',
      'Read the customer\'s recent threads and add what the knowledge base is missing.',
      'Check the contacts: who is who, and is anyone missing?',
    ],
  };
  // For who may ask but not have it changed.
  const QUESTIONS = {
    team: [
      'What does the knowledge base say about our most common issues?',
      'Who on this team knows the most about forms?',
      'Which threads of this month does the knowledge base not cover yet?',
    ],
    org: [
      'What do we know about this customer\'s sites and setup?',
      'Who is who on this customer\'s side?',
      'Which of this customer\'s open questions came up recently?',
    ],
  };

  const state = {
    base: null, chat: null, fresh: false, messages: [], bash: [], chats: [], working: null, error: '',
    loading: false, sending: false, turn: 0, timer: 0, since: 0, draft: new Map(), write: false,
    // The values typed into a command's fields, by request and name, kept across redraws.
    values: new Map(), deciding: new Set(),
    // Whether a knowledge base was shown before on this page.
    seen: false,
  };
  // `auto`: whether the panel shows by itself where there is room (Teams and Customers); the
  // Topics page offers it only, on its tab and the panel's Ask (ui/topics.js).
  const host = { onAnswer: () => {}, auto: true };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const touch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
  const md = (src) => (globalThis.Markdown ? Markdown.render(String(src || '')) : `<p>${esc(src)}</p>`);
  const when = (at) => {
    if (!at) return '';
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  // Whether you opened or closed the panel last: `open`, `closed`, or null (never).
  const kept = () => {
    try { return localStorage.getItem(KEEP); } catch { return null; }
  };
  const keep = (shown) => {
    try { localStorage.setItem(KEEP, shown ? 'open' : 'closed'); } catch { /* private mode */ }
  };
  /** Whether the panel shows by itself: beside the page where you left it open, and where the
   * page is wide enough unless you closed it. Never where it comes over the page. */
  const shows = () => host.auto && BESIDE.matches
    && (kept() === 'open' || (ROOM.matches && kept() !== 'closed'));

  let panel = null;
  let tab = null;
  const main = () => document.querySelector('main');
  const isOpen = () => Boolean(panel && !panel.hidden && motion.to === 1);

  // ---- how it comes and goes ---------------------------------------------------------------
  // `p` from 0 (gone) to 1 (open), eased on its way to `to` over --kbchat-motion; the room beside
  // the page and the tray over it follow it (`--kbchat-open`, ui/spectrum-kbchat.css).
  const motion = {
    p: 0, to: 0, raf: 0, pulling: false,
  };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

  function draw() {
    const { p } = motion;
    const m = main();
    if (p > 0 && p < 1) m.style.setProperty('--kbchat-open', p.toFixed(4));
    else m.style.removeProperty('--kbchat-open');
    m.classList.toggle('kbchatting', p > 0);
    m.classList.toggle('kbchat-moving', p > 0 && p < 1);
    panel.hidden = p === 0;
    syncTab();
  }

  /** Towards `to` (0 or 1), over --kbchat-motion if `animate` (not where motion is reduced). */
  function move(to, { animate = true } = {}) {
    cancelAnimationFrame(motion.raf);
    motion.raf = 0;
    motion.to = to;
    const ms = parseFloat(getComputedStyle(main()).getPropertyValue('--kbchat-motion')) || 0;
    const dur = animate && !REDUCED.matches ? ms * Math.abs(to - motion.p) : 0;
    if (!dur) {
      motion.p = to;
      draw();
      return;
    }
    const from = motion.p;
    const t0 = performance.now();
    const step = (now) => {
      const k = clamp01((now - t0) / dur);
      motion.p = from + (to - from) * ease(k);
      draw();
      if (k < 1) motion.raf = requestAnimationFrame(step);
      else motion.raf = 0;
    };
    motion.raf = requestAnimationFrame(step);
  }

  /** The tab, as the panel stands: hidden without a knowledge base. */
  function syncTab() {
    if (!tab) return;
    tab.hidden = !state.base;
    const shown = motion.to === 1;
    tab.title = shown ? CLOSE_HINT : OPEN_HINT;
    tab.setAttribute('aria-label', tab.title);
    tab.setAttribute('aria-expanded', String(shown));
    if (shown) tab.classList.remove('fresh');
  }

  /** The tab wiggles, once (not where motion is reduced, nor while it is pulled). */
  function wiggle() {
    if (!tab || tab.hidden || REDUCED.matches || motion.pulling) return;
    tab.classList.remove('wiggle');
    tab.getBoundingClientRect();
    tab.classList.add('wiggle');
  }

  /** The tab: a click opens the panel or closes it; pulled, the panel comes with it. */
  function wireTab() {
    let pull = null;
    let pulled = false;
    tab.onpointerdown = (e) => {
      if (e.button !== 0 || !state.base) return;
      pull = {
        id: e.pointerId, x: e.clientX, from: motion.p, moved: false, lx: e.clientX, lt: e.timeStamp, v: 0,
      };
      pulled = false;
      tab.setPointerCapture(e.pointerId);
    };
    tab.onpointermove = (e) => {
      if (!pull || e.pointerId !== pull.id) return;
      const dx = e.clientX - pull.x;
      if (!pull.moved) {
        if (Math.abs(dx) < PULL_SLOP) return;
        pull.moved = true;
        pulled = true;
        motion.pulling = true;
        tab.classList.add('pulling');
        cancelAnimationFrame(motion.raf);
        motion.raf = 0;
        if (panel.hidden) render();
      }
      const dt = e.timeStamp - pull.lt;
      if (dt > 0) pull.v = (e.clientX - pull.lx) / dt;
      Object.assign(pull, { lx: e.clientX, lt: e.timeStamp });
      const w = panel.offsetWidth || 360;
      motion.p = clamp01(pull.from - dx / w);
      draw();
    };
    const done = (e) => {
      if (!pull || e.pointerId !== pull.id) return;
      const { moved, v, lt } = pull;
      pull = null;
      motion.pulling = false;
      tab.classList.remove('pulling');
      setTimeout(() => { pulled = false; });
      if (!moved) return;
      // Resting a moment before letting go is no flick.
      const flick = e.timeStamp - lt > 100 ? 0 : v;
      const shown = Math.abs(flick) > PULL_FLICK ? flick < 0 : motion.p > 0.5;
      // Let go where it was (open, pulled part of the way in): it settles back, all of it.
      if (shown && motion.to === 1) move(1);
      else if (shown) open();
      else close();
    };
    tab.onpointerup = done;
    tab.onpointercancel = done;
    tab.onclick = () => {
      if (pulled) return;
      if (isOpen()) close(); else open();
    };
    tab.onanimationend = () => tab.classList.remove('wiggle');
  }

  function mount() {
    if (panel) return;
    panel = document.createElement('aside');
    panel.id = 'kbchat';
    panel.hidden = true;
    panel.setAttribute('aria-label', NAME);
    tab = document.createElement('button');
    tab.id = 'kbchatTab';
    tab.type = 'button';
    tab.hidden = true;
    tab.setAttribute('aria-controls', 'kbchat');
    tab.innerHTML = `${CHAT_ICON}<span class="dot" aria-hidden="true"></span>`;
    wireTab();
    main().append(panel, tab);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen() && panel.contains(document.activeElement)) close();
    });
    // The window grew or shrank: the panel shows where it does by itself now, and does not stay
    // over the page it was beside.
    const room = () => {
      if (!state.base) return;
      if (shows() && !isOpen()) open({ focus: false, keepIt: false });
      else if (!BESIDE.matches && isOpen()) close({ keepIt: false });
    };
    BESIDE.addEventListener('change', room);
    ROOM.addEventListener('change', room);
  }

  // ---- what it shows -----------------------------------------------------------------------

  function message(m) {
    if (m.role === 'agent') {
      return `<div class="kbc-m agent${m.state === 'failed' ? ' failed' : ''}"><img class="kbc-av" src="${ICON}" alt="">
        <div class="col"><div class="who"><b>${NAME}</b> ${esc(when(m.at))}</div><div class="bubble">${md(m.body)}</div></div></div>`;
    }
    return `<div class="kbc-m you${m.pending ? ' pending' : ''}">
      <div class="col"><div class="who">${m.pending ? 'Sending…' : `You ${esc(when(m.at))}`}</div><div class="bubble">${md(m.body)}</div></div></div>`;
  }

  // A command the agent asked you to run (request_bash): what, why, the values it needs, and
  // Run and Deny while it waits; how it ended after.
  const STATUS = {
    pending: 'Waiting for you', running: 'Running…', done: 'Ran', timeout: 'Timed out', failed: 'Failed', denied: 'Denied', expired: 'Expired',
  };
  function command(r) {
    const asks = r.status === 'pending' && state.write;
    const busy = state.deciding.has(r.id);
    const fields = asks ? r.env.map((v) => `<label class="kbc-var"><span><code>$${esc(v.name)}</code>${v.description ? ` ${esc(v.description)}` : ''}</span>
      <input type="password" autocomplete="off" data-var="${esc(r.id)}" data-name="${esc(v.name)}" value="${esc(state.values.get(`${r.id}|${v.name}`) || '')}"></label>`).join('') : '';
    const ended = r.status === 'done' ? `, exit code ${esc(r.exit_code)}` : '';
    const who = r.by && r.by.name && !asks ? ` by ${esc(r.by.name)}` : '';
    return `<div class="kbc-cmd ${esc(r.status)}"><div class="kbc-cmd-head"><b>The agent asks you to run a command</b><span class="kbc-st">${esc(STATUS[r.status] || r.status)}${who}${ended}</span></div>
      <div class="kbc-why">${esc(r.reason)}</div><pre><code>${esc(r.command)}</code></pre>${fields}
      ${asks ? `<div class="kbc-acts"><button type="button" class="kbc-run" data-run="${esc(r.id)}"${busy ? ' disabled' : ''}>Run</button><button type="button" class="kbc-deny" data-deny="${esc(r.id)}"${busy ? ' disabled' : ''}>Deny</button><span class="sub">until ${esc(when(r.deadline))}</span></div>` : ''}</div>`;
  }

  function blank() {
    const b = state.base;
    // What it is asked about on the page (a product on the Topics page), with its own examples.
    const own = b.examples && (state.write ? b.examples.write : b.examples.read);
    const ex = own || (state.write ? EXAMPLES : QUESTIONS)[b.kind] || (state.write ? EXAMPLES : QUESTIONS).team;
    const owners = b.kind === 'team' ? `${esc(b.name || b.repo)}'s members` : 'the customer\'s ops teams';
    return `<div class="kbc-blank"><img class="kbc-av big" src="${ICON}" alt="">
      <p><b>${b.about ? `Ask ${esc(b.name || b.repo)}'s knowledge base about ${esc(b.about)}` : `Ask about ${esc(b.name || b.repo)}'s knowledge base`}${state.write ? ', or tell the agent what to change' : ''}.</b></p>
      <p class="sub">Only you see this conversation.${state.write ? '' : ` Only ${owners} can change this knowledge base.`}</p>
      <div class="kbc-ex">${ex.map((t) => `<button type="button" class="kbc-try" data-try="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`;
  }

  function chatsPick() {
    const list = state.chats.filter((c) => c.chat !== state.chat);
    if (!list.length) return '';
    return `<label class="kbc-earlier"><span>Earlier</span><select id="kbcEarlier" aria-label="Earlier conversations">
      <option value="">${state.chat && !state.fresh ? 'This conversation' : 'New conversation'}</option>
      ${list.map((c) => `<option value="${esc(c.chat)}">${esc(c.first.slice(0, 60) || 'Conversation')} (${esc(when(c.at))})</option>`).join('')}
    </select></label>`;
  }

  function body() {
    if (state.loading && !state.messages.length) return '<div class="kbc-wait">Loading…</div>';
    // The commands between the messages, where they were asked.
    const items = [...state.messages.map((m) => ({ at: m.at || '\uffff', html: message(m) })),
      ...state.bash.map((r) => ({ at: r.created_at, html: command(r) }))];
    const list = items.sort((a, b) => String(a.at).localeCompare(String(b.at))).map((x) => x.html).join('');
    const working = state.working ? `<div class="kbc-m agent working"><img class="kbc-av" src="${ICON}" alt="">
      <div class="col"><div class="who"><b>${NAME}</b></div><div class="bubble"><span class="spin" aria-hidden="true"></span>${esc(state.working)}…</div></div></div>` : '';
    const error = state.error ? `<div class="kbc-err" role="alert">${esc(state.error)}</div>` : '';
    return `${list || working ? `${list}${working}` : blank()}${error}`;
  }

  /** What is typed in the box, kept for the knowledge base the panel shows (`data-repo`). */
  function keepDraft() {
    const typed = panel && panel.querySelector('#kbcText');
    if (typed && typed.dataset.repo) state.draft.set(typed.dataset.repo, typed.value);
  }

  function render({ focus = false } = {}) {
    if (!panel || !state.base) return;
    const b = state.base;
    keepDraft();
    const scroller = panel.querySelector('.kbc-scroll');
    const atEnd = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    panel.innerHTML = `<div class="kbc-head"><img class="kbc-av" src="${ICON}" alt="">
        <div class="kbc-what"><b>${NAME}</b><small>${esc(b.name || b.repo)}${state.write ? '' : ', read only'}</small></div>
        <button type="button" class="kbc-new" id="kbcNew" title="Start a new conversation"${!state.messages.length ? ' disabled' : ''}>New</button>
        <button type="button" class="kbc-close" id="kbcClose" title="Close (Esc)" aria-label="Close the agent"><span class="s2-cross" aria-hidden="true"></span></button></div>
      ${chatsPick()}
      <div class="kbc-scroll"><div class="kbc-body" aria-live="polite">${body()}</div></div>
      <form class="kbc-box" id="kbcForm"><textarea id="kbcText" rows="3" maxlength="${MAX}" aria-label="Ask the ${NAME}"></textarea>
        <div class="kbc-foot"><span class="sub"></span><button type="submit" class="kbc-ask" id="kbcAsk">Ask</button></div></form>`;
    const box = panel.querySelector('#kbcText');
    box.dataset.repo = b.repo;
    box.value = state.draft.get(b.repo) || '';
    const s = panel.querySelector('.kbc-scroll');
    if (atEnd) s.scrollTop = s.scrollHeight;
    wire();
    if (focus) box.focus();
  }

  function wire() {
    panel.querySelector('#kbcClose').onclick = () => close();
    panel.querySelector('#kbcNew').onclick = () => fresh();
    const pick = panel.querySelector('#kbcEarlier');
    if (pick) pick.onchange = () => { if (pick.value) load({ chat: pick.value }); };
    const box = panel.querySelector('#kbcText');
    box.addEventListener('keydown', (e) => {
      // On a phone's keyboard Enter is a new line; Ask asks.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch()) {
        e.preventDefault();
        send();
      }
    });
    panel.querySelector('#kbcForm').onsubmit = (e) => { e.preventDefault(); send(); };
    panel.querySelectorAll('[data-try]').forEach((b) => {
      b.onclick = () => {
        box.value = b.dataset.try;
        box.focus();
      };
    });
    panel.querySelectorAll('[data-var]').forEach((el) => {
      el.oninput = () => state.values.set(`${el.dataset.var}|${el.dataset.name}`, el.value);
    });
    panel.querySelectorAll('[data-run]').forEach((b) => { b.onclick = () => decide(b.dataset.run, true); });
    panel.querySelectorAll('[data-deny]').forEach((b) => { b.onclick = () => decide(b.dataset.deny, false); });
  }

  /** Runs or denies command `id` the agent asked for, with the values typed for it. */
  async function decide(id, run) {
    const b = state.base;
    const r = state.bash.find((x) => x.id === id);
    if (!b || !r || state.deciding.has(id)) return;
    const env = run ? Object.fromEntries(r.env.map((v) => [v.name, state.values.get(`${id}|${v.name}`) || ''])) : undefined;
    state.deciding.add(id);
    state.error = '';
    render();
    let res;
    try {
      const f = await fetch('/api/kb/chat/bash', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: b.repo, chat: state.chat, id, run, ...(env ? { env } : {}),
        }),
      });
      res = { ok: f.ok, body: await f.json().catch(() => ({})) };
    } catch (e) {
      res = { ok: false, body: { error: e.message } };
    }
    state.deciding.delete(id);
    if (state.base !== b) return;
    if (!res.ok) state.error = res.body.error || 'Could not send. Try again.';
    else for (const v of r.env) state.values.delete(`${id}|${v.name}`);
    state.since = Date.now();
    load({ chat: state.chat, quiet: true });
  }

  // ---- talking -----------------------------------------------------------------------------

  const waiting = () => {
    const last = state.messages[state.messages.length - 1];
    return Boolean(last && last.role === 'person' && !last.pending
      && !state.messages.some((m) => m.reply_to === last.id));
  };

  function poll() {
    clearTimeout(state.timer);
    const running = state.bash.some((r) => r.status === 'running');
    // Also while the panel is closed: its tab says when the answer is there.
    if (!state.base || !(waiting() || running) || Date.now() - state.since > WAIT_MS) return;
    state.timer = setTimeout(() => load({ chat: state.chat, quiet: true }), POLL_MS);
  }

  async function load({ chat = null, quiet = false } = {}) {
    const b = state.base;
    if (!b) return;
    const turn = ++state.turn;
    if (!quiet) {
      state.loading = true;
      state.error = '';
      render();
    }
    const q = new URLSearchParams({ repo: b.repo });
    if (chat) q.set('chat', chat);
    let res;
    try {
      const r = await fetch(`/api/kb/chat?${q}`, { credentials: 'same-origin' });
      res = { ok: r.ok, body: await r.json().catch(() => ({})) };
    } catch (e) {
      res = { ok: false, body: { error: e.message } };
    }
    if (turn !== state.turn || state.base !== b) return;
    state.loading = false;
    if (!res.ok) {
      state.error = res.body.error || 'Could not read the conversation.';
      render();
      if (quiet) state.timer = setTimeout(() => load({ chat: state.chat, quiet: true }), POLL_MS * 2);
      return;
    }
    const before = state.messages.filter((m) => m.role === 'agent').length;
    state.error = '';
    state.chat = res.body.chat;
    state.fresh = !res.body.chat;
    state.messages = res.body.messages || [];
    state.bash = res.body.bash || [];
    state.write = Boolean(res.body.write);
    state.chats = res.body.chats || [];
    state.working = res.body.working || (waiting() ? 'Reading your message' : null);
    render();
    const after = state.messages.filter((m) => m.role === 'agent').length;
    if (quiet && after > before) {
      host.onAnswer(b.repo);
      if (!isOpen()) tab.classList.add('fresh');
      wiggle();
    }
    poll();
  }

  async function send() {
    const b = state.base;
    const box = panel && panel.querySelector('#kbcText');
    const text = box ? box.value.trim() : '';
    if (!b || !text || state.sending) return;
    if (waiting()) {
      state.error = 'Wait for the agent to finish answering.';
      render();
      return;
    }
    state.sending = true;
    state.error = '';
    state.turn += 1;
    const pending = {
      id: `pending-${Date.now()}`, role: 'person', body: text, pending: true,
    };
    state.messages = [...state.messages, pending];
    state.draft.set(b.repo, '');
    box.value = '';
    render();
    let res;
    try {
      const r = await fetch('/api/kb/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: b.repo, text, ...(state.fresh || !state.chat ? { fresh: state.fresh } : { chat: state.chat }),
        }),
      });
      res = { ok: r.ok, body: await r.json().catch(() => ({})) };
    } catch (e) {
      res = { ok: false, body: { error: e.message } };
    }
    state.sending = false;
    if (state.base !== b) return;
    state.messages = state.messages.filter((m) => m !== pending);
    if (!res.ok) {
      state.error = res.body.error || 'Could not send. Try again.';
      // Back into the box, unless something was typed meanwhile.
      const now = panel.querySelector('#kbcText');
      if (now && !now.value) now.value = text;
      render({ focus: true });
      return;
    }
    state.chat = res.body.chat;
    state.fresh = false;
    state.messages = [...state.messages, res.body.message];
    state.working = 'Reading your message';
    state.since = Date.now();
    render({ focus: true });
    poll();
  }

  /** A new conversation: the next message starts it. */
  function fresh() {
    clearTimeout(state.timer);
    state.turn += 1;
    if (state.chat && !state.chats.some((c) => c.chat === state.chat) && state.messages.length) {
      state.chats = [{
        chat: state.chat, at: state.messages[state.messages.length - 1].at, first: state.messages[0].body,
      }, ...state.chats];
    }
    state.chat = null;
    state.fresh = true;
    state.messages = [];
    state.bash = [];
    state.working = null;
    state.error = '';
    render({ focus: true });
  }

  // ---- the panel ---------------------------------------------------------------------------

  /**
   * Opens the panel; `animate`, it comes out of the page's edge. Kept, as you opened it, unless it
   * showed by itself (`keepIt: false`).
   */
  function open({ focus = true, animate = true, keepIt = true } = {}) {
    if (!state.base) return;
    if (keepIt) keep(true);
    const was = isOpen();
    panel.hidden = false;
    state.since = Date.now();
    render({ focus });
    if (!was || motion.p !== 1) move(1, { animate });
    load({ chat: state.chat });
  }

  /**
   * Closes the panel. Beside the page that is kept (it does not show by itself again); over the
   * page it is not, as that closes it to get back to the page (`keepIt: false` neither).
   */
  function close({ keepIt = true, animate = true } = {}) {
    if (keepIt && BESIDE.matches) keep(false);
    const focused = panel.contains(document.activeElement);
    move(0, { animate });
    if (state.base && focused) tab.focus();
  }

  /**
   * The knowledge base on the page (`{ repo, kind, slug, name, write }` of GET /api/kb: every one
   * you see), or null where there is none: the tab and the panel go.
   */
  function show(base) {
    mount();
    const b = base && base.repo ? base : null;
    if ((b && b.repo) === (state.base && state.base.repo)) {
      // The same knowledge base, about something else on the page: its examples are that one's.
      if (b && (b.about !== state.base.about || b.examples !== state.base.examples)) {
        state.base = { ...state.base, about: b.about, examples: b.examples };
        if (!panel.hidden && !state.messages.length) render();
      }
      return;
    }
    // What was typed for the knowledge base it showed stays that one's, and its panel goes.
    keepDraft();
    const was = isOpen();
    panel.innerHTML = '';
    clearTimeout(state.timer);
    state.turn += 1;
    Object.assign(state, {
      base: b, chat: null, fresh: false, messages: [], bash: [], chats: [], working: null, error: '', write: Boolean(b && (b.write ?? b.may)),
    });
    tab.classList.remove('fresh', 'wiggle');
    if (!b) {
      move(0, { animate: false });
      return;
    }
    // Open as another one is picked, it stays open; else it shows where it does by itself.
    // It comes out of the edge, but is simply there as the page loads.
    if (was || shows()) open({ focus: false, animate: state.seen, keepIt: false });
    else move(0, { animate: false });
    state.seen = true;
  }

  /** Opens the panel with `text` in its box, to send or change first (the Topics page's asks). */
  function ask(text) {
    if (!state.base) return;
    state.draft.set(state.base.repo, String(text || ''));
    // What the box has now is kept as the draft as the panel is drawn again: it is this, too.
    const box = panel && panel.querySelector('#kbcText');
    if (box) box.value = String(text || '');
    open();
  }

  return {
    /**
     * `onAnswer(repo)`: the agent answered, and may have changed the knowledge base. `auto`
     * false: the panel never shows by itself, only when its tab or `open` opens it.
     */
    init({ onAnswer, auto } = {}) {
      if (onAnswer) host.onAnswer = onAnswer;
      if (auto !== undefined) host.auto = Boolean(auto);
    },
    show,
    open,
    close,
    ask,
  };
})();
