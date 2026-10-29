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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inboxPage, page } from '../src/page.js';
import { PAGES, SCRIPTS } from './ui.js';

const TAGS = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const NAMED = /^<script( type="module")? src="([a-z-]+\.js)"><\/script>$/;
const served = (name) => (name === 'inbox.html' ? inboxPage : page)(PAGES[name], SCRIPTS);

// The pages' scripts live in ui/*.js, which `npm run lint` checks; a script written into a
// page would be checked by nothing.
describe('page scripts', () => {
  it('are in ui/*.js, named by the pages, not written into them', () => {
    const used = new Set();
    for (const [name, html] of Object.entries(PAGES)) {
      for (const [tag] of html.matchAll(TAGS)) {
        const named = NAMED.exec(tag);
        assert.ok(named, `${name}: ${tag.slice(0, 60)} is not <script src="name.js"></script>`);
        assert.ok(['markdown.js', 'editor.js'].includes(named[2]) || SCRIPTS[named[2]], `${name}: no ui/${named[2]}`);
        used.add(named[2]);
      }
    }
    const scripts = Object.keys(SCRIPTS).filter((f) => f.endsWith('.js'));
    assert.deepEqual(scripts.filter((f) => !used.has(f)), [], 'scripts no page uses');
  });

  it('are inlined where the pages are served', () => {
    for (const name of Object.keys(PAGES)) {
      const html = served(name);
      assert.doesNotMatch(html, /<script[^>]* src=/, name);
      for (const [tag, code] of html.matchAll(TAGS)) {
        assert.ok(code.trim(), `${name}: ${tag.slice(0, 40)} is empty`);
      }
    }
    assert.ok(served('admin.html').includes(`>\n${SCRIPTS['admin.js']}</script>`));
  });

  it('share their stylesheets, ui/*.css, inlined where the pages name them', () => {
    for (const name of Object.keys(PAGES)) {
      assert.match(PAGES[name], /<link rel="stylesheet" href="header.css">/, name);
      const html = served(name);
      assert.doesNotMatch(html, /<link rel="stylesheet"/, name);
      assert.ok(html.includes(`<style>\n${SCRIPTS['header.css']}</style>`), name);
    }
    const html = page('<link rel="stylesheet" href="a.css">', { 'a.css': 'b::after { content: "</style>"; }\n' });
    assert.equal(html, '<style>\nb::after { content: "<\\/style>"; }\n</style>');
    assert.throws(() => page('<link rel="stylesheet" href="nope.css">', SCRIPTS), /nope\.css/);
  });

  it('cannot end the script early, and must exist', () => {
    const html = page('<script src="a.js"></script>', { 'a.js': "const s = '</script><b>';\n" });
    assert.equal(html, "<script>\nconst s = '<\\/script><b>';\n</script>");
    assert.throws(() => page('<script type="module" src="nope.js"></script>', SCRIPTS), /nope\.js/);
  });
});
