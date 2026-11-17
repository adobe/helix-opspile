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
 * The notification troubleshooter: what it says (ui/notifyhelp.js, `NotifyHelp`) on each
 * system, in a tab and as the installed app, and how the inbox (ui/inbox.js) sends its test and
 * its welcome, once per device in a tab and once as the app, and never while viewing as someone.
 * The page's own code, in pieces, run in Node with what they need of the page stubbed.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { PAGES, SCRIPTS } from './ui.js';

// eslint-disable-next-line no-new-func
const load = () => new Function('globalThis', `${SCRIPTS['notifyhelp.js']}\nreturn globalThis.NotifyHelp;`)({});
const NotifyHelp = load();

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const none = () => false;
const standalone = (q) => q === '(display-mode: standalone)';

const MAC_TAB = { os: 'mac', browser: 'Google Chrome', app: false };
const MAC_APP = { os: 'mac', browser: 'Google Chrome', app: true };
const ORIGIN = 'https://inbox.example';
const step = (name, where, extra = {}) => NotifyHelp.step(name, {
  where, origin: ORIGIN, ...extra,
});
const rings = (html) => (html.match(/class="nh-ring"/g) || []).length;

describe('NotifyHelp.where', () => {
  it('tells the system, the browser as the system lists it, and a tab from the installed app', () => {
    const chrome = { userAgent: MAC_CHROME, platform: 'MacIntel', userAgentData: { platform: 'macOS', brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }] } };
    assert.deepEqual(NotifyHelp.where(chrome, none), MAC_TAB);
    assert.deepEqual(NotifyHelp.where(chrome, standalone), MAC_APP);
    assert.deepEqual(NotifyHelp.where(chrome, (q) => q === '(display-mode: window-controls-overlay)'), MAC_APP);
    const brave = { ...chrome, userAgentData: { platform: 'macOS', brands: [{ brand: 'Brave' }, { brand: 'Chromium' }] } };
    assert.equal(NotifyHelp.where(brave, none).browser, 'Brave Browser');
    assert.deepEqual(NotifyHelp.where({ userAgent: WIN_EDGE, platform: 'Win32' }, none), { os: 'windows', browser: 'Microsoft Edge', app: false });
    assert.deepEqual(NotifyHelp.where({ userAgent: LINUX_FIREFOX, platform: 'Linux x86_64' }, none), { os: 'other', browser: 'Firefox', app: false });
    assert.deepEqual(NotifyHelp.where({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 }, none), { os: 'mac', browser: 'Safari', app: false });
    // An iPad says it is a Mac, with a touch screen; the Home Screen app is `standalone`.
    assert.deepEqual(NotifyHelp.where({
      userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5, standalone: true,
    }, none), { os: 'ios', browser: 'Safari', app: true });
    assert.deepEqual(NotifyHelp.where({ userAgent: IPHONE, platform: 'iPhone' }, none), { os: 'ios', browser: 'Safari', app: false });
  });

  it('starts at the browser\'s permission', () => {
    assert.equal(NotifyHelp.first('granted'), 'test');
    assert.equal(NotifyHelp.first('default'), 'allow');
    assert.equal(NotifyHelp.first('denied'), 'blocked');
    assert.equal(NotifyHelp.first('unsupported'), 'unsupported');
  });
});

describe('NotifyHelp.step', () => {
  it('asks whether a banner showed, and tells the chime from the banner', () => {
    const sent = step('sent', MAC_TAB, { sound: true });
    assert.equal(sent.title, 'Did you see a banner?');
    assert.match(sent.html, /played its chime/);
    assert.match(sent.html, /Heard the chime, but saw no banner\? Then the inbox did its part, and macOS kept the banner off/);
    for (const act of ['yes', 'no', 'send']) {
      assert.match(sent.html, new RegExp(`data-nh="${act}"`));
    }
    assert.doesNotMatch(step('sent', MAC_TAB, { sound: false }).html, /chime/);
    assert.match(step('sent', { os: 'windows', browser: 'Microsoft Edge', app: false }).html, /bottom right corner/);
  });

  it('walks through System Settings on a Mac: the browser\'s banners, and Focus', () => {
    const { title, html } = step('hidden', MAC_TAB);
    assert.equal(title, 'Show the banners on macOS');
    assert.match(html, /Notification Center/);
    assert.match(html, /href="x-apple\.systempreferences:com\.apple\.preference\.notifications">System Settings → Notifications<\/a>/);
    assert.match(html, /click <b>Google Chrome<\/b> under Application Notifications/);
    assert.match(html, /Turn on <b>Allow notifications<\/b> and <b>Desktop<\/b>/);
    assert.match(html, /<b>Banners<\/b> or <b>Alerts<\/b>/);
    assert.match(html, /System Settings → Focus/);
    assert.match(html, /<b>Allowed Apps<\/b>/);
    assert.match(html, /Click <b>Add…<\/b>, pick <b>Google Chrome<\/b>/);
    // The drawings: the apps, the browser's settings, the menu bar, a Focus, its allowed apps.
    assert.equal((html.match(/<svg class="nh-pic/g) || []).length, 5);
    assert.equal(rings(html), 1 + 2 + 1 + 1 + 1);
    // In a tab, the installed app's entry is not one to click.
    assert.doesNotMatch(html, /Enterprise Support/);
    assert.match(html, /data-nh="send"/);
  });

  it('names the installed app\'s own entry too, as the app', () => {
    const { html } = step('hidden', MAC_APP);
    assert.match(html, /click <b>Enterprise Support<\/b> and <b>Google Chrome<\/b>/);
    assert.match(html, /The installed app has its own entry, <b>Enterprise Support<\/b>/);
    assert.match(html, /pick <b>Enterprise Support<\/b> and <b>Google Chrome<\/b>/);
    // Both are ringed in the list of apps.
    assert.equal(rings(html), 2 + 2 + 1 + 1 + 1);
  });

  it('says it in words elsewhere', () => {
    const win = step('hidden', { os: 'windows', browser: 'Microsoft Edge', app: false });
    assert.equal(win.title, 'Show the banners on Windows');
    assert.match(win.html, /Settings → System → Notifications/);
    assert.match(win.html, /<b>Show notification banners<\/b> on/);
    assert.match(win.html, /<b>Do not disturb<\/b> off/);
    assert.doesNotMatch(win.html, /<svg/);
    assert.match(step('hidden', { os: 'other', browser: 'Firefox', app: false }).html, /allow <b>Firefox<\/b> to show banners/);
    assert.match(step('hidden', { os: 'ios', browser: 'Safari', app: true }).html, /Settings → Notifications → Enterprise Support/);
  });

  it('says how to allow them again, in the browser, and in the installed app', () => {
    const tab = step('blocked', MAC_TAB).html;
    assert.match(tab, /icon at the left of the address bar/);
    assert.match(tab, /move <b>https:\/\/inbox\.example<\/b> to Allowed/);
    assert.match(tab, /data-nh="reload"/);
    assert.match(step('blocked', MAC_APP).html, /click <b>⋮<\/b> in its title bar, then <b>App info<\/b>/);
    assert.match(step('blocked', { os: 'mac', browser: 'Safari', app: false }).html, /Safari → Settings → Websites → Notifications/);
    assert.match(step('blocked', { os: 'other', browser: 'Firefox', app: false }).html, /Send notifications/);
    assert.match(step('allow', MAC_TAB).html, /data-nh="allow"/);
    assert.match(step('unsupported', { os: 'ios', browser: 'Safari', app: false }).html, /Add to Home Screen/);
    assert.doesNotMatch(step('unsupported', MAC_TAB).html, /Home Screen/);
  });

  it('writes what the browser said as text', () => {
    const { html } = step('failed', MAC_TAB, { error: '<img src=x onerror=alert(1)>' });
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
  });

  it('draws with Spectrum 2\'s colors, in the inbox\'s stylesheet, and no one\'s real data', () => {
    const all = [MAC_TAB, MAC_APP].map((w) => step('hidden', w).html).join('');
    assert.doesNotMatch(all, /style=|fill="#|stroke="#|rgb\(/);
    const css = SCRIPTS['spectrum-inbox.css'];
    const classes = new Set([...all.matchAll(/class="(nh-[a-z-]+)/g)].map((m) => m[1]));
    for (const c of classes) {
      assert.ok(css.includes(`.${c}`), `.${c} has no rule`);
    }
    // The apps in the drawings are the system's own, the browser and the installed app.
    const apps = new Set([...all.matchAll(/<text class="nh-strong" x="\d+" y="\d+">([^<]+)<\/text><text class="nh-dim" x="\d+" y="\d+" font-size="9\.5">/g)].map((m) => m[1]));
    assert.deepEqual([...apps].sort(), ['Calendar', 'Enterprise Support', 'Google Chrome', 'Mail', 'Messages', 'Reminders']);
  });

  it('ends every step with what to do next', () => {
    for (const name of ['unsupported', 'allow', 'blocked', 'test', 'sent', 'works', 'hidden', 'failed']) {
      const { title, html } = step(name, MAC_TAB);
      assert.ok(title, name);
      assert.match(html, /<div class="apply">.*<\/div>$/s, name);
      for (const [, act] of html.matchAll(/data-nh="([a-z]+)"/g)) {
        assert.ok(['send', 'yes', 'no', 'allow', 'reload'].includes(act), `${name}: ${act}`);
      }
    }
  });
});

// ------------------------------------------------------------------ the inbox's side
const INBOX = SCRIPTS['inbox.js'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = INBOX.indexOf(from);
  const b = INBOX.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${INBOX.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

/** Just enough of an element. */
function el(props = {}) {
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    attrs: {},
    scrollTop: 0,
    ...props,
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

/** The page around the troubleshooter: its notifications, toasts, storage and dialog. */
function page({
  perm = 'granted', app = false, as = null, settings = { mentions: true, threads: true, bells: [] }, refuse = null, search = '',
} = {}) {
  const world = {
    shown: [], toasts: [], chimes: [], dialogs: [], focused: 0,
  };
  const store = new Map();
  const reg = {
    async showNotification(title, opts) {
      if (refuse) {
        throw new Error(refuse);
      }
      world.shown.push({ title, ...opts });
    },
  };
  function Notification() {
    throw new TypeError('Illegal constructor');
  }
  Notification.permission = perm;
  const dialog = () => {
    const h2 = el();
    const body = el({ querySelector: () => null });
    const dlg = el({
      open: false,
      querySelector: (sel) => (sel === 'h2' ? h2 : body),
      addEventListener() {},
      showModal() { this.open = true; },
    });
    Object.defineProperties(dlg, {
      title: { get: () => h2.textContent },
      html: { get: () => body.innerHTML },
    });
    world.dialogs.push(dlg);
    return dlg;
  };
  const state = { as, settings };
  const fns = piece('/** Where a click on the test (or the welcome) goes', '/**\n * A notification\'s picture', 'TEST_URL, NOTIFY_ASKED, deliverNote, openNotifyHelp, sendTestNote, testSeen, welcomeNote, welcomedIn', {
    state,
    NotifyHelp: { ...NotifyHelp, where: () => ({ ...MAC_TAB, app }) },
    Notification,
    navigator: { serviceWorker: { getRegistration: async () => reg } },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
    },
    location: { origin: ORIGIN, search },
    window: {
      focus: () => {
        world.focused += 1;
      },
    },
    document: {
      querySelector: () => world.dialogs.find((d) => d.open) || null,
      body: { append() {} },
    },
    $: () => null,
    toNode: () => dialog(),
    Dialog: { remove() {} },
    toast: (text, action, opts) => world.toasts.push({ text, action, ...opts }),
    canNotify: () => perm !== 'unsupported',
    allowed: () => perm === 'granted',
    notifying: () => !state.as && perm === 'granted',
    unlockAudio() {},
    playChime: (opts) => world.chimes.push(opts || {}),
    audio: {},
    openFromNote() {},
    askToNotify: async () => false,
  });
  return {
    ...fns, world, store, state,
  };
}

describe('the test notification', () => {
  let p;
  beforeEach(() => {
    p = page();
  });

  it('is shown as the inbox shows them, with the chime even with the sound off, then asks', async () => {
    await p.sendTestNote();
    assert.equal(p.world.shown.length, 1);
    const [note] = p.world.shown;
    assert.equal(note.title, 'Test notification');
    assert.equal(note.tag, 'opspile:test');
    assert.equal(note.renotify, true);
    assert.equal(note.silent, true);
    assert.deepEqual(note.data, { url: '/inbox?notify=seen' });
    assert.deepEqual(p.world.chimes, [{ always: true }]);
    const [dlg] = p.world.dialogs;
    assert.equal(dlg.dataset.step, 'sent');
    assert.equal(dlg.title, 'Did you see a banner?');
    assert.match(dlg.html, /played its chime/);
    // Sending another asks in the same dialog.
    await p.sendTestNote();
    assert.equal(p.world.dialogs.length, 1);
    assert.equal(p.world.shown.length, 2);
  });

  it('says why when the browser did not take it', async () => {
    p = page({ refuse: 'No permission to show notifications' });
    await p.sendTestNote();
    const [dlg] = p.world.dialogs;
    assert.equal(dlg.dataset.step, 'failed');
    assert.match(dlg.html, /did not take it: No permission to show notifications/);
    assert.deepEqual(p.world.chimes, []);
  });

  it('is not sent while the browser does not allow them: the dialog says how', async () => {
    p = page({ perm: 'denied' });
    await p.sendTestNote();
    assert.deepEqual(p.world.shown, []);
    assert.equal(p.world.dialogs[0].dataset.step, 'blocked');
  });

  it('knows a click on it showed it', async () => {
    await p.sendTestNote();
    p.testSeen();
    assert.equal(p.world.dialogs[0].dataset.step, 'works');
    assert.equal(p.world.focused, 1);
    // With no troubleshooter open (a click after it was closed, or in a new window), a toast.
    p.world.dialogs[0].open = false;
    p.testSeen();
    assert.match(p.world.toasts.at(-1).text, /notifications show on this device/);
  });

  it('is not there while viewing as someone else', async () => {
    p = page({ as: 42 });
    await p.sendTestNote();
    assert.equal(p.openNotifyHelp(), null);
    assert.deepEqual(p.world.shown, []);
    assert.deepEqual(p.world.dialogs, []);
  });

  it('opens from the address, /inbox?notify=help, as the page was loaded', () => {
    assert.equal(page({ search: '?notify=help' }).NOTIFY_ASKED, 'help');
    assert.equal(page({ search: '?team=edge' }).NOTIFY_ASKED, null);
  });
});

describe('the welcome notification', () => {
  it('is sent once in a tab and once as the installed app, with a toast that asks', async () => {
    const p = page();
    assert.equal(await p.welcomeNote(), true);
    assert.equal(p.world.shown.length, 1);
    const [note] = p.world.shown;
    assert.equal(note.title, 'Notifications are on');
    assert.equal(note.tag, 'opspile:welcome');
    assert.deepEqual(note.data, { url: '/inbox?notify=seen' });
    const [t] = p.world.toasts;
    assert.match(t.text, /Didn't see it pop up\?/);
    assert.equal(t.action.label, 'Fix it');
    assert.equal(t.stay, true);
    t.action.run();
    assert.equal(p.world.dialogs[0].dataset.step, 'hidden');
    assert.deepEqual(p.welcomedIn(), ['tab']);
    // Not on the next load.
    assert.equal(await p.welcomeNote(), false);
    assert.equal(p.world.shown.length, 1);
    // Just allowed again (it was blocked, or reset): again.
    assert.equal(await p.welcomeNote(true), true);
    assert.equal(p.world.shown.length, 2);
  });

  it('is sent once more as the installed app, which shares the tab\'s storage and permission', async () => {
    const tab = page();
    await tab.welcomeNote();
    const app = page({ app: true });
    app.store.set('opspile.notify.welcomed', tab.store.get('opspile.notify.welcomed'));
    assert.equal(await app.welcomeNote(), true);
    assert.deepEqual(app.welcomedIn(), ['tab', 'app']);
    assert.equal(await app.welcomeNote(), false);
  });

  it('is not sent after a test, nor while nothing notifies, nor viewing as someone else', async () => {
    const tested = page();
    await tested.sendTestNote();
    assert.equal(await tested.welcomeNote(), false);
    const off = page({ settings: { mentions: false, threads: false, bells: [] } });
    assert.equal(await off.welcomeNote(), false);
    assert.equal(await page({ as: 42 }).welcomeNote(), false);
    assert.equal(await page({ perm: 'default' }).welcomeNote(), false);
    assert.equal(await page({ perm: 'denied' }).welcomeNote(true), false);
  });

  it('follows a switch that the browser was just allowed for, once it is saved', async () => {
    const calls = [];
    const settings = { mentions: false, threads: false };
    const Notification = { permission: 'default' };
    const { toggle } = piece('  // Allowed just now: the welcome once the switch', "  $('notifyMentions').onclick", 'toggle', {
      state: { settings },
      canNotify: () => true,
      Notification,
      askToNotify: async (opts) => {
        calls.push(['ask', opts]);
        Notification.permission = 'granted';
        return true;
      },
      saveSettings: async (patch) => {
        Object.assign(settings, patch);
        calls.push(['save', patch]);
        return true;
      },
      welcomeNote: (justAllowed) => calls.push(['welcome', justAllowed, settings.mentions]),
    });
    await toggle('mentions')();
    assert.deepEqual(calls, [['ask', { welcome: false }], ['save', { mentions: true }], ['welcome', true, true]]);
    // Allowed already, or turned off: no welcome.
    calls.length = 0;
    await toggle('threads')();
    await toggle('mentions')();
    assert.deepEqual(calls.filter(([c]) => c === 'welcome'), []);
  });

  it('survives storage it did not write', async () => {
    const p = page();
    p.store.set('opspile.notify.welcomed', '{not json');
    assert.deepEqual(p.welcomedIn(), []);
    assert.equal(await p.welcomeNote(), true);
  });
});

describe('the user menu', () => {
  const html = PAGES['inbox.html'];

  it('has the test and the way to allow them again next to the permission\'s hint', () => {
    const box = html.slice(html.indexOf('<section id="notifyBox"'), html.indexOf('</section>', html.indexOf('<section id="notifyBox"')));
    assert.match(box, /<p class="hint" id="notifyHint"><\/p>\s*<button class="item allow" id="notifyAllow" hidden>Allow notifications in this browser<\/button>\s*<button class="item allow" id="notifyTest" hidden[^>]*>Send a test notification<\/button>\s*<button class="item allow" id="notifyFix" hidden/);
    assert.ok(html.indexOf('<script src="notifyhelp.js">') < html.indexOf('<script type="module" src="inbox.js">'));
  });

  it('shows each for the browser\'s permission, and none of it viewing as someone else', () => {
    const shown = (perm, as = null) => {
      const els = {};
      const $ = (id) => {
        els[id] ||= el({ id });
        return els[id];
      };
      const Notification = { permission: perm };
      const { renderNotify } = piece('/** The notifications section of the user menu. */', 'function wireNotify()', 'renderNotify', {
        $,
        state: { as, settings: { mentions: true, threads: true, bells: [] } },
        canNotify: () => perm !== 'unsupported',
        Notification,
        esc: (s) => s,
        BELL: '',
        bellHref: () => '',
        bellLabel: () => '',
        soundOn: () => true,
      });
      renderNotify();
      return Object.fromEntries(['notifyBox', 'notifyAllow', 'notifyTest', 'notifyFix'].map((id) => [id, !$(id).hidden]).concat([['fix', $('notifyFix').textContent]]));
    };
    assert.deepEqual(shown('granted'), {
      notifyBox: true, notifyAllow: false, notifyTest: true, notifyFix: false, fix: 'How to get them',
    });
    assert.deepEqual(shown('default'), {
      notifyBox: true, notifyAllow: true, notifyTest: false, notifyFix: false, fix: 'How to get them',
    });
    assert.deepEqual(shown('denied'), {
      notifyBox: true, notifyAllow: false, notifyTest: false, notifyFix: true, fix: 'How to allow them again',
    });
    assert.deepEqual(shown('unsupported'), {
      notifyBox: true, notifyAllow: false, notifyTest: false, notifyFix: true, fix: 'How to get them',
    });
    assert.equal(shown('granted', 42).notifyBox, false);
  });
});
