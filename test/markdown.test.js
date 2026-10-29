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
  htmlToMarkdown, markdownToMrkdwn, mdLink, mdUrl, quoteMarkdown, quotesAsText, slackToMarkdown,
  withoutQuotes,
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

describe('Slack markup in code', () => {
  it('keeps what the person typed: the label, the URL or @name', () => {
    const md = slackToMarkdown('try (`<https://www.site.example|www.site.example>`) or `<@U1>`\n```<http://x.example/a>```', (id) => (id === 'U1' ? 'Ada' : undefined));
    assert.match(md, /\(`www\.site\.example`\)/);
    assert.match(md, /`@Ada`/);
    assert.match(md, /```\nhttp:\/\/x\.example\/a\n```/);
  });
});

describe('image sizes', () => {
  it('keeps the size Teams gives an image, as its title', () => {
    const md = htmlToMarkdown('<p><img src="https://graph.example/hc/1/$value" alt="image" width="250" height="140" style="width:250px; height:140px"></p>');
    assert.match(md, /!\[image\]\(https:\/\/graph\.example\/hc\/1\/\$value "250x140"\)/);
    assert.match(htmlToMarkdown('<img src="https://graph.example/x" style="width:300px;height:200px">'), /"300x200"\)/);
    assert.doesNotMatch(htmlToMarkdown('<img src="https://graph.example/x">'), /"\d+x\d+"/);
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
