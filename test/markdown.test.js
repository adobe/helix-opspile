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
  codeLines, markdownToMrkdwn, mdLink, mdUrl, quoteMarkdown, quotesAsText, withoutQuotes,
} from '../src/markdown.js';

describe('codeLines', () => {
  it('finds fenced code as CommonMark does', () => {
    const lines = ['a', '```js', '```x', '~~~', '````', 'b', '```x```', '~~~ `ok`', 'c', '~~~~ ', 'd'];
    assert.deepEqual(codeLines(lines), [
      null, 'fence', 'code', 'code', 'fence', null, null, 'fence', 'code', 'fence', null,
    ]);
    // Indented four spaces is no fence; one not closed runs to the end.
    assert.deepEqual(codeLines(['    ```', '```', 'e']), [null, 'fence', 'code']);
    assert.deepEqual(codeLines(['> ```', '> x', '> ```'], (l) => l.replace(/^> ?/, '')), ['fence', 'code', 'fence']);
  });
});

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

describe('markdownToMrkdwn', () => {
  it('writes emphasis, links, headings and lists as Slack shows them', () => {
    assert.equal(
      markdownToMrkdwn('**bold**, *it*, __also bold__, ***both*** and ~~gone~~ but 2*3*4 and snake_case'),
      '*bold*, _it_, *also bold*, *_both_* and ~gone~ but 2*3*4 and snake_case',
    );
    assert.equal(
      markdownToMrkdwn('[docs](https://example.com/a?b=1&c=2), [](https://example.org) and <https://example.net>'),
      '<https://example.com/a?b=1&amp;c=2|docs>, <https://example.org> and <https://example.net>',
    );
    assert.equal(markdownToMrkdwn('## Next **steps** ##'), '*Next steps*');
    assert.equal(
      markdownToMrkdwn('- **one**: first\n  * two\n+ [ ] open\n- [x] done\n1. numbered'),
      '• *one*: first\n  • two\n• ☐ open\n• ☑ done\n1. numbered',
    );
    assert.equal(markdownToMrkdwn('> quoted **text**\n\n---'), '> quoted *text*\n\n──────────');
  });

  it('keeps code as code and escapes what Slack would read as markup', () => {
    assert.equal(markdownToMrkdwn('a<b & c>d, `x **y** <z>`'), 'a&lt;b &amp; c&gt;d, `x **y** &lt;z&gt;`');
    assert.equal(
      markdownToMrkdwn('```js\nif (a < b) { **x** }\n```\nafter **that**'),
      '```\nif (a &lt; b) { **x** }\n```\nafter *that*',
    );
    // An unclosed fence still ends the code block.
    assert.equal(markdownToMrkdwn('```\nopen'), '```\nopen\n```');
    // A code span on a line of its own is no fence, and a fence with text after it no end.
    assert.equal(markdownToMrkdwn('```x``` and **b**\n**c**'), '`x` and *b*\n*c*');
    assert.equal(markdownToMrkdwn('```\na\n```x\n```\n**c**'), '```\na\n```x\n```\n*c*');
  });
});

describe('quotes', () => {
  const quote = quoteMarkdown({
    author: 'Ada [ops]',
    url: 'https://example.slack.com/archives/C1/p1?thread_ts=0.1&cid=C1',
    at: '2026-10-21T11:43:20.000Z',
    text: 'Preview is down\n\n```\n503\n```',
  });
  const body = `Any news?\n\n${quote}\n\nAttachments:\n- [a.txt](https://files.example/a)`;

  it('quotes a message under a line with its author, linked to it', () => {
    assert.equal(quote, [
      '> [Ada \\[ops\\]](https://example.slack.com/archives/C1/p1?thread_ts=0.1&cid=C1 "Quoted message, 2026-10-21T11:43:20.000Z")',
      '>',
      '> Preview is down',
      '>',
      '> ```',
      '> 503',
      '> ```',
    ].join('\n'));
    assert.equal(quoteMarkdown({ url: 'https://example.slack.com/archives/C1/p2' }), '> [Message](https://example.slack.com/archives/C1/p2 "Quoted message")');
  });

  it('takes the quotes out of a body, or makes their first line plain text', () => {
    assert.equal(withoutQuotes(body), 'Any news?\n\nAttachments:\n- [a.txt](https://files.example/a)');
    assert.equal(withoutQuotes(quote), '');
    assert.equal(quotesAsText(body), 'Any news?\n\n> Ada [ops] wrote:\n> Preview is down\n>\n> ```\n> 503\n> ```\n\nAttachments:\n- [a.txt](https://files.example/a)');
    // A quote typed by hand is the author's own text.
    assert.equal(withoutQuotes('> as you said\n\nyes'), '> as you said\n\nyes');
  });
});
