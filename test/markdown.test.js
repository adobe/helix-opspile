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
import {
  htmlToMarkdown, mdLink, mdUrl, slackToMarkdown,
} from '../src/markdown.js';

describe('mdLink', () => {
  it('encodes what would end a link destination', () => {
    assert.equal(mdUrl('https://example.com/a b/c\td'), 'https://example.com/a%20b/c%09d');
    assert.equal(mdUrl('https://example.com/<x>'), 'https://example.com/%3Cx%3E');
    assert.equal(mdUrl('https://example.com/wiki/A_(b)'), 'https://example.com/wiki/A_(b)');
    assert.equal(mdUrl('https://example.com/a)b'), 'https://example.com/a%29b');
    assert.equal(mdUrl(undefined), '');
  });

  it('escapes brackets in the label', () => {
    assert.equal(mdLink('a [b] c', 'https://example.com/x y'), '[a \\[b\\] c](https://example.com/x%20y)');
    assert.equal(mdLink('pic', 'https://example.com/p.png', true), '![pic](https://example.com/p.png)');
  });
});

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

  it('keeps a link whose text is its URL (it used to be stripped as a tag)', () => {
    const url = 'https://www.example.com/docs/setup';
    assert.equal(
      htmlToMarkdown(`<p>see <a href="${url}" title="${url}">${url}</a>.</p>`),
      `see [${url}](${url}).`,
    );
  });

  it('keeps links with spaces in their address links', () => {
    assert.equal(
      htmlToMarkdown('<a href="https://example.com/Shared Documents/a b.pdf">a b.pdf</a>'),
      '[a b.pdf](https://example.com/Shared%20Documents/a%20b.pdf)',
    );
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
