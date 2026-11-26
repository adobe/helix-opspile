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
 * A rule's expression in Teams and Customers (ui/admin.js, `breakable`, `describe`): zero-width
 * spaces where it may break (after an alternative, before a group, never inside an escape), and
 * taken out again for whoever copies it, so the clipboard has the expression the rule has.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['admin.js'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
// eslint-disable-next-line no-new-func
const api = new Function('esc', `${js.slice(js.indexOf('function prefixOf'), js.indexOf('/** Puts a rule'))}
  return { breakable, unbroken, describe, ZWSP };`)(esc);
const Z = api.ZWSP;

describe('a rule\'s expression', () => {
  it('breaks after each alternative and before each group', () => {
    assert.equal(api.breakable('^(?:sites|forms)-(.+)$'), `^(?:sites|${Z}forms)-${Z}(.+)$`);
  });

  it('does not break inside an escape, nor twice in one place', () => {
    assert.equal(api.breakable('a\\|b\\(c|(d)'), `a\\|b\\(c|${Z}(d)`);
    assert.equal(api.breakable('(a)'), '(a)');
    assert.equal(api.breakable('^((a))'), '^((a))');
  });

  it('copies as the rule has it', () => {
    const pattern = '^(?:assets\\-essentials|ajo\\-dynamicmedia|sites\\-optimizer)(.+?)-alerts$';
    assert.equal(api.unbroken(api.breakable(pattern)), pattern);
  });

  it('is drawn breakable and copyable, a prefix as it is', () => {
    const html = api.describe({ pattern: '^(a|b)$' });
    assert.match(html, /<code class="pattern" role="button" tabindex="0"/);
    assert.ok(html.includes(`a|${Z}b`));
    assert.equal(api.describe({ pattern: '^aem-' }), 'starts with <code>aem-</code>');
  });
});
