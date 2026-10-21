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
import { htmlToMarkdown, slackToMarkdown } from '../src/markdown.js';

describe('slackToMarkdown', () => {
  it('converts emphasis, strike-through and quotes', () => {
    assert.equal(slackToMarkdown('*bold* and _it_ and ~gone~'), '**bold** and *it* and ~~gone~~');
    assert.equal(slackToMarkdown('&gt; quoted'), '> quoted');
  });

  it('converts links, mentions and channel references', () => {
    const names = { U1: 'Ada' };
    assert.equal(
      slackToMarkdown('see <https://example.com|docs> and <https://example.org> <@U1> <@U2> <#C1|ops> <!here>', (id) => names[id]),
      'see [docs](https://example.com) and <https://example.org> @Ada @U2 #ops @here',
    );
  });

  it('leaves code alone', () => {
    assert.equal(slackToMarkdown('run `a *b* c` now'), 'run `a *b* c` now');
    assert.equal(slackToMarkdown('```\nif (a &lt; b) *x*\n```'), '```\nif (a < b) *x*\n```');
  });

  it('unescapes entities', () => {
    assert.equal(slackToMarkdown('a &amp; b &lt;c&gt;'), 'a & b <c>');
  });
});

describe('htmlToMarkdown', () => {
  it('converts paragraphs, emphasis and breaks', () => {
    assert.equal(
      htmlToMarkdown('<p>Hello <b>there</b>,<br>this is <i>it</i>.</p><p>Next</p>'),
      'Hello **there**,\nthis is *it*.\n\nNext',
    );
  });

  it('converts links, mentions and lists', () => {
    assert.equal(
      htmlToMarkdown('<p><at id="0">Ada Lovelace</at> see <a href="https://example.com">docs</a></p><ul><li>one</li><li>two</li></ul>'),
      '@Ada Lovelace see [docs](https://example.com)\n\n- one\n- two',
    );
    assert.equal(htmlToMarkdown('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
  });

  it('converts code and decodes entities', () => {
    assert.equal(htmlToMarkdown('<pre><code>a &lt; b</code></pre>'), '```\na < b\n```');
    assert.equal(htmlToMarkdown('<p>x &amp; y&nbsp;z</p>'), 'x & y z');
  });

  it('keeps plain text', () => {
    assert.equal(htmlToMarkdown('just text'), 'just text');
    assert.equal(htmlToMarkdown(''), '');
  });
});
