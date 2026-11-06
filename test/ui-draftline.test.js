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
 * same with a mouse and on touch, and a mouse resting on the line opens it too, after a delay.
 * Taking the draft into the reply box is a button of its own; the reply box never shows the draft
 * for the pointer (that changed the layout under it, which left the line, hid the draft and came
 * back, over and over). Open or closed, the draft is rendered as the message will be.
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

  it('says Hide draft once viewed, and shows all of it as the message will be', () => {
    rendered.length = 0;
    const html = draftLine(draft, { open: true, thread: 'slack:T:C:1' });
    assert.match(html, /aria-label="Hide draft"[^>]*aria-expanded="true"/);
    assert.deepEqual(rendered, [[draft.body, 'slack:T:C:1']]);
    assert.ok(html.includes('<div class="tx md bubble"><p>md:Thanks, &lt;b&gt;we&lt;/b&gt; are on it.'));
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

  it('takes the draft in with a button of its own, never by clicking its text', () => {
    const html = draftLine(draft, { editable: true, asMe: true });
    assert.doesNotMatch(html.match(/<div class="pv"[^>]*>/)[0], /data-draft|title=/);
    assert.equal(html.match(/data-draft="edit"/g).length, 1);
  });

  it('listens to clicks, keys and the pointer resting on it, not to the focus moving', () => {
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
    });
    const types = [];
    wireDraftBar({ addEventListener: (type) => types.push(type) });
    assert.deepEqual(types.sort(), ['click', 'keydown', 'pointerenter', 'pointerleave']);
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
});
