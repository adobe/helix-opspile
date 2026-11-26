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
 * A message's menu (ui/inbox.js, `openMessageMenu`): the ⋮ at the end of its quick reactions,
 * as in Slack, which copies the message's links: on its platform, and in the inbox. An inbox
 * link (`?t=…&m=…`) opens the thread at the message, marked for a moment (markFound, `linked`),
 * also in the installed app (src/pwa.js, ui/app.js's Launch).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MANIFEST } from '../src/pwa.js';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const css = SCRIPTS['spectrum-inbox.css'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}, source = js) {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${source.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const PLATFORM = {
  slack: 'Slack', teams: 'Teams', discord: 'Discord', portal: 'Portal',
};

/** messageHref and messageActions, in the view `team` (none: Personal), at `search`. */
function links({ team = 'ops', search = '' } = {}) {
  return piece('/**\n * The inbox\'s address of message `m`', '/** The ⋮ the menu is open from', 'messageHref, messageActions', {
    state: { team },
    personal: () => !team,
    location: { origin: 'https://inbox.example', pathname: '/inbox', search },
    PLATFORM,
  });
}

describe('a message\'s links', () => {
  const slack = {
    thread: 'slack:T1:C1:100.1', id: '100.2', source: 'slack', permalink: 'https://acme.slack.com/archives/C1/p1002',
  };

  it('copies the message on its platform first, where it has a permalink, then in the inbox', () => {
    const { messageActions } = links();
    assert.deepEqual(messageActions(slack).map((a) => a.label), ['Copy Slack URL', 'Copy Opspile URL']);
    assert.equal(messageActions(slack)[0].url, slack.permalink);
    const teams = { ...slack, source: 'teams', permalink: 'https://teams.microsoft.com/l/message/1' };
    assert.deepEqual(messageActions(teams).map((a) => a.label), ['Copy Teams URL', 'Copy Opspile URL']);
    const discord = { ...slack, source: 'discord', permalink: 'https://discord.com/channels/1/2/3' };
    assert.equal(messageActions(discord)[0].label, 'Copy Discord URL');
    // Without one, the inbox's only.
    assert.deepEqual(messageActions({ ...slack, permalink: null }).map((a) => a.label), ['Copy Opspile URL']);
  });

  it('links the inbox to the message\'s thread at the message, in the view on screen, and no more', () => {
    // The view's filters, a search and whom one views as are the sender's: not in the link.
    const { messageHref } = links({ search: '?team=ops&filters=1&f.customer=acme&q=deploy&as=7&t=x' });
    const href = messageHref(slack);
    const u = new URL(href);
    assert.equal(`${u.origin}${u.pathname}`, 'https://inbox.example/inbox');
    assert.deepEqual([...u.searchParams], [['team', 'ops'], ['t', slack.thread], ['m', slack.id]]);
    // From Personal, the recipient's Personal.
    const own = new URL(links({ team: null }).messageHref(slack));
    assert.deepEqual([...own.searchParams], [['t', slack.thread], ['m', slack.id]]);
  });

  it('names the message\'s own thread, a member of a group, which the Worker always reads', () => {
    const member = { ...slack, thread: 'slack:T1:C1:200.1', id: '200.5' };
    assert.equal(new URL(links().messageHref(member)).searchParams.get('t'), 'slack:T1:C1:200.1');
    // The Worker reads the asked thread's messages also where a group has too many to read.
    assert.match(SCRIPTS['inbox.js'], /if \(state\.jump\?\.key === key\) state\.jump\.key = entryKey;/);
  });
});

/** A menu's item: a button with its text, focus and classes. */
function item(doc, i) {
  const classes = new Set();
  return {
    dataset: { i: String(i) },
    textContent: `item ${i}`,
    classList: { add: (c) => classes.add(c), has: (c) => classes.has(c) },
    focus() { doc.focus(this); },
  };
}

/** closeMessageMenu, copyAction and messageMenuKey, on a menu open with two links. */
function menu({ copy = async () => {} } = {}) {
  const doc = {
    activeElement: null,
    focus(el) { this.activeElement = el; },
  };
  const items = [item(doc, 0), item(doc, 1)];
  const button = {
    attrs: { 'aria-expanded': 'true' },
    setAttribute(k, v) { this.attrs[k] = v; },
    focus() { doc.focus(this); },
  };
  const said = { textContent: '' };
  const el = {
    hidden: false,
    querySelectorAll: () => items,
    querySelector: (sel) => items[Number(/data-i="(\d+)"/.exec(sel)?.[1])] || null,
  };
  const msgMenu = {
    el,
    id: 'slack:T1:C1:100.1|100.2',
    acts: [{ label: 'Copy Slack URL', url: 'https://slack.example/p1' }, { label: 'Copy Opspile URL', url: 'https://inbox.example/inbox?t=a&m=b' }],
    timer: 0,
  };
  const timers = [];
  const toasts = [];
  const copied = [];
  const fns = piece('/** The ⋮ the menu is open from', '/** Opens the menu of the message', 'closeMessageMenu, copyAction, messageMenuKey', {
    msgMenu,
    focusMessage: () => {},
    $: (id) => (id === 'pane' ? { querySelector: () => button } : { 'msg-said': said }[id]),
    CSS: { escape: (s) => s },
    document: doc,
    navigator: {
      clipboard: {
        writeText: async (s) => {
          copied.push(s);
          await copy(s);
        },
      },
    },
    toast: (s) => toasts.push(s),
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
  });
  return {
    ...fns, doc, items, button, said, el, msgMenu, timers, toasts, copied,
  };
}

const key = (k, more = {}) => {
  const e = { key: k, ...more, prevented: false };
  e.preventDefault = () => {
    e.prevented = true;
  };
  e.stopPropagation = () => {};
  return e;
};

describe('a message\'s menu', () => {
  it('copies the link, says so in the item and to a screen reader, then goes, back to its ⋮', async () => {
    const m = menu();
    await m.copyAction(1);
    assert.deepEqual(m.copied, ['https://inbox.example/inbox?t=a&m=b']);
    assert.equal(m.items[1].textContent, 'Copied ✓');
    assert.ok(m.items[1].classList.has('done'));
    assert.equal(m.said.textContent, 'Copied the Opspile URL.');
    // Still open for a moment, then closed, the focus on the ⋮ again.
    assert.equal(m.el.hidden, false);
    m.timers.at(-1)();
    assert.equal(m.el.hidden, true);
    assert.equal(m.msgMenu.id, null);
    assert.equal(m.button.attrs['aria-expanded'], 'false');
    assert.equal(m.doc.activeElement, m.button);
  });

  it('says where the browser would not let it copy', async () => {
    const m = menu({
      copy: async () => {
        throw new Error('denied');
      },
    });
    await m.copyAction(0);
    assert.equal(m.el.hidden, true);
    assert.equal(m.items[0].textContent, 'item 0');
    assert.match(m.toasts[0], /Could not copy the link/);
  });

  it('moves with the arrows, Home and End, and closes with Esc or Tab, back to its ⋮', () => {
    const m = menu();
    m.items[0].focus();
    m.messageMenuKey(key('ArrowDown'));
    assert.equal(m.doc.activeElement, m.items[1]);
    m.messageMenuKey(key('ArrowDown'));
    assert.equal(m.doc.activeElement, m.items[0]);
    m.messageMenuKey(key('ArrowUp'));
    assert.equal(m.doc.activeElement, m.items[1]);
    m.messageMenuKey(key('Home'));
    assert.equal(m.doc.activeElement, m.items[0]);
    m.messageMenuKey(key('End'));
    assert.equal(m.doc.activeElement, m.items[1]);
    // Enter is the item's own (a button's click).
    const enter = key('Enter');
    m.messageMenuKey(enter);
    assert.equal(enter.prevented, false);
    const escape = key('Escape');
    m.messageMenuKey(escape);
    assert.ok(escape.prevented);
    assert.equal(m.el.hidden, true);
    assert.equal(m.doc.activeElement, m.button);
    const n = menu();
    n.items[0].focus();
    n.messageMenuKey(key('Tab'));
    assert.equal(n.el.hidden, true);
    assert.equal(n.doc.activeElement, n.button);
  });

  it('is a menu of menu items under a ⋮ that says it opens one, and m opens it from the message', () => {
    assert.match(js, /el\.setAttribute\('role', 'menu'\);/);
    assert.match(js, /<button type="button" role="menuitem" tabindex="-1" data-i="\$\{i\}">/);
    assert.match(js, /<button class="acts" data-acts="1" aria-haspopup="menu" aria-expanded="false" title="More actions \(m\)" aria-label="More actions">/);
    assert.match(js, /button\.setAttribute\('aria-expanded', 'true'\);/);
    assert.match(js, /if \(\(e\.key === 'm' && !e\.shiftKey\) \|\| e\.key === 'ContextMenu' \|\| \(e\.key === 'F10' && e\.shiftKey\)\)/);
    assert.match(js, /\['Message menu', 'm'\]/);
    // The bar stays while it is open: its ⋮ says so (aria-expanded), which keeps it shown.
    assert.match(css, /\.msg \.quick:has\(\[aria-expanded="true"\]\)/);
  });

  it('looks as the other floating menus do, its items as theirs', () => {
    assert.match(js, /el\.className = 'linkpick msgacts s2-float';/);
    assert.match(css, /\.spectrum :is\(\.mentions li, \.chans li, \.expertlist button, \.linkpick a, \.linkpick button\) \{/);
    assert.match(css, /\.linkpick button \{ display: flex;[^}]*border: 0; background: none;/);
  });
});

/** markFound and remark, on fake messages, at time `now()`. */
function marks() {
  let t = 1000;
  const timers = [];
  const node = (id) => {
    const classes = new Set();
    const props = new Map();
    return {
      dataset: { id },
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      classes,
      props,
      querySelector: () => ({
        style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
      }),
    };
  };
  const fns = piece('/**\n * The message marked for a moment', '/**\n * Keeps message `id`', 'markFound, remark', {
    performance: { now: () => t },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    CSS: { escape: (s) => s },
  });
  return {
    ...fns,
    node,
    timers,
    tick: (ms) => {
      t += ms;
    },
  };
}

describe('a link to a message', () => {
  it('opens the thread the address names, at its message (`m`), from the start', () => {
    assert.match(js, /open: q\.get\('t'\), msg: q\.get\('m'\),/);
    assert.match(js, /if \(initial\.open && initial\.msg\) state\.jump = \{ key: initial\.open, id: `\$\{initial\.open\}\|\$\{initial\.msg\}`, linked: true \};/);
    // Back and Forward, and a notification's or the app's launch, the same way.
    assert.match(js, /else if \(open && msg\) openMessage\(open, msg, \{ linked: true \}\);/);
    assert.match(js, /if \(key && msg\) openMessage\(key, msg, \{ linked: true \}\);/);
    // Once the thread is drawn: scrolled to, marked, kept in view while it settles; or said gone.
    assert.match(js, /if \(found && !again\) markFound\(found, \{ linked: jump\.linked \}\);/);
    assert.match(js, /if \(found && !again && jump\.linked\) holdAt\(scroller, jump\.id\);/);
    assert.match(js, /if \(jump\?\.linked && !found && !live\) toast\(/);
    // Drawn twice as the page opens, in either order: both at the message. The live one keeps
    // the jump for the one that opens it, and a live one drawn after it keeps its place.
    assert.match(js, /if \(!live\) state\.jump = null;/);
    assert.match(js, /const late = !prevScroller && live && !switching && pane\.__key === key/);
    assert.match(js, /if \(late\) scroller\.scrollTop = lateTop;/);
  });

  it('marks the message for a moment, longer than a search\'s, and again where it is drawn anew', () => {
    const m = marks();
    const a = m.node('t|1');
    m.markFound(a, { linked: true });
    assert.ok(a.classes.has('linked'));
    assert.equal(m.timers.at(-1).ms, 3200);
    // Drawn again (a live update) a second later: marked, its fade a second in already.
    m.tick(1000);
    const b = m.node('t|1');
    const root = { querySelector: () => b };
    m.remark(root);
    assert.ok(b.classes.has('linked'));
    assert.equal(b.props.get('animation-delay'), '-1000ms');
    // Then unmarked, both.
    m.timers.at(-1).fn();
    assert.ok(!a.classes.has('linked') && !b.classes.has('linked'));
    m.tick(5000);
    const c = m.node('t|1');
    m.remark({ querySelector: () => c });
    assert.ok(!c.classes.has('linked'));
    // A search's: `found`, as before.
    const d = m.node('t|2');
    m.markFound(d);
    assert.ok(d.classes.has('found') && !d.classes.has('linked'));
    assert.equal(m.timers.at(-1).ms, 2400);
  });

  it('fades the mark out, and with less motion shows it still, then not', () => {
    assert.match(css, /\.msg\.linked \.bubble \{ animation: linked var\(--spectrum-animation-duration-6000\) [^;]+ both; \}/);
    assert.match(css, /@keyframes linked \{\s*from, 40% \{ box-shadow: 0 0 0 var\(--spectrum-border-width-400\) var\(--spectrum-notice-visual-color\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.msg\.linked \.bubble \{ animation: none; box-shadow: [^}]+\}/);
  });
});

describe('links in the installed app', () => {
  it('captures the inbox\'s links, in the window that is open', () => {
    assert.equal(MANIFEST.handle_links, 'preferred');
    assert.deepEqual(MANIFEST.launch_handler, { client_mode: ['focus-existing', 'auto'] });
  });

  it('gives a page the links it can show in place, loads the others, and not the page\'s own', () => {
    const src = SCRIPTS['app.js'];
    const a = src.indexOf('window.Launch = ');
    const b = src.indexOf('\n})();', a) + '\n})();'.length;
    let consumer = null;
    const went = [];
    const window = {
      launchQueue: {
        setConsumer: (fn) => {
          consumer = fn;
        },
      },
    };
    const location = { href: 'https://inbox.example/inbox?t=a&m=1', assign: (u) => went.push(u) };
    // eslint-disable-next-line no-new-func
    const Launch = new Function('window', 'location', `${src.slice(a, b)}\nreturn window.Launch;`)(window, location);
    // The launch that loaded the page: shown already.
    consumer({ targetURL: 'https://inbox.example/inbox?t=a&m=1' });
    assert.deepEqual(went, []);
    // A page that takes none: loaded.
    consumer({ targetURL: 'https://inbox.example/inbox/kb' });
    assert.deepEqual(went, ['https://inbox.example/inbox/kb']);
    // The inbox takes its own.
    const taken = [];
    Launch.take = (u) => {
      taken.push(u);
      return u.includes('?t=');
    };
    consumer({ targetURL: 'https://inbox.example/inbox?t=b&m=2' });
    consumer({ targetURL: 'https://inbox.example/inbox/admin' });
    assert.deepEqual(taken, ['https://inbox.example/inbox?t=b&m=2', 'https://inbox.example/inbox/admin']);
    assert.deepEqual(went, ['https://inbox.example/inbox/kb', 'https://inbox.example/inbox/admin']);
    // The inbox takes the inbox's addresses only (its path), as a notification's click.
    assert.match(js, /if \(u\.origin !== location\.origin \|\| u\.pathname !== location\.pathname\) return false;\s*openFromNote\(u\.href\);/);
  });
});
