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
 * The Markdown of a part of a draft, from what was selected of it as the page shows it
 * (src/mdpick.js, `Markdown.pick`): the part of the source, its markup kept where the selection
 * takes all of what the markup marks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { align, pickSource } from '../src/mdpick.js';
import { pick, render } from '../src/ui-markdown.js';

const DRAFT = 'Thanks @Sam Reyes, we can reproduce the 503s on /en/* and /de/*.\n\n'
  + 'Could you send us the `x-request-id` of one failing request? Purging is described '
  + '[in the docs](https://docs.example.com/purge), or at https://docs.example.com/cdn.\n\n'
  + '**What we know so far:**\n'
  + '- the 503s started with the **14:00 cache flush**\n'
  + '- only `/en/*` and `/de/*` are affected\n\n'
  + 'We will post here :wave:';

// The text of the draft as the page shows it: its rendering, without tags.
const shown = (src) => render(src).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
const TEXT = shown(DRAFT);

/** The Markdown of the part of the draft's text from `from` up to the end of `to`. */
function picked(from, to = from) {
  const start = TEXT.indexOf(from);
  assert.ok(start >= 0, from);
  const end = TEXT.indexOf(to, start) + to.length;
  return pick(DRAFT, TEXT, start, end);
}

describe('mdpick', () => {
  it('aligns two texts by their longest common subsequence', () => {
    assert.deepEqual([...align('ac', 'abc')], [0, 2]);
    assert.deepEqual([...align('x', 'abc')], [-1]);
    assert.deepEqual([...align('', 'abc')], []);
    assert.equal(align('abc', 'xyz', 2), null);
  });

  it('keeps the markup inside a selection', () => {
    assert.equal(picked('Could you', 'request?'), 'Could you send us the `x-request-id` of one failing request?');
    assert.equal(
      picked('Thanks', 'request?'),
      'Thanks @Sam Reyes, we can reproduce the 503s on /en/* and /de/*.\n\nCould you send us the `x-request-id` of one failing request?',
    );
  });

  it('takes the markup at its edges when the selection has all it marks', () => {
    assert.equal(picked('x-request-id'), '`x-request-id`');
    assert.equal(picked('in the docs'), '[in the docs](https://docs.example.com/purge)');
    assert.equal(picked('What we know so far:'), '**What we know so far:**');
    assert.equal(picked('14:00 cache flush'), '**14:00 cache flush**');
  });

  it('leaves it out when the selection has only some of it', () => {
    assert.equal(picked('in the'), 'in the');
    assert.equal(picked('14:00'), '14:00');
    assert.equal(picked('know so'), 'know so');
  });

  it('keeps mentions and bare links as written, and list items a list', () => {
    assert.equal(picked('Sam Reyes, we'), 'Sam Reyes, we');
    assert.equal(picked('@Sam Reyes'), '@Sam Reyes');
    assert.equal(picked('https://docs.example.com/cdn'), 'https://docs.example.com/cdn');
    assert.equal(
      picked('the 503s started', 'are affected'),
      '- the 503s started with the **14:00 cache flush**\n- only `/en/*` and `/de/*` are affected',
    );
  });

  it('is all of the draft when all of its text is selected, and nothing when none is', () => {
    assert.equal(pick(DRAFT, TEXT, 0, TEXT.length), DRAFT);
    assert.equal(pick(DRAFT, TEXT, 3, 3), null);
    assert.equal(pick(DRAFT, TEXT, 0, 0), null);
  });

  it('is the text selected when the page shows something the source does not have', () => {
    const textOf = (md) => md;
    assert.equal(pickSource('abc', 'zzz yy', 0, 3, textOf), 'zzz');
    assert.equal(pickSource('a'.repeat(10), `${'b'.repeat(5000)}cd`, 5000, 5002, textOf), 'cd');
  });
});
