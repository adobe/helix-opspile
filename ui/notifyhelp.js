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
 * What the notification troubleshooter says, as the global `NotifyHelp`: ui/inbox.js opens it
 * from the user menu ("Send a test notification"), from the toast after the first
 * notification on a device, and at /inbox?notify=help, and moves it from step to step.
 *
 * A page sees only the browser's permission (Notification.permission). Whether the system
 * shows the banner it cannot see: on a Mac, Chrome says "granted" while System Settings keeps
 * its banners off, or a Focus sends them straight to Notification Center. So the troubleshooter
 * sends a test notification with the chime, asks whether a banner showed, and if not, walks
 * through the system's settings, with drawings of them (made-up apps, no one's real list) that
 * ring where to click. The drawings are SVG in Spectrum 2's colors (ui/spectrum-inbox.css,
 * `.nh-pic`), so they follow the page's light or dark scheme.
 */
globalThis.NotifyHelp = (() => {
  /** The installed app's name, as the manifest gives it (src/pwa.js) and macOS lists it. */
  const APP = 'Enterprise Support';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  /**
   * Where the page runs: `os` (mac, windows, ios, android, other), `browser` as the system
   * lists it in its notification settings, and `app`: the installed app, not a tab.
   */
  function where(nav = globalThis.navigator, media = (q) => globalThis.matchMedia?.(q).matches) {
    const ua = nav?.userAgent || '';
    const platform = nav?.userAgentData?.platform || nav?.platform || '';
    const brands = (nav?.userAgentData?.brands || []).map((b) => b.brand);
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform) && nav?.maxTouchPoints > 1);
    const os = ios ? 'ios'
      : /Android/.test(ua) ? 'android'
        : /mac/i.test(platform) || /Mac OS X/.test(ua) ? 'mac'
          : /^win/i.test(platform) || /Windows/.test(ua) ? 'windows' : 'other';
    const browser = brands.includes('Microsoft Edge') || /Edg\//.test(ua) ? 'Microsoft Edge'
      : brands.includes('Brave') ? 'Brave Browser'
        : brands.includes('Google Chrome') || /Chrome\//.test(ua) ? 'Google Chrome'
          : /Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari' : 'your browser';
    const app = nav?.standalone === true
      || ['standalone', 'window-controls-overlay', 'minimal-ui'].some((m) => Boolean(media(`(display-mode: ${m})`)));
    return { os, browser, app };
  }
  const chromium = (w) => ['Google Chrome', 'Microsoft Edge', 'Brave Browser'].includes(w.browser);
  const osName = (w) => ({ mac: 'macOS', windows: 'Windows', ios: 'iOS', android: 'Android' }[w.os] || 'your system');
  /** The apps whose notifications the system lists: the installed app has its own entry. */
  const sources = (w) => (w.app ? [APP, w.browser] : [w.browser]);

  // ------------------------------------------------------------------ the drawings
  // A System Settings window, 480 wide: the sidebar (`sel` picked), and the pane to its right,
  // from x = PANE. `.nh-ring` marks where to click.
  const W = 480;
  const PANE = 166;
  const RIGHT = W - 16;
  const SIDEBAR = [['Wi-Fi', 'blue'], ['Bluetooth', 'blue'], ['Network', 'blue'], null,
    ['General', 'gray'], ['Notifications', 'red'], ['Sound', 'magenta'], ['Focus', 'indigo'],
    ['Screen Time', 'indigo']];
  const ring = (x, y, w, h) => `<rect class="nh-ring" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" stroke-width="2.5"/>`;
  const toggle = (x, y, on = true) => `<rect class="nh-tog${on ? ' on' : ''}" x="${x}" y="${y}" width="26" height="15" rx="7.5"/><circle class="nh-knob" cx="${on ? x + 18.5 : x + 7.5}" cy="${y + 7.5}" r="6"/>`;
  const check = (x, y) => `<rect class="nh-tog on" x="${x}" y="${y}" width="14" height="14" rx="3.5"/><path class="nh-tick" d="M${x + 3.5} ${y + 7.2}l2.6 2.6 4.6-5.2" stroke-width="1.8"/>`;
  const icon = (x, y, kind, s = 22) => `<rect class="nh-ico ${kind}" x="${x}" y="${y}" width="${s}" height="${s}" rx="${s / 4.4}"/>`;
  /** A group of rows, as a pane's rounded box: `rows` are drawn by `draw(row, y)`, `h` high each. */
  function group(y, rows, h, draw) {
    const lines = rows.slice(1).map((_, i) => `<line class="nh-sep" x1="${PANE + 10}" x2="${RIGHT - 10}" y1="${y + (i + 1) * h}" y2="${y + (i + 1) * h}"/>`).join('');
    return `<rect class="nh-box" x="${PANE}" y="${y}" width="${RIGHT - PANE}" height="${rows.length * h}" rx="8"/>${lines}${rows.map((r, i) => draw(r, y + i * h)).join('')}`;
  }
  function frame(sel, title, pane, height, label) {
    // As tall as the pane, and the sidebar.
    const h = Math.max(height, 276);
    let y = 70;
    const side = SIDEBAR.map((item) => {
      if (!item) { y += 8; return ''; }
      const [name, hue] = item;
      const row = `${name === sel ? `<rect class="nh-sel" x="9" y="${y - 14}" width="132" height="21" rx="6"/>` : ''}<rect class="nh-ico ${hue}" x="18" y="${y - 10}" width="13" height="13" rx="3.5"/><text x="38" y="${y}"${name === sel ? ' class="nh-strong"' : ''}>${name}</text>`;
      y += 23;
      return row;
    }).join('');
    return `<svg class="nh-pic" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}" font-size="11">`
      + `<rect class="nh-win" x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="12"/>`
      + `<path class="nh-side" d="M12.5 .5H150V${h - 0.5}H12.5A12 12 0 0 1 .5 ${h - 12.5}V12.5A12 12 0 0 1 12.5 .5z"/>`
      + '<circle class="nh-tl r" cx="18" cy="17" r="5"/><circle class="nh-tl y" cx="34" cy="17" r="5"/><circle class="nh-tl g" cx="50" cy="17" r="5"/>'
      + `<rect class="nh-field" x="10" y="32" width="130" height="19" rx="9.5"/><text class="nh-dim" x="22" y="45">Search</text>${side}`
      + `<text class="nh-title" x="${PANE}" y="22" font-size="13">${esc(title)}</text>${pane}</svg>`;
  }

  /** System Settings → Notifications: the list of apps, `ringed` the ones to click. */
  function appsPicture(w) {
    const ringed = sources(w);
    const names = [...new Set(['Calendar', 'Mail', 'Messages', w.app ? APP : 'Reminders', w.browser])].sort((a, b) => a.localeCompare(b));
    const H = 36;
    const top = 70;
    const rows = group(top, names, H, (name, y) => {
      const on = ringed.includes(name);
      return `${icon(PANE + 10, y + 7, on ? (name === APP ? 'red' : 'blue') : 'gray')}<text class="nh-strong" x="${PANE + 42}" y="${y + 16}">${esc(name)}</text>`
        + `<text class="nh-dim" x="${PANE + 42}" y="${y + 29}" font-size="9.5">${on ? 'Badges, Sounds' : 'Badges, Sounds, Desktop'}</text><text class="nh-dim" x="${RIGHT - 16}" y="${y + 22}">›</text>`
        + `${on ? ring(PANE + 3, y + 3, RIGHT - PANE - 6, H - 6) : ''}`;
    });
    return frame(
      'Notifications',
      'Notifications',
      `<text class="nh-strong" x="${PANE}" y="58">Application Notifications</text>${rows}`,
      top + names.length * H + 20,
      `System Settings, Notifications: the list of apps, with ${ringed.join(' and ')} marked`,
    );
  }

  /** An app's notification settings: Allow notifications and Desktop ringed. */
  function stylePicture(w, name = w.browser) {
    const H = 30;
    const a = 40;
    const b = a + H + 14;
    const rowsB = [['Desktop', 'check'], ['Alert style', 'pick'], ['Notification Center', 'check'], ['Lock Screen', 'check']];
    const c = b + rowsB.length * H + 14;
    const pane = group(a, ['Allow notifications'], H, (t, y) => `${icon(PANE + 10, y + 6, name === APP ? 'red' : 'blue', 18)}<text class="nh-strong" x="${PANE + 36}" y="${y + 19}">${t}</text>${toggle(RIGHT - 38, y + 8)}`)
      + ring(PANE + 3, a + 3, RIGHT - PANE - 6, H - 6)
      + group(b, rowsB, H, ([t, kind], y) => (kind === 'pick'
        ? `<text x="${PANE + 28}" y="${y + 19}">${t}</text><text x="${RIGHT - 24}" y="${y + 19}" text-anchor="end">Temporary</text><path class="nh-glyph" d="M${RIGHT - 18} ${y + 12.5}l3-3 3 3M${RIGHT - 18} ${y + 17.5}l3 3 3-3" stroke-width="1.3"/>`
        : `<text x="${PANE + 12}" y="${y + 19}">${t}</text>${check(RIGHT - 26, y + 8)}`))
      + ring(PANE + 3, b + 3, RIGHT - PANE - 6, H - 6)
      + group(c, ['Badge application icon', 'Play sound for notification'], H, (t, y) => `<text x="${PANE + 12}" y="${y + 19}">${t}</text>${toggle(RIGHT - 38, y + 8)}`);
    return frame('Notifications', `‹  ${name}`, pane, c + 2 * H + 20, `${name}'s notification settings, with Allow notifications and Desktop marked`);
  }

  /** The menu bar, a Focus on: its moon ringed. */
  function menuBarPicture() {
    return `<svg class="nh-pic bar" viewBox="0 0 ${W} 34" role="img" aria-label="The menu bar, with the Focus icon marked" font-size="11">`
      + `<rect class="nh-bar" x="0.5" y="0.5" width="${W - 1}" height="33" rx="8"/>`
      + '<text class="nh-strong" x="16" y="21">Finder</text><text x="64" y="21">File</text><text x="94" y="21">Edit</text><text x="124" y="21">View</text>'
      + '<rect class="nh-glyph" x="300" y="11" width="20" height="11" rx="2.5" stroke-width="1.2"/><path class="nh-glyph" d="M334 21a7 7 0 0 1 12 0M337 18a4 4 0 0 1 6 0" stroke-width="1.4"/>'
      + '<path class="nh-moon" d="M371 9.5a6.5 6.5 0 1 0 6.8 9.3a5.4 5.4 0 0 1-6.8-9.3z"/>'
      + `${ring(359, 4, 26, 26)}<text x="${W - 16}" y="21" text-anchor="end">Wed 4 Nov  14:02</text></svg>`;
  }

  /** System Settings → Focus → a Focus: Allowed Apps ringed. */
  function focusPicture() {
    const tile = (x, label, on) => `<rect class="nh-box" x="${x}" y="96" width="140" height="62" rx="8"/>${icon(x + 59, 106, on ? 'indigo' : 'gray', 22)}<text x="${x + 70}" y="146" text-anchor="middle">${label}</text>${on ? ring(x - 3, 93, 146, 68) : ''}`;
    const pane = `${group(40, ['Do Not Disturb'], 32, (t, y) => `<path class="nh-moon" d="M${PANE + 19} ${y + 9}a7 7 0 1 0 7.3 10a5.8 5.8 0 0 1-7.3-10z"/><text class="nh-strong" x="${PANE + 36}" y="${y + 20}">${t}</text>${toggle(RIGHT - 38, y + 9)}`)
    }<text class="nh-strong" x="${PANE}" y="88">Allowed Notifications</text>${tile(PANE, 'Allowed People', false)}${tile(PANE + 158, 'Allowed Apps', true)}`;
    return frame('Focus', '‹  Do Not Disturb', pane, 180, 'System Settings, Focus, Do Not Disturb: Allowed Apps marked');
  }

  /** The Allowed Apps sheet: the browser (and the app) added, Add ringed. */
  function allowedPicture(w) {
    const names = ['Calendar', ...sources(w)];
    const H = 30;
    const list = names.map((n, i) => `${i ? `<line class="nh-sep" x1="96" x2="384" y1="${66 + i * H}" y2="${66 + i * H}"/>` : ''}${icon(104, 72 + i * H, n === 'Calendar' ? 'gray' : (n === APP ? 'red' : 'blue'), 18)}<text x="130" y="${85 + i * H}">${esc(n)}</text>`).join('');
    const bottom = 66 + names.length * H + 14;
    return `<svg class="nh-pic" viewBox="0 0 ${W} ${bottom + 46}" role="img" aria-label="The Allowed Apps sheet: Add marked" font-size="11">`
      + `<rect class="nh-win" x="70.5" y="0.5" width="339" height="${bottom + 45}" rx="12"/>`
      + '<text class="nh-strong" x="96" y="30">Allowed Apps</text><text class="nh-dim" x="96" y="50">Allow notifications from</text>'
      + `<rect class="nh-box" x="88" y="66" width="304" height="${names.length * H}" rx="8"/>${list}`
      + `<rect class="nh-btn" x="96" y="${bottom}" width="64" height="24" rx="12"/><text x="128" y="${bottom + 16}" text-anchor="middle">Add…</text>${ring(92, bottom - 4, 72, 32)}`
      + `<rect class="nh-btn on" x="324" y="${bottom}" width="60" height="24" rx="12"/><text class="nh-on" x="354" y="${bottom + 16}" text-anchor="middle">Done</text></svg>`;
  }

  // ------------------------------------------------------------------ the steps
  const fig = (pic, caption) => `<figure class="nh-fig">${pic}<figcaption>${caption}</figcaption></figure>`;
  const both = (names) => names.map((n) => `<b>${esc(n)}</b>`).join(' and ');

  /** How to show the banners the system hides, on this system: HTML. */
  function bannerSteps(w) {
    const names = sources(w);
    if (w.os === 'mac') {
      const own = w.app ? `<p>The installed app has its own entry, <b>${esc(APP)}</b>: set it as ${esc(w.browser)}.</p>` : '';
      return `<p>First, click the clock in the menu bar: if the test is in Notification Center, it got to your Mac, and macOS only kept its banner off. Two settings do that.</p>
<ol class="nh-steps">
<li><h3>Let ${esc(w.browser)} show banners</h3>
<p>Open <a href="x-apple.systempreferences:com.apple.preference.notifications">System Settings → Notifications</a>, and click ${both(names)} under Application Notifications.</p>${own}
${fig(appsPicture(w), 'If its line does not say <b>Desktop</b>, macOS shows no banners for it.')}
${fig(stylePicture(w), 'Turn on <b>Allow notifications</b> and <b>Desktop</b>. On macOS 14 and earlier: pick <b>Banners</b> or <b>Alerts</b> as the alert style, not None.')}</li>
<li><h3>Let it through Focus</h3>
<p>A Focus (Do Not Disturb, Work, Sleep…) sends every banner it does not allow straight to Notification Center, without a sound. A moon, or another Focus icon, in the menu bar means one is on.</p>
${fig(menuBarPicture(), 'Click it to turn the Focus off, or keep it and let the inbox through:')}
${fig(focusPicture(), 'In <b>System Settings → Focus</b>, click the Focus, then <b>Allowed Apps</b>.')}
${fig(allowedPicture(w), `Click <b>Add…</b>, pick ${both(names)}, and click <b>Done</b>. Do it for each Focus you use, also one an app turns on for you.`)}</li>
</ol>`;
    }
    if (w.os === 'windows') {
      return `<ol class="nh-steps">
<li><h3>Let ${esc(w.browser)} show banners</h3><p>Open <b>Settings → System → Notifications</b>. Turn <b>Notifications</b> on, then turn on ${both(names)} in the list, and click ${names.length > 1 ? 'each' : 'it'}: <b>Show notification banners</b> on.</p></li>
<li><h3>Turn off Do not disturb</h3><p>On the same page, turn <b>Do not disturb</b> off. To keep it, add ${both(names)} under <b>Set priority notifications → Add apps</b>. A Focus session turns Do not disturb on too.</p></li>
</ol>`;
    }
    if (w.os === 'android') {
      return `<p>Open <b>Settings → Notifications → App notifications</b>, pick ${both(names)}, and allow its notifications, with <b>Pop on screen</b> on. Do not disturb keeps them off the screen too.</p>`;
    }
    if (w.os === 'ios') {
      return `<p>Open <b>Settings → Notifications → ${esc(APP)}</b>, turn on <b>Allow Notifications</b> and <b>Banners</b>. A Focus keeps them off the screen unless it allows the app.</p>`;
    }
    return `<p>Check that ${osName(w)}'s notification settings allow ${both(names)} to show banners, and that Do Not Disturb is off.</p>`;
  }

  /** How to allow notifications again, once this browser blocks them for the inbox: HTML. */
  function blockedSteps(w, origin) {
    if (w.app && chromium(w)) {
      return `<p>In the app's window, click <b>⋮</b> in its title bar, then <b>App info</b>, and turn on <b>Notifications</b>. Then reload the inbox.</p>
<p>Or in ${esc(w.browser)}: <b>Settings → Privacy and security → Site settings → Notifications</b>, and move <b>${esc(origin)}</b> to Allowed.</p>`;
    }
    if (chromium(w)) {
      return `<p>Click the icon at the left of the address bar (site settings), set <b>Notifications</b> to <b>Allow</b>, and reload the inbox.</p>
<p>Or: <b>Settings → Privacy and security → Site settings → Notifications</b>, and move <b>${esc(origin)}</b> to Allowed.</p>`;
    }
    if (w.browser === 'Firefox') {
      return '<p>Click the icon at the left of the address bar, clear the blocked <b>Send notifications</b> permission (✕), reload the inbox, and allow them when it asks.</p>';
    }
    if (w.browser === 'Safari') {
      return `<p>In <b>Safari → Settings → Websites → Notifications</b>, set <b>${esc(origin)}</b> to <b>Allow</b>, and reload the inbox.</p>`;
    }
    return `<p>Allow notifications for <b>${esc(origin)}</b> in this browser's site settings, and reload the inbox.</p>`;
  }

  const button = (act, label, primary = false) => `<button type="button" data-nh="${act}"${primary ? ' class="send"' : ''}>${label}</button>`;
  const done = '<button value="done">Done</button>';

  /**
   * A step of the troubleshooter: `{ title, html }`. `ctx`: `where` (see `where`), `origin`,
   * `sound` (the chime played with the test), `error` (why the test did not go out).
   * - `unsupported`, `allow` (not asked yet) and `blocked`: the browser's permission.
   * - `test`: allowed; send one. `sent`: sent; did a banner show? `works` and `hidden`: the answer.
   * - `failed`: the browser did not take the test.
   */
  function step(name, ctx) {
    const w = ctx.where;
    const corner = w.os === 'windows' ? 'bottom right' : 'top right';
    const steps = {
      unsupported: () => ({
        title: 'This browser shows no notifications',
        html: w.os === 'ios' && !w.app
          ? `<p>On iPhone and iPad, only the inbox on the Home Screen can: in Safari, tap <b>Share → Add to Home Screen</b>, then open <b>${esc(APP)}</b> from there and allow notifications.</p><div class="apply">${done}</div>`
          : `<p>Open the inbox in a current Chrome, Edge, Firefox or Safari to get them.</p><div class="apply">${done}</div>`,
      }),
      allow: () => ({
        title: 'Allow notifications',
        html: `<p>This browser has not been allowed to show the inbox's notifications yet. It asks when you click below: pick <b>Allow</b>.</p><div class="apply">${done}${button('allow', 'Allow notifications', true)}</div>`,
      }),
      blocked: () => ({
        title: 'Notifications are blocked',
        html: `<p>This browser blocks the inbox's notifications.</p>${blockedSteps(w, ctx.origin)}<div class="apply">${done}${button('reload', 'Reload the inbox', true)}</div>`,
      }),
      test: () => ({
        title: 'Test notifications',
        html: `<p>The browser allows them. Send yourself a test: a notification, and the chime the inbox plays with each one, so you can tell whether the inbox tried from whether ${osName(w)} showed it.</p><div class="apply">${done}${button('send', 'Send a test notification', true)}</div>`,
      }),
      sent: () => ({
        title: 'Did you see a banner?',
        html: `<p>The inbox just sent a test notification${ctx.sound ? ' and played its chime' : ''}. A banner shows in the ${corner} corner of the screen for a few seconds.</p>${ctx.sound ? `<p class="nh-note">Heard the chime, but saw no banner? Then the inbox did its part, and ${osName(w)} kept the banner off.</p>` : ''}<div class="apply">${button('send', 'Send another')}${button('no', 'No banner')}${button('yes', 'Yes, I saw it', true)}</div>`,
      }),
      works: () => ({
        title: 'Notifications work here',
        html: `<p>You get them while the inbox is open, ${w.app ? 'as this app or in a tab' : 'in a tab or as the installed app'}, also in the background. The menu's Notifications section picks which ones.</p><div class="apply">${done}</div>`,
      }),
      hidden: () => ({
        title: `Show the banners on ${osName(w)}`,
        html: `${bannerSteps(w)}<div class="apply">${done}${button('send', 'Send another test', true)}</div>`,
      }),
      failed: () => ({
        title: 'The test did not go out',
        html: `<p>The browser did not take it${ctx.error ? `: ${esc(ctx.error)}` : ''}.</p>${blockedSteps(w, ctx.origin)}<div class="apply">${done}${button('reload', 'Reload the inbox', true)}</div>`,
      }),
    };
    return (steps[name] || steps.test)();
  }

  /** The first step for the browser's permission (`Notification.permission`, or `unsupported`). */
  const first = (perm) => ({ unsupported: 'unsupported', default: 'allow', denied: 'blocked' }[perm] || 'test');

  return {
    APP, where, step, first, bannerSteps, blockedSteps,
  };
})();
