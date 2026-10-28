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
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Linter } from 'eslint';
import browserGlobals from 'globals';

// `npm run lint` only sees .js and .mjs files, not the scripts inside the pages: a name a page
// uses but no longer defines would only show as a ReferenceError in the browser.
const dir = new URL('../ui/', import.meta.url);
const pages = readdirSync(dir).filter((f) => f.endsWith('.html'));

describe('page scripts', () => {
  for (const page of pages) {
    it(`${page} uses no undefined names`, () => {
      const html = readFileSync(new URL(page, dir), 'utf8');
      const problems = [];
      for (const [, module, src] of html.matchAll(/<script( type="module")?>([\s\S]*?)<\/script>/g)) {
        problems.push(...new Linter().verify(src, {
          languageOptions: {
            ecmaVersion: 'latest',
            sourceType: module ? 'module' : 'script',
            // `Markdown` is the bundled renderer, src/ui-markdown.bundle.js, in the script before.
            globals: { ...browserGlobals.browser, Markdown: 'readonly' },
          },
          linterOptions: { reportUnusedDisableDirectives: 'off' },
          rules: { 'no-undef': 'error' },
        }).map((p) => `${p.line}: ${p.message}`));
      }
      assert.deepEqual(problems, []);
    });
  }
});
