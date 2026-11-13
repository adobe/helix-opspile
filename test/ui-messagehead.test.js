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
 * A message's header (ui/inbox.js, `message`): who and when, each with its own hover, and the
 * quick reactions, which are the bubble's.
 *
 * - The time is the time of day: the day is in the day's divider, which stays on top of the
 *   thread. Only the thread's latest message says its day too ("Yesterday at 11:43 AM",
 *   "Nov 10 at 11:43 AM"): a date in every header was too much. Pointing at any shows the
 *   whole date.
 * - The quick reactions show for the pointer on the bubble, not on the message: over the header
 *   they hid the name (whose hover is the profile card) and the time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const css = SCRIPTS['spectrum-inbox.css'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// The page formats for the browser's language; here, for U.S. English wherever the tests run.
function DateTimeFormat(_, opts) {
  return new Intl.DateTimeFormat('en-US', opts);
}
const dates = () => piece('const formatter = ', 'const PLATFORM = ', 'timeLabel, timeTag, dayLabel, nearDay, clock', {
  esc, Intl: { DateTimeFormat },
});

// Local times, as the page reads them: a Friday morning, and messages before it.
const NOW = new Date(2026, 10, 13, 9, 30);
const at = (...ymd) => new Date(...ymd).toISOString();

describe('message time', () => {
  const { timeLabel, dayLabel, nearDay } = dates();

  it('with its day, is the time alone today and says the day before that, as Slack does', () => {
    assert.equal(timeLabel(at(2026, 10, 13, 8, 5), NOW), '8:05 AM');
    assert.equal(timeLabel(at(2026, 10, 13, 0, 0), NOW), '12:00 AM');
    assert.equal(timeLabel(at(2026, 10, 12, 23, 59), NOW), 'Yesterday at 11:59 PM');
    assert.equal(timeLabel(at(2026, 10, 12, 11, 43), NOW), 'Yesterday at 11:43 AM');
    assert.equal(timeLabel(at(2026, 10, 10, 11, 43), NOW), 'Nov 10 at 11:43 AM');
    assert.equal(timeLabel(at(2026, 0, 2, 16, 0), NOW), 'Jan 2 at 4:00 PM');
  });

  it('says the year of another year', () => {
    assert.equal(timeLabel(at(2025, 10, 10, 11, 43), NOW), 'Nov 10, 2025 at 11:43 AM');
    // Early in January, the days before New Year are of last year.
    assert.equal(timeLabel(at(2025, 11, 30, 18, 0), new Date(2026, 0, 2, 9, 0)), 'Dec 30, 2025 at 6:00 PM');
    assert.equal(timeLabel(at(2025, 11, 31, 18, 0), new Date(2026, 0, 1, 9, 0)), 'Yesterday at 6:00 PM');
  });

  it('names yesterday by the calendar, not as 24 hours ago', () => {
    // Just after midnight, 23:59 was a moment ago and is yesterday's; so is yesterday's 00:00.
    const night = new Date(2026, 10, 13, 0, 10);
    assert.equal(nearDay(new Date(2026, 10, 12, 23, 59), night), 'Yesterday');
    assert.equal(nearDay(new Date(2026, 10, 12, 0, 0), night), 'Yesterday');
    assert.equal(nearDay(new Date(2026, 10, 11, 23, 59), night), '');
    assert.equal(nearDay(new Date(2026, 10, 13, 0, 0), night), 'Today');
    // The first of a month: the day before is the last of the month before.
    assert.equal(nearDay(new Date(2026, 9, 31, 12, 0), new Date(2026, 10, 1, 8, 0)), 'Yesterday');
  });

  it('agrees with the day\'s divider, which says the year of another year too', () => {
    assert.equal(dayLabel(at(2026, 10, 13, 8, 5), NOW), 'Today');
    assert.equal(dayLabel(at(2026, 10, 12, 11, 43), NOW), 'Yesterday');
    assert.equal(dayLabel(at(2026, 10, 10, 11, 43), NOW), 'Tuesday, November 10');
    assert.equal(dayLabel(at(2025, 10, 10, 11, 43), NOW), 'Monday, November 10, 2025');
    // The same day, seen from the next year: its label is not the one kept for this year.
    assert.equal(dayLabel(at(2026, 10, 10, 11, 43), new Date(2027, 0, 5)), 'Tuesday, November 10, 2026');
  });

  it('is a time element: the time of day, and the whole date for the pointer', () => {
    const { timeTag, clock } = dates();
    const iso = at(2026, 10, 10, 11, 43, 7);
    const [, datetime, title, text] = timeTag(iso).match(/^<time datetime="([^"]+)" title="([^"]+)">([^<]+)<\/time>$/);
    assert.equal(datetime, iso);
    // Weekday, date, time to the second, time zone.
    assert.match(title, /^Tuesday, November 10, 2026 at 11:43:07 AM \S+$/);
    // No day in it: that is the divider's.
    assert.equal(text, '11:43 AM');
    assert.equal(text, clock(iso));
  });

  it('says its day too where asked to (the latest message), with the same whole date', () => {
    const { timeTag, timeLabel: label } = dates();
    const iso = at(2025, 10, 10, 11, 43, 7);
    const [, title, text] = timeTag(iso, true).match(/^<time datetime="[^"]+" title="([^"]+)">([^<]+)<\/time>$/);
    assert.equal(text, label(iso));
    assert.match(text, /^Nov 10, 2025 at 11:43 AM$/);
    assert.match(title, /^Monday, November 10, 2025 at 11:43:07 AM \S+$/);
    // Today's latest message is the time alone, as every other.
    const now = new Date();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toISOString();
    assert.match(timeTag(noon, true), />12:00 PM<\/time>$/);
  });

  it('does not throw on a date it cannot read', () => {
    const { timeTag } = dates();
    assert.equal(timeLabel('nonsense', NOW), 'Invalid Date');
    assert.match(timeTag('nonsense'), /^<time datetime="nonsense" title="Invalid Date">Invalid Date<\/time>$/);
    assert.match(timeTag('nonsense', true), />Invalid Date<\/time>$/);
  });
});

/** `message` and what it asks of the page: you may react, and edit your own. */
function page({ readonly = false } = {}) {
  const state = {
    profiles: new Map(), editing: null, data: { me: { readonly } }, me: { name: 'Dana Ops' },
  };
  const emoji = (n) => `:${n}:`;
  return piece('/** Whether `m` goes on from `prev`', '// ---------------------------------------------------------------- the thread agent', 'message, continues', {
    esc,
    state,
    emoji,
    md: (body) => `<p>${esc(body)}</p>`,
    dayLabel: (iso) => iso.slice(0, 10),
    timeTag: (iso, dated) => `<time datetime="${iso}" title="whole">${dated ? 'day and time' : 'time'}</time>`,
    profileKey: (key, { name }) => key || `local:${name}`,
    avatar: (name) => `<span class="av">${esc(name[0])}</span>`,
    favicon: (d) => `/favicon/${d}`,
    canReact: (m) => !readonly && !m.pending && m.author?.kind !== 'system',
    canEdit: (m) => !readonly && Boolean(m.editable),
    emojiChip: emoji,
    QUICK: ['white_check_mark', 'eyes'],
    SIGNAL_HINT: {},
    pendingFiles: () => '',
    sendState: () => '',
  });
}

const msg = (over = {}) => ({
  thread: 'slack:T:C:1', id: '2', at: '2026-11-12T10:43:00.000Z', body: 'On it.', source: 'slack', author: { kind: 'person', name: 'Sam Reyes', org: 'acme.example' }, ...over,
});

describe('message header', () => {
  it('has the name, with its profile card, and the time, with its date, in the header', () => {
    const html = page().message(msg({ authorKey: 'slack:U1' }), null, false);
    const [, who] = html.match(/<div class="who">(.*?)<\/div>/);
    assert.equal(who, '<b data-p="slack:U1" role="button" tabindex="0">Sam Reyes</b> · <time datetime="2026-11-12T10:43:00.000Z" title="whole">time</time>');
  });

  it('says the day in the header of the thread\'s latest message only', () => {
    const { message } = page();
    assert.match(message(msg(), null, false, false, true), /<div class="who">.*?title="whole">day and time<\/time><\/div>/);
    assert.match(message(msg(), null, false, true), /<div class="who">.*?title="whole">time<\/time><\/div>/);
    // The thread marks one message so, when its feed is built: the first of the last run of
    // one author's messages, which is the last with a header. No other call asks for the day.
    assert.match(js, /if \(m\.author\?\.kind !== 'system' && !continues\(prev, m\)\) headed = last;/);
    assert.match(js, /if \(headed\) headed\.item\.html = message\(headed\.m, headed\.prev, false, Boolean\(headed\.followed\), true\);/);
    assert.equal(js.match(/timeTag\([^()]*, (dated|true)\)/g).length, 1);
  });

  it('keeps the quick reactions out of the name and the time: beside them, in the header line', () => {
    const html = page().message(msg(), null, false);
    // The header line holds the header, then the reactions' place in it; the bubble follows.
    assert.match(html, /<div class="col"><div class="head"><div class="who">.*?<\/div><div class="quick-at"><div class="quick" role="toolbar" aria-label="React, as you">.*?<\/div><\/div><\/div>\s*<div class="bubble">/);
    assert.equal(html.match(/class="quick"/g).length, 1);
    assert.match(html, /<button data-pick="eyes" aria-pressed="false"[^>]*>:eyes:<\/button>/);
    assert.match(html, /<button class="more" data-picker="1" aria-haspopup="true" aria-expanded="false"/);
    // Nothing of them is in the header's text or in the bubble.
    assert.doesNotMatch(html.match(/<div class="who">(.*?)<\/div>/)[1], /quick|data-pick/);
    assert.doesNotMatch(html.match(/<div class="bubble">(.*?)<\/div>/)[1], /quick|data-pick/);
  });

  it('has the pen with them on your own message, and no bar where there is nothing to do', () => {
    const own = page().message(msg({ mine: true, editable: 'user', author: { kind: 'person', name: 'Dana Ops', staff: true } }), null, false);
    assert.match(own, /<div class="quick-at"><div class="quick" role="toolbar" aria-label="React, as you"><button class="edit" data-edit="1"/);
    const looking = page({ readonly: true }).message(msg(), null, false);
    assert.doesNotMatch(looking, /quick/);
    assert.match(looking, /<div class="col"><div class="head"><div class="who">.*?<\/div><\/div>\s*<div class="bubble">/);
  });

  it('keeps the header line of a message that goes on from the one before, for its reactions', () => {
    const { message, continues } = page();
    const first = msg();
    const next = msg({ id: '3', at: '2026-11-12T10:44:00.000Z', body: 'Looking.' });
    assert.ok(continues(first, next));
    const html = message(next, first, false);
    assert.match(html, /^<div class="msg\s[^"]*\bcont\b/);
    assert.match(html, /<div class="head"><div class="who">.*?<\/div><div class="quick-at">/);
  });

  it('gives system lines, the line between a group\'s posts and the sidebar the same time', () => {
    const html = page().message(msg({ author: { kind: 'system' }, body: 'Sam joined.' }), null, false);
    assert.match(html, /^<div class="sys " data-id="[^"]+"><p>Sam joined\.<\/p> · <time datetime="2026-11-12T10:43:00\.000Z" title="whole">time<\/time><\/div>$/);
    assert.match(js, /<div class="post"><span>new post · \$\{timeTag\(m\.at\)\}<\/span><\/div>/);
    // The sidebar's messages too.
    assert.equal(js.match(/<div class="who"><b>[^<]*<\/b> · \$\{(?:m\.pending \? 'sending…' : )?timeTag\(m\.at\)\}<\/div>/g).length, 2);
  });
});

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [...plain.matchAll(/(?:^|[}\n])\s*([^{}@]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.split(',').map((s) => s.trim()).includes(selector));
  assert.ok(found.length, `no rule for ${selector}`);
  return found.map(([, , body]) => body.trim()).join(' ');
}

describe('message header styles', () => {
  it('shows the quick reactions for the pointer on the bubble, not on the message', () => {
    assert.match(rule('.msg:has(.bubble:hover) .quick'), /visibility: visible;/);
    // Not the message (its header is the name's and the time's), nor its column or header line.
    assert.doesNotMatch(css, /\.msg:hover[^{]*\.quick/);
    assert.doesNotMatch(css, /\.(col|head|who):hover[^{]*\.quick/);
    // Hidden otherwise, which also keeps them from the pointer and the keyboard.
    assert.match(rule('.msg .quick'), /visibility: hidden;/);
  });

  it('keeps them while the pointer is on them, focus is in them, or their picker is open', () => {
    for (const selector of ['.msg .quick:hover', '.msg .quick:focus-within', '.msg .quick:has([aria-expanded="true"])']) {
      assert.match(rule(selector), /visibility: visible; transition-delay: var\(--spectrum-animation-duration-0\);/, selector);
    }
  });

  it('shows them after a rest on the bubble, and gives the pointer time to reach them', () => {
    // Hiding waits (the transition's delay), longer than showing does.
    assert.match(rule('.msg .quick'), /transition: visibility var\(--spectrum-animation-duration-0\) linear var\(--spectrum-animation-duration-1000\);/);
    assert.match(rule('.msg:has(.bubble:hover) .quick'), /transition-delay: var\(--spectrum-animation-duration-600\);/);
  });

  it('lays them out in the header line, where they wrap above the header for lack of room', () => {
    // As wide as the feed beside the avatar, whatever the bubble's width: the feed is measured.
    assert.match(rule('.feed'), /container: feed \/ inline-size;/);
    assert.match(rule('.msg'), /--msg-line: calc\(100cqw - /);
    const head = rule('.msg .head');
    assert.match(head, /display: flex; flex-wrap: wrap-reverse; align-items: flex-start;/);
    // It takes none of the column's width: the bubble says how wide the message is.
    assert.match(head, /width: var\(--msg-line\); margin-right: calc\(-1 \* var\(--msg-line\)\);/);
    assert.match(rule('.msg.adobe .head'), /flex-direction: row-reverse; margin-right: 0; margin-left: calc\(-1 \* var\(--msg-line\)\);/);
    // Their place has their width and no height: wrapped or not, the message is as tall.
    assert.match(rule('.msg .quick-at'), /flex: none; display: flex; align-items: flex-end; height: 0;/);
    assert.doesNotMatch(head, /(^|[^-])gap:/);
    // In the flow of that place, not laid over the header as they were.
    assert.doesNotMatch(rule('.msg .quick'), /position: absolute/);
  });

  it('says the time can be pointed at, as the name can', () => {
    assert.match(rule('.feed time[title]:hover'), /text-decoration: underline dotted;/);
    assert.match(rule('.msg .who b[data-p]:hover'), /text-decoration: underline dotted;/);
  });

  it('keeps the day on top while its messages scroll by, under the header on a phone', () => {
    const day = rule('.day');
    assert.match(day, /position: sticky; top: 0; z-index: 2;/);
    // Opaque, so the day before is not seen behind it.
    assert.match(day, /background: var\(--pane\);/);
    // Under the quick reactions (3) and the picker (4).
    assert.match(rule('.msg .quick'), /z-index: 3;/);
    assert.match(rule('.picker'), /z-index: 4;/);
    const phone = css.slice(css.indexOf('@media (max-width: 699px) {'));
    assert.match(phone, /#pane > \.ph ~ \.scroller \{ padding-top: var\(--ph-h, 0px\); \}\s*(\/\*[\s\S]*?\*\/\s*)?\.day \{ top: calc\(-1 \* var\(--ph-off, 0px\)\); \}/);
  });
});
