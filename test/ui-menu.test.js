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
 * The inbox's user menu (ui/inbox.html, its layout in ui/spectrum.css): who you are, then its
 * sections in three columns, side by side on a wide screen and one under the other (as a single
 * column) on a phone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromHtml } from 'hast-util-from-html';
import { PAGES, SCRIPTS } from './ui.js';

const kids = (node) => (node.children || []).filter((c) => c.type === 'element');
const cls = (node) => node.properties?.className || [];
function find(node, test) {
  if (test(node)) {
    return node;
  }
  for (const c of node.children || []) {
    const hit = find(c, test);
    if (hit) {
      return hit;
    }
  }
  return null;
}
const byId = (tree, id) => find(tree, (n) => n.properties?.id === id);
/** What a section is: its id, or what it holds (the keyboard's shortcuts, logging out). */
const what = (s) => s.properties.id
  || (find(s, (n) => cls(n).includes('keys')) ? 'keyboard' : null)
  || (find(s, (n) => n.properties?.id === 'logout') ? 'logout' : '?');

/** The rules of a stylesheet, without comments, and the media queries they are under. */
function rules(css) {
  const out = [];
  const media = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let at = 0;
  let depth = 0;
  const blocks = [];
  for (const m of src.matchAll(/[{}]/g)) {
    if (m[0] === '{') {
      const head = src.slice(at, m.index).trim();
      blocks.push(head);
      depth += 1;
      if (head.startsWith('@media')) {
        media.push(head);
      }
      at = m.index + 1;
    } else {
      const head = blocks.pop();
      depth -= 1;
      if (head.startsWith('@media')) {
        media.pop();
      } else {
        out.push({ selector: head, body: src.slice(at, m.index).trim(), media: [...media] });
      }
      at = m.index + 1;
    }
  }
  assert.equal(depth, 0);
  return out;
}

describe('the user menu', () => {
  const tree = fromHtml(PAGES['inbox.html']);
  const menu = byId(tree, 'menu');

  it('is who you are, then its sections in three columns, in the order Tab goes through them', () => {
    assert.deepEqual(kids(menu).map((n) => cls(n)[0]), ['id', 'cols']);
    const cols = kids(kids(menu)[1]);
    assert.ok(cols.every((c) => cls(c).includes('col')));
    assert.deepEqual(cols.map((c) => kids(c).map((s) => {
      assert.equal(s.tagName, 'section');
      return what(s);
    })), [
      ['asBox', 'expertBox', 'followBox'],
      ['notifyBox', 'tracesBox'],
      ['keyboard', 'logout'],
    ]);
  });

  it('ships the sections hidden that the page shows only to whom they are for', () => {
    for (const id of ['asBox', 'expertBox', 'followBox', 'notifyBox', 'tracesBox']) {
      assert.equal(byId(tree, id).properties.hidden, true, id);
    }
    const always = kids(kids(menu)[1]).at(-1);
    assert.ok(kids(always).every((s) => !s.properties.hidden));
  });

  it('keeps every control in it', () => {
    for (const id of ['as', 'expertView', 'followList', 'notifyMentions', 'notifyThreads', 'notifySound',
      'bells', 'notifyAllow', 'tracesAll', 'tracesChannel', 'keysAll', 'logout']) {
      assert.ok(find(menu, (n) => n.properties?.id === id), id);
    }
  });

  it('puts its columns side by side on a wide screen only: a phone has the single column', () => {
    const css = rules(SCRIPTS['spectrum.css']);
    const layout = css.filter((r) => /\.(cols|col)\b/.test(r.selector) && !r.selector.startsWith('.spectrum'));
    assert.ok(layout.length);
    for (const r of layout) {
      assert.equal(r.media.length, 1, r.selector);
      const [, px] = r.media[0].match(/^@media \(min-width: (\d+)px\)$/) || [];
      assert.ok(Number(px) >= 900, `${r.selector} under ${r.media[0]}`);
    }
    const grid = layout.find((r) => r.selector === '.menu .cols');
    assert.match(grid.body, /display: grid;/);
    assert.match(grid.body, /grid-auto-flow: column;/);
    // A column with nothing in it (viewing as someone) takes no room.
    assert.ok(layout.some((r) => r.selector === '.menu .col:not(:has(> section:not([hidden])))' && /display: none/.test(r.body)));
  });
});
