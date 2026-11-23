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
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { inboxPage, page } from '../src/page.js';
import { PORTAL_FILES, portalPage } from '../src/portal/page.js';
import { PAGES } from './ui.js';

// The Workers build their pages when they load (src/pages.js, src/portal/pages.js), from the
// maps of the scripts and stylesheets they import: a file a page names that its map lacks
// and the Worker does not start. npm run ui:dev and test/ui.js read ui/ themselves, so only
// this sees those maps. Here the imports the bundler takes as text (ui/*.html, and `with
// { type: 'text' }`) are the file's text, as they are in the Worker.
const UI = new URL('../ui/', import.meta.url).href;
const imported = {};
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (resolved.url.startsWith(UI) && context.parentURL) {
      const parent = fileURLToPath(context.parentURL);
      (imported[parent] ||= []).push(resolved.url.slice(UI.length));
    }
    return resolved;
  },
  load(url, context, next) {
    if (context.importAttributes?.type === 'text' || (url.startsWith(UI) && url.endsWith('.html'))) {
      const source = `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`;
      return { format: 'module', source, shortCircuit: true };
    }
    return next(url, context);
  },
});

const load = async (path) => {
  try {
    return await import(path);
  } catch (e) {
    assert.fail(`${path} does not load, and neither would its Worker: ${e.message}`);
  }
  return null;
};
const inbox = await load('../src/pages.js');
const portal = await load('../src/portal/pages.js');

const read = (file) => readFileSync(new URL(file, UI), 'utf8');
const pagesOf = (module) => imported[fileURLToPath(new URL(module, import.meta.url))]
  .filter((file) => file.endsWith('.html'));

// markdown.js, editor.js and spectrum-tokens.css are built, not files of ui/.
const BUILT = ['markdown.js', 'editor.js', 'spectrum-tokens.css'];
const NAMES = /<script[^>]* src="([\w.-]+)"|<link rel="stylesheet" href="([\w.-]+)"/g;
const named = (html) => [...html.matchAll(NAMES)].map((m) => m[1] || m[2])
  .filter((file) => !BUILT.includes(file));

const WORKERS = [
  {
    module: '../src/pages.js',
    scripts: inbox.SCRIPTS,
    build: (name, scripts) => (name === 'inbox.html' ? inboxPage : page)(PAGES[name], scripts),
    served: {
      'inbox.html': inbox.INBOX_PAGE,
      'admin.html': inbox.ADMIN_PAGE,
      'cogs.html': inbox.COGS_PAGE,
      'topics.html': inbox.TOPICS_PAGE,
    },
  },
  {
    module: '../src/portal/pages.js',
    scripts: portal.PORTAL_SCRIPTS,
    build: (name, scripts) => portalPage(PAGES[name], scripts),
    served: { 'portal.html': portal.PORTAL_PAGE },
  },
];

describe('the pages the Workers serve', () => {
  it('are every page of ui/, each built by one Worker from the pages it imports', () => {
    const built = WORKERS.flatMap((w) => Object.keys(w.served));
    assert.deepEqual(built.toSorted(), Object.keys(PAGES).toSorted());
    for (const w of WORKERS) {
      assert.deepEqual(pagesOf(w.module).toSorted(), Object.keys(w.served).toSorted(), w.module);
    }
  });

  it('are built, every script and stylesheet inlined', () => {
    for (const w of WORKERS) {
      for (const [name, html] of Object.entries(w.served)) {
        assert.equal(typeof html, 'string', `${w.module}: ${name}`);
        assert.doesNotMatch(html, /<script[^>]* src=|<link rel="stylesheet"/, `${w.module}: ${name}`);
      }
    }
  });

  it('come from maps of exactly the files their pages name, as ui/ has them', () => {
    for (const w of WORKERS) {
      const names = new Set(Object.keys(w.served).flatMap((name) => named(PAGES[name])));
      assert.deepEqual(Object.keys(w.scripts).toSorted(), [...names].toSorted(), `${w.module} lists what its pages name`);
      for (const [file, text] of Object.entries(w.scripts)) {
        assert.equal(text, read(file), `${w.module}: '${file}' is not ui/${file}`);
      }
    }
    assert.deepEqual(PORTAL_FILES.toSorted(), Object.keys(portal.PORTAL_SCRIPTS).toSorted(), 'PORTAL_FILES');
  });

  it('do not build without a file their page names', () => {
    for (const w of WORKERS) {
      for (const name of Object.keys(w.served)) {
        for (const file of named(PAGES[name])) {
          const without = { ...w.scripts };
          delete without[file];
          assert.throws(() => w.build(name, without), new RegExp(`no (script|stylesheet) ${file}`), `${name} without ${file}`);
        }
      }
    }
  });
});
