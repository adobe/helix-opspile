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
import { htmlToMarkdown } from '../src/html.js';

describe('htmlToMarkdown', () => {
  it('converts paragraphs, emphasis and breaks', () => {
    assert.equal(
      htmlToMarkdown('<p>Hello <b>there</b>,<br>this is <i>it</i>.</p><p>Next</p>'),
      'Hello **there**,\nthis is *it*.\n\nNext',
    );
    assert.equal(htmlToMarkdown('<p>gone <s>now</s>, <u>underlined</u></p>'), 'gone ~~now~~, underlined');
  });

  it('puts the white space at the ends of bold and italics outside their markers', () => {
    // Teams bolds the space after a word; `**same **` is no bold in markdown.
    assert.equal(
      htmlToMarkdown('<p>both have the <strong>same </strong><code>contentBusId</code></p>'),
      'both have the **same** `contentBusId`',
    );
    assert.equal(htmlToMarkdown('<p>a<b> b</b>c <i> </i>d</p>'), 'a **b**c d');
    assert.equal(htmlToMarkdown('<p><strong>Hi </strong><strong>there, </strong>all</p>'), '**Hi there,** all');
    assert.equal(htmlToMarkdown('<p><strong>Note: </strong></p>'), '**Note:**');
  });

  it('converts links, mentions and lists', () => {
    assert.equal(
      htmlToMarkdown('<p><at id="0">Ada Lovelace</at> see <a href="https://example.com">docs</a></p><ul><li>one</li><li>two</li></ul>'),
      '@Ada Lovelace see [docs](https://example.com)\n\n- one\n- two',
    );
    assert.equal(htmlToMarkdown('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
    assert.equal(
      htmlToMarkdown('<ul>\n<li>a\n<ul>\n<li>b</li><li>c</li></ul></li><li>d</li></ul>'),
      '- a\n  - b\n  - c\n- d',
    );
    // A mention next to a file is still a mention.
    assert.equal(
      htmlToMarkdown('<attachment id="1"></attachment>\n<p>is this possible <at id="0">Ada</at>&nbsp;?</p>'),
      'is this possible @Ada ?',
    );
  });

  it('converts tables, with the first row as the header', () => {
    assert.equal(
      htmlToMarkdown('<table itemprop="copy-paste-table"><tbody><tr><td><p>a</p></td><td>b</td></tr><tr><td>c|d</td><td>e<br>f</td></tr></tbody></table>'),
      '| a | b |\n| --- | --- |\n| c\\|d | e f |',
    );
    assert.equal(
      htmlToMarkdown('<table><tr><th align="left">a</th><th align="right">b</th><th align="center">c</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>'),
      '| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |',
    );
    assert.equal(htmlToMarkdown('<table><tr></tr></table>'), '');
  });

  it('keeps a link whose text is its URL as a link', () => {
    const url = 'https://www.example.com/docs/setup';
    assert.equal(
      htmlToMarkdown(`<p>see <a href="${url}" title="${url}">${url}</a>.</p>`),
      `see [${url}](${url}).`,
    );
    assert.equal(htmlToMarkdown('<p>a <a title="x">b</a></p>'), 'a b');
  });

  it('keeps links with spaces in their address links', () => {
    assert.equal(
      htmlToMarkdown('<a href="https://example.com/Shared Documents/a b.pdf">a b.pdf</a>'),
      '[a b.pdf](https://example.com/Shared%20Documents/a%20b.pdf)',
    );
  });

  it('links web addresses in text, so that no escape ends up in them', () => {
    assert.equal(
      htmlToMarkdown('<p>see https://x.example/a?b=c&amp;d_e. Or (https://x.example/w_(a)), www.x.example!</p>'),
      'see [https://x.example/a?b=c\\&d_e](https://x.example/a?b=c&d_e). Or ([https://x.example/w\\_(a)](https://x.example/w_(a))), [www.x.example](http://www.x.example)!',
    );
    assert.equal(htmlToMarkdown('<p>https://*.x.example</p>'), 'https://\\*.x.example');
  });

  it('converts code, code blocks and their languages, and decodes entities', () => {
    assert.equal(htmlToMarkdown('<pre><code>a &lt; b</code></pre>'), '```\na < b\n```');
    assert.equal(
      htmlToMarkdown('<codeblock class="Json"><code>{<br>&nbsp;&nbsp;"a":&nbsp;1<br>}</code></codeblock>'),
      '```json\n{\n  "a": 1\n}\n```',
    );
    assert.equal(
      htmlToMarkdown('<codeblock class="PlainText"><code><span class="hljs-string">$ curl</span>&nbsp;-I<br>HTTP/2 301</code></codeblock>'),
      '```\n$ curl -I\nHTTP/2 301\n```',
    );
    assert.equal(htmlToMarkdown('<codeblock class=""><code class="language-js">a  \n</code></codeblock>'), '```js\na  \n```');
    assert.equal(htmlToMarkdown('<p>x &amp; y&nbsp;z</p>'), 'x & y z');
  });

  it('keeps emoji, and leaves out the empty lines Teams writes as paragraphs', () => {
    assert.equal(
      htmlToMarkdown('<p>thanks <emoji id="smile" alt="🙂" title="Smile"></emoji>&nbsp;</p><p>&nbsp;</p><p></p><p>next</p>'),
      'thanks 🙂\n\nnext',
    );
  });

  it('escapes markdown typed as text, as Teams shows it', () => {
    assert.equal(
      htmlToMarkdown('<p>use `x` or **y**, 2*3*4 and snake_case<br>1. one<br>- two</p>'),
      'use \\`x\\` or \\*\\*y\\*\\*, 2\\*3\\*4 and snake_case\n1\\. one\n\\- two',
    );
  });

  it('keeps the size Teams gives an image, as its title', () => {
    const md = htmlToMarkdown('<p><img src="https://graph.example/hc/1/$value" alt="image" width="250" height="140" style="width:250px; height:140px"></p>');
    assert.equal(md, '![image](https://graph.example/hc/1/$value "250x140")');
    assert.match(htmlToMarkdown('<img src="https://graph.example/x" style="width:300px;height:200px">'), /"300x200"\)/);
    assert.equal(htmlToMarkdown('<img src="https://graph.example/x">'), '![image](https://graph.example/x)');
  });

  it('keeps plain text', () => {
    assert.equal(htmlToMarkdown('just text'), 'just text');
    assert.equal(htmlToMarkdown(''), '');
  });
});
