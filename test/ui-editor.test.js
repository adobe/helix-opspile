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
import { Text } from '@codemirror/state';
import { frontmatter, summary } from '../src/ui-editor.js';

const doc = (s) => Text.of(s.split('\n'));

describe('the knowledge-base editor', () => {
  it('finds the frontmatter it folds, from the end of the first --- to the end of the last', () => {
    const text = '---\ntype: Playbook\ntitle: x\n---\n\n# x\n';
    assert.deepEqual(frontmatter(doc(text)), { from: 3, to: text.indexOf('\n\n'), lines: 2 });
    assert.deepEqual(frontmatter(doc('---\n---\nbody')), { from: 3, to: 7, lines: 0 });
  });

  it('folds nothing without frontmatter, or with one that is not closed', () => {
    assert.equal(frontmatter(doc('# x\n---\ny\n---\n')), null);
    assert.equal(frontmatter(doc('---\ntype: x\n')), null);
    assert.equal(frontmatter(doc('')), null);
  });

  it('says what the folded frontmatter holds', () => {
    assert.equal(summary('---\ntype: "Playbook"\ntitle: x\n---'), 'type: Playbook · 2 lines');
    assert.equal(summary('---\ntitle: x\n---'), 'frontmatter · 1 line');
  });
});
