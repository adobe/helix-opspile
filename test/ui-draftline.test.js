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
 * same with a mouse and on touch, and taking the draft into the reply box is a button of its
 * own. Nothing on the line follows the pointer: a draft shown on hover changed the layout under
 * the pointer, which left the line, hid the draft and came back, over and over.
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
  it('offers View draft, closed, and shows how the draft starts', () => {
    const html = draftLine(draft, { editable: true });
    assert.match(html, /<button class="ico view" data-draft="view" aria-label="View draft" title="[^"]+" aria-expanded="false" aria-controls="draft-text"><svg/);
    assert.match(html, /<div class="pv" id="draft-text">/);
    assert.ok(html.includes('<span class="tx">Thanks, &lt;b&gt;we&lt;/b&gt; are on it.'));
    assert.doesNotMatch(html, /class="tx md/);
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

  it('listens to clicks and keys, not to the pointer resting on it or the focus moving', () => {
    const { wireDraftBar } = piece('function wireDraftBar', '/** Takes the draft into', 'wireDraftBar', {
      wireSources: () => {},
    });
    const types = [];
    wireDraftBar({ addEventListener: (type) => types.push(type) });
    assert.deepEqual(types.sort(), ['click', 'keydown']);
  });
});
