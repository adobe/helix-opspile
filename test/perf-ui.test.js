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
 * scripts/perf-ui.mjs drives the inbox through the hooks in scripts/perf-ui-hooks.mjs. It is
 * run by hand, so nothing else notices when the page stops writing one of them: this does.
 * Each id, class, attribute, role and tag in the script's selectors must still be written by
 * the inbox page (ui/inbox.html and the scripts it runs), and the values it picks must exist:
 * the filters by id, the teams in the preview's fake data.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PAGES, SCRIPTS } from './ui.js';
import {
  BANNER, FACETS, OTHER_TEAM, SELECTORS, TEAM, VIEW_URL,
} from '../scripts/perf-ui-hooks.mjs';

const script = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
const inbox = SCRIPTS['inbox.js'];
const page = [PAGES['inbox.html'], inbox, SCRIPTS['header.js'], SCRIPTS['app.js']].join('\n');
const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** The ids, classes, attributes ([name] or [name="value"]) and tag names of a selector. */
function parts(selector) {
  const plain = selector.replace(/"[^"]*"/g, (q) => q.replace(/[#.]/g, '_'));
  return {
    ids: [...plain.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...plain.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    attrs: [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((m) => ({ name: m[1], value: m[2] })),
    tags: [...plain.matchAll(/(?:^|[\s>(])([a-z][a-z0-9]*)(?=[\s[.#:>)]|$)/g)].map((m) => m[1]),
  };
}

const writes = {
  id: (id) => new RegExp(`id="${quote(id)}"|\\.id = '${quote(id)}'`),
  class: (c) => new RegExp(`class(Name)?\\s*=\\s*["'\`][^"'\`]*(?<![\\w-])${quote(c)}(?![\\w-])|classList\\.add\\('${quote(c)}'`),
  attr: (name) => {
    if (name === 'inert') {
      return /\.inert = true/;
    }
    const data = name.startsWith('data-') ? `|dataset\\.${camel(name.slice(5))}\\b` : '';
    return new RegExp(`(?<![\\w-])${quote(name)}(?=[="\\s>])${data}`);
  },
  tag: (t) => new RegExp(`<${quote(t)}[\\s>]`),
};

/** What the page has to write for `selector`: [pattern, what is missing] each. */
function wanted(selector) {
  const {
    ids, classes, attrs, tags,
  } = parts(selector);
  return [
    ...ids.map((id) => [writes.id(id), `no element with id ${id}`]),
    ...classes.map((c) => [writes.class(c), `no element with class ${c}`]),
    ...tags.map((t) => [writes.tag(t), `no <${t}>`]),
    ...attrs.map(({ name }) => [writes.attr(name), `no element with ${name}`]),
    ...attrs.filter(({ name }) => name === 'role')
      .map(({ value }) => [new RegExp(`role="${quote(value)}"`), `no role ${value}`]),
  ];
}

const matchAll = (text, checks) => {
  for (const [pattern, missing] of checks) {
    assert.match(text, pattern, missing);
  }
};

describe('scripts/perf-ui.mjs finds what it means to', () => {
  for (const selector of SELECTORS) {
    it(selector, () => {
      const checks = wanted(selector);
      assert.ok(checks.length, 'nothing to look for');
      matchAll(page, checks);
    });
  }

  it('the filters it picks', () => {
    matchAll(inbox, FACETS.map((id) => [new RegExp(`\\{ id: '${quote(id)}'`), `no filter ${id}`]));
  });

  it("the preview's teams it switches between", () => {
    matchAll(script('dev-ui-fixtures.mjs'), [TEAM, OTHER_TEAM]
      .map((slug) => [new RegExp(`slug: '${quote(slug)}'`), `no team ${slug}`]));
  });

  it('what a view fetches', () => {
    assert.ok(inbox.includes(VIEW_URL('')), VIEW_URL(''));
    assert.ok(inbox.includes(VIEW_URL(TEAM).replace(TEAM, '')), VIEW_URL(TEAM));
  });

  it("which thread a message is of: its data-id is '<thread>|<message>'", () => {
    assert.match(inbox, /const id = `\$\{m\.thread\}\|\$\{m\.id\}`;[\s\S]{0,4000}data-id="\$\{esc\(id\)\}"/);
  });

  it("the preview's banner and simulated messages", () => {
    const dev = script('dev-ui.mjs');
    assert.match(dev, writes.id(BANNER.slice(1)));
    assert.match(dev, /url\.pathname === '\/__dev\/simulate'/);
  });
});
