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
 * The draft line (ui/inbox.js, `draftLine` and `wireDraftBar`): "View draft" is a click, the
 * same with a mouse and on touch, and a mouse resting on the line opens it too, after a delay;
 * the button then keeps it open (Keep draft open), as View draft does, until Hide draft.
 * Taking the draft into the reply box is a button of its own; the reply box never shows the draft
 * for the pointer (that changed the layout under it, which left the line, hid the draft and came
 * back, over and over); a double click on its text does, as Edit does. Open or closed, the draft
 * is rendered as the message will be, and text selected in it stays: the pointer leaving does not
 * close the line on it. With a part of it selected, Edit and the sends take that part, and
 * sending it uses the draft up.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

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

// The thread's Markdown, as a stub that says what it was given.
const rendered = [];
const md = (src, thread) => {
  rendered.push([src, thread]);
  return `<p>md:${esc(src)}</p>`;
};
const { draftLine } = piece('const viewedDraft', '/** The draft line: who saved', 'draftLine', {
  esc, md, draftBy: () => 'opspile agent', ago: () => '8m', sourcesLine: () => '',
});

const draft = { body: 'Thanks, <b>we</b> are on it.\n\nMore below.', updated_at: '2026-11-05T10:00:00Z' };

describe('draft line', () => {
  it('offers View draft, closed, and shows how the draft starts, rendered, on one line', () => {
    rendered.length = 0;
    const html = draftLine(draft, { editable: true, thread: 'slack:T:C:1' });
    assert.match(html, /<button class="ico view" data-draft="view" aria-label="View draft" title="[^"]+" aria-expanded="false" aria-controls="draft-text"><svg/);
    assert.match(html, /<div class="pv" id="draft-text">/);
    assert.deepEqual(rendered, [[draft.body, 'slack:T:C:1']]);
    assert.ok(html.includes('<div class="tx md bubble line"><p>md:Thanks, &lt;b&gt;we&lt;/b&gt; are on it.'));
  });

  it('closed, keeps a single newline from breaking the line: a line break is a space', () => {
    const soft = { body: 'Hi,\nthanks.\nMore', updated_at: draft.updated_at };
    const br = (src) => `<p>${esc(src).replace(/\n/g, '<br />\n')}</p>`;
    const { draftLine: line } = piece('const viewedDraft', '/** The draft line: who saved', 'draftLine', {
      esc, md: br, draftBy: () => 'opspile agent', ago: () => '8m', sourcesLine: () => '',
    });
    const closed = line(soft, {}).match(/<div class="tx md bubble line">(.*?)<\/div>/s)[1];
    assert.doesNotMatch(closed, /<br/);
    assert.equal(closed, '<p>Hi, \nthanks. \nMore</p>');
    assert.equal(line(soft, { open: true }).match(/<br \/>/g).length, 2);
  });

  it('closed, keeps a code block on the one line: the stylesheet makes its newlines spaces', () => {
    // A message's code block keeps its newlines (`.bubble pre`, white-space: pre-wrap); the
    // closed line's `nowrap` has to reach it, and the code in it, or the line grows a line each.
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.draftbar \.pv \.line :is\(pre, code\) \{ white-space: inherit; \}/);
    assert.match(css, /\.draftbar \.pv \.md\.line \{[^}]*white-space: nowrap/);
  });

  it('says Hide draft once viewed, and shows all of it as the message will be', () => {
    rendered.length = 0;
    const html = draftLine(draft, { open: true, thread: 'slack:T:C:1' });
    assert.match(html, /aria-label="Hide draft"[^>]*aria-expanded="true"/);
    assert.deepEqual(rendered, [[draft.body, 'slack:T:C:1']]);
    assert.ok(html.includes('<div class="tx md bubble"><p>md:Thanks, &lt;b&gt;we&lt;/b&gt; are on it.'));
  });

  it('opened by the pointer, offers to keep it open instead of hiding what it just opened', () => {
    const html = draftLine(draft, { open: true, peek: true });
    assert.match(html, /data-draft="view" aria-label="Keep draft open" title="[^"]+" aria-expanded="true" aria-controls="draft-text" aria-pressed="false"/);
    assert.doesNotMatch(html, /Hide draft/);
  });

  it('keeps View draft even when nothing else may be done', () => {
    const html = draftLine(draft, {});
    assert.match(html, /data-draft="view"/);
    assert.doesNotMatch(html, /data-draft="(edit|me|bot|discard)"/);
    assert.doesNotMatch(html, /class="sends"/);
  });

  it('has its tools as labelled icons, and the sends labelled, as me last', () => {
    const html = draftLine(draft, {
      editable: true, asMe: true, asBot: true, discard: true,
    });
    const tools = html.match(/<span class="tools">(.*?)<\/span>/)[1];
    assert.deepEqual([...tools.matchAll(/data-draft="(\w+)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2]]), [['view', 'View draft'], ['edit', 'Edit'], ['discard', 'Discard']]);
    const sends = html.match(/<span class="sends">(.*)<\/span>/)[1];
    assert.deepEqual([...sends.matchAll(/data-draft="(\w+)"[^>]*><svg.*?<\/svg><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]), [['bot', 'Send as bot'], ['me', 'Send as me']]);
    assert.match(draftLine(draft, { editable: true, own: true }), /data-draft="edit" aria-label="Add to reply"/);
  });

  it('takes the draft in with a button of its own, or a double click, never a click on its text', () => {
    const html = draftLine(draft, { editable: true, asMe: true });
    assert.doesNotMatch(html.match(/<div class="pv"[^>]*>/)[0], /data-draft|title=/);
    assert.equal(html.match(/data-draft="edit"/g).length, 1);
  });

  it('says what Edit and the sends do with a part of the draft selected', () => {
    const html = draftLine(draft, { editable: true, asMe: true, asBot: true });
    const parts = [...html.matchAll(/data-draft="(\w+)"[^>]*data-part="([^"]+)" data-part-title="([^"]+)"/g)];
    assert.deepEqual(parts.map((m) => [m[1], m[2]]), [['edit', 'Edit selection'], ['bot', 'Send selection as bot'], ['me', 'Send selection as me']]);
    assert.ok(parts.slice(1).every((m) => /discard the rest/.test(m[3])));
    assert.match(draftLine(draft, { editable: true, own: true }), /data-part="Add selection to reply"/);
    assert.doesNotMatch(html.match(/data-draft="view"[^>]*>/)[0], /data-part/);
  });

  it('listens to clicks, keys and the pointer resting on it, not to the focus moving', () => {
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
    });
    const types = [];
    wireDraftBar({ addEventListener: (type) => types.push(type) });
    assert.deepEqual(types.sort(), ['click', 'dblclick', 'keydown', 'pointerenter', 'pointerleave']);
  });

  it('edits all of the draft on a double click on its text, where Edit is offered', () => {
    const on = {};
    let edit = true;
    const el = {
      __key: 'k',
      querySelector: (q) => (q === '[data-draft="edit"]:not(:disabled)' && edit ? {} : null),
      addEventListener: (t, f) => { on[t] = f; },
    };
    const adopted = [];
    let cleared = 0;
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
      adoptDraft: (k) => adopted.push(k),
      getSelection: () => ({
        removeAllRanges: () => {
          cleared += 1;
        },
      }),
    });
    wireDraftBar(el);
    const at = (inside) => ({ target: { closest: (q) => (q === '.pv' ? inside.pv : inside.link) } });
    on.dblclick(at({ pv: {} }));
    assert.deepEqual(adopted, ['k']);
    assert.equal(cleared, 1);
    on.dblclick(at({ pv: {}, link: {} }));
    on.dblclick(at({}));
    edit = false;
    on.dblclick(at({ pv: {} }));
    assert.deepEqual(adopted, ['k']);
  });

  it('takes the part of the draft selected into the box or the thread, and all of it without one', () => {
    const on = {};
    const el = {
      __key: 'k',
      querySelector: () => null,
      addEventListener: (t, f) => {
        on[t] = f;
      },
    };
    const calls = [];
    let part = null;
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
      lineDraft: () => draft,
      draftPart: () => part,
      adoptDraft: (k) => calls.push(['all', k]),
      adoptPart: (k, p) => calls.push(['part', k, p.body]),
      sendDraft: (k, bot, p) => calls.push(['send', k, bot, p?.body ?? null]),
      discardDraft: (k) => calls.push(['discard', k]),
    });
    wireDraftBar(el);
    const button = (act) => ({ dataset: { draft: act }, disabled: false });
    const click = (act) => on.click({ target: { closest: () => button(act) } });
    click('edit');
    click('me');
    part = { body: 'we', mentions: [] };
    click('edit');
    click('bot');
    click('discard');
    assert.deepEqual(calls, [
      ['all', 'k'], ['send', 'k', false, null], ['part', 'k', 'we'], ['send', 'k', true, 'we'], ['discard', 'k'],
    ]);
  });

  it('opens on a resting pointer only after a delay, and closes as it leaves', () => {
    const on = {};
    const el = {
      __key: 'k', matches: () => true, querySelector: () => null, addEventListener: (t, f) => { on[t] = f; },
    };
    const timers = [];
    const renders = [];
    const draftOpen = new Set();
    const draftPeek = { key: null, timer: 0 };
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
      setTimeout: (f, ms) => timers.push([f, ms]),
      clearTimeout: () => {},
      getSelection: () => null,
      TOUCH_ONLY: { matches: false },
      state: { open: 'k' },
      draftPeek,
      draftOpen,
      HOVER_DELAY_MS: 300,
      renderDraftBar: (k) => renders.push([k, draftPeek.key]),
    });
    wireDraftBar(el);
    on.pointerenter({ pointerType: 'mouse' });
    assert.deepEqual(timers.map((t) => t[1]), [300]);
    assert.equal(draftPeek.key, null);
    timers[0][0]();
    assert.equal(draftPeek.key, 'k');
    assert.ok(draftOpen.has('k'));
    on.pointerleave();
    assert.equal(draftPeek.key, null);
    assert.ok(!draftOpen.has('k'));
    assert.deepEqual(renders, [['k', 'k'], ['k', null]]);
    // One opened with View draft stays open as the pointer leaves.
    draftOpen.add('k');
    on.pointerleave();
    assert.ok(draftOpen.has('k'));
    on.pointerenter({ pointerType: 'touch' });
    assert.equal(timers.length, 1);
  });

  it('keeps the draft the pointer opened open once its button is clicked, wherever the pointer goes', () => {
    const on = {};
    const button = { dataset: { draft: 'view' }, disabled: false };
    const el = {
      __key: 'k', matches: () => true, querySelector: () => null, addEventListener: (t, f) => { on[t] = f; },
    };
    const draftOpen = new Set(['k']);
    const draftPeek = { key: 'k', timer: 0 };
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
      setTimeout: () => {},
      clearTimeout: () => {},
      getSelection: () => null,
      TOUCH_ONLY: { matches: false },
      state: { open: 'k' },
      draftPeek,
      draftOpen,
      HOVER_DELAY_MS: 300,
      renderDraftBar: () => {},
    });
    wireDraftBar(el);
    on.click({ target: { closest: () => button } });
    assert.equal(draftPeek.key, null);
    assert.ok(draftOpen.has('k'));
    // The pointer leaves for the sidebar: it stays open.
    on.pointerleave();
    assert.ok(draftOpen.has('k'));
    // Clicked again (Hide draft), it closes.
    on.click({ target: { closest: () => button } });
    assert.ok(!draftOpen.has('k'));
  });

  it('stays open as the pointer leaves with some of the draft selected, to copy it', () => {
    const on = {};
    const text = {};
    const el = {
      __key: 'k',
      matches: () => true,
      querySelector: () => null,
      contains: (n) => n === text,
      addEventListener: (t, f) => { on[t] = f; },
    };
    const timers = [];
    const renders = [];
    const draftOpen = new Set();
    const draftPeek = { key: null, timer: 0 };
    let sel = { isCollapsed: true, anchorNode: null, focusNode: null };
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
      setTimeout: (f, ms) => timers.push([f, ms]),
      clearTimeout: () => {},
      getSelection: () => sel,
      TOUCH_ONLY: { matches: false },
      state: { open: 'k' },
      draftPeek,
      draftOpen,
      HOVER_DELAY_MS: 300,
      renderDraftBar: (k) => renders.push([k, draftPeek.key]),
    });
    wireDraftBar(el);
    on.pointerenter({ pointerType: 'mouse' });
    timers[0][0]();
    assert.equal(draftPeek.key, 'k');
    // A drag that selects from the draft's text goes past the line's edge: it stays open, and
    // is no longer the pointer's, so coming back and leaving again leaves it open too.
    sel = { isCollapsed: false, anchorNode: text, focusNode: {} };
    on.pointerleave();
    assert.ok(draftOpen.has('k'));
    assert.equal(draftPeek.key, null);
    sel = { isCollapsed: true, anchorNode: null, focusNode: null };
    on.pointerleave();
    assert.ok(draftOpen.has('k'));
    assert.deepEqual(renders, [['k', 'k']]);
    // A selection elsewhere on the page does not keep it open.
    draftOpen.clear();
    on.pointerenter({ pointerType: 'mouse' });
    timers[1][0]();
    sel = { isCollapsed: false, anchorNode: {}, focusNode: {} };
    on.pointerleave();
    assert.ok(!draftOpen.has('k'));
    // Nor does the resting pointer open a closed line over text selected in it: that would
    // draw the text again, without the selection.
    sel = { isCollapsed: false, anchorNode: {}, focusNode: text };
    on.pointerenter({ pointerType: 'mouse' });
    timers[2][0]();
    assert.ok(!draftOpen.has('k'));
  });

  it('shows what is selected in it: not in the card\'s own fill, the page\'s selection', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    const page = SCRIPTS['spectrum.css'].match(/:where\(\.spectrum\) ::selection \{ background: ([^;]+);/)[1];
    const card = css.match(/\.spectrum \.draftbar \{[^}]*background: ([^;]+);/)[1];
    const sel = css.match(/\.spectrum \.draftbar ::selection \{ background: ([^;]+);/)?.[1];
    assert.equal(page, card);
    assert.ok(sel && sel !== card, 'the draft line needs a ::selection of its own');
  });

  it('sends a part of the draft as the draft, cut down to it: that uses it up', async () => {
    const d = { ...draft, mentions: [{ id: 'u1', name: 'Sam Reyes' }] };
    const sent = [];
    const { sendDraft } = piece('async function sendDraft', '/**\n * Where the selection', 'sendDraft', {
      state: { cache: new Map([['k', { data: { draft: d, thread: { source: 'slack' } } }]]) },
      $: () => null,
      getSelection: () => ({ removeAllRanges: () => {} }),
      sendAsApp: async (k, text, base, { mentions }) => {
        sent.push(['bot', text, base, mentions]);
        return {};
      },
      send: async (k, thread, out) => { sent.push(['me', out.body, out.updated_at, out.mentions]); },
      toast: () => {},
      renderDraftBar: () => {},
      draftFiles: async () => [],
    });
    const part = { body: 'Thanks @Sam Reyes', mentions: d.mentions };
    await sendDraft('k', true, part);
    await sendDraft('k', false, part);
    await sendDraft('k', false);
    assert.deepEqual(sent, [
      ['bot', 'Thanks @Sam Reyes', d.updated_at, d.mentions],
      ['me', 'Thanks @Sam Reyes', d.updated_at, d.mentions],
      ['me', d.body, d.updated_at, d.mentions],
    ]);
  });

  it('sends its pictures with it, where the channel takes them, and nothing where it does not', async () => {
    const shot = { name: 'shot.png', type: 'image/png', size: 9 };
    const d = {
      ...draft,
      files: [{
        id: 'df_1', name: 'shot.png', type: 'image/png', size: 9,
      }],
    };
    const sent = [];
    const refused = [];
    let problem = null;
    const globals = {
      state: {
        cache: new Map([['k', { data: { draft: d, thread: { source: 'slack' } } }]]),
        me: { attach: { slack: { count: 10 }, app: { slack: { count: 10 } } } },
      },
      $: () => null,
      getSelection: () => ({ removeAllRanges: () => {} }),
      sendAsApp: async (k, text, base, { files }) => {
        sent.push(['bot', files.map((f) => f.name)]);
        return {};
      },
      send: async (k, thread, out) => { sent.push(['me', out.attached.map((a) => a.file.name)]); },
      toast: () => {},
      renderDraftBar: () => {},
      draftFiles: async (k, x) => x.files.map(() => shot),
      attachRule: (thread) => globals.state.me.attach[thread.source],
      attachProblem: () => problem,
      attachRefused: (rule, text) => refused.push(text),
      NO_RULE: { count: 0 },
      URL: { createObjectURL: () => 'blob:x' },
    };
    const { sendDraft } = piece('async function sendDraft', '/**\n * Where the selection', 'sendDraft', globals);
    await sendDraft('k', true);
    await sendDraft('k', false);
    problem = 'Up to 0 files per message.';
    await sendDraft('k', false);
    assert.deepEqual(sent, [['bot', ['shot.png']], ['me', ['shot.png']]]);
    assert.deepEqual(refused, ['Nothing was sent: Up to 0 files per message.']);
  });

  it('takes its pictures into the tray once, and a save from the box keeps those still there', async () => {
    const d = {
      ...draft,
      files: [{
        id: 'df_1', name: 'a.png', type: 'image/png', size: 9,
      }, {
        id: 'df_2', name: 'b.png', type: 'image/png', size: 9,
      }],
    };
    const state = { cache: new Map([['k', { data: { draft: d, thread: { source: 'slack' } } }]]), attachments: new Map() };
    const fetched = [];
    const { trayDraftFiles, trayedDraftFiles } = piece('/**\n * The draft\'s pictures into the tray', '/**\n * Sends the draft as it is', 'trayDraftFiles, trayedDraftFiles', {
      state,
      draftFiles: async (k, x) => {
        fetched.push(x.files.map((f) => f.id));
        return x.files.map((f) => ({ name: f.name }));
      },
      addFiles: (k, thread, files) => state.attachments.set(k, [
        ...(state.attachments.get(k) || []), ...files.map((file) => ({ file })),
      ]),
    });
    assert.equal(trayedDraftFiles('k'), undefined);
    await trayDraftFiles('k', d);
    await trayDraftFiles('k', { ...d, updated_at: 'later' });
    assert.deepEqual(fetched, [['df_1', 'df_2']]);
    assert.deepEqual(trayedDraftFiles('k'), ['df_1', 'df_2']);
    // Taken off the tray with ×: the save leaves it off the draft.
    state.attachments.set('k', state.attachments.get('k').slice(1));
    assert.deepEqual(trayedDraftFiles('k'), ['df_2']);
    await trayDraftFiles('k', d);
    assert.deepEqual(fetched, [['df_1', 'df_2'], ['df_1']]);
  });

  it('labels its buttons for the part selected, and back for all of it', () => {
    const span = { textContent: 'Send as me' };
    const attrs = { 'aria-label': null };
    const b = {
      dataset: { part: 'Send selection as me', partTitle: 'Post the part' },
      title: 'Post the draft',
      getAttribute: (n) => attrs[n],
      setAttribute: (n, v) => { attrs[n] = v; },
      querySelector: () => span,
    };
    const classes = new Set();
    const el = {
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      querySelectorAll: () => [b],
    };
    const { markPart } = piece('function markPart', 'document.addEventListener', 'markPart');
    markPart(el, true);
    assert.deepEqual([span.textContent, b.title, classes.has('part')], ['Send selection as me', 'Post the part', true]);
    markPart(el, true);
    markPart(el, false);
    assert.deepEqual([span.textContent, b.title, classes.has('part')], ['Send as me', 'Post the draft', false]);
  });
});
