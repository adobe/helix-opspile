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
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { bundle } from '../scripts/ui-markdown.mjs';
import { inboxPage } from '../src/page.js';
import BUNDLE from '../src/ui-markdown.bundle.js';
import { mentionPattern, render } from '../src/ui-markdown.js';

// Made-up names and addresses only.
const proxy = (u) => (/^https:\/\/files\.slack\.com\//.test(u) ? `/api/media?u=${encodeURIComponent(u)}` : u);
const opts = {
  mentions: mentionPattern(['Ada Lovelace', "Grace O'Hara"]),
  emoji: (name) => ({ eyes: '👀', wave: '👋' }[name]),
  proxy,
};
const md = (src) => render(src, opts).replace(/\n/g, '');

describe('ui markdown', () => {
  it('renders attachment lists the same from Slack and Teams', () => {
    const list = '<p>Attachments:</p><ul><li><a target="_blank" rel="noopener" href="https://files.example/a%20b.pdf">a b.pdf</a></li></ul>';
    assert.equal(md('Attachments:\n- [a b.pdf](https://files.example/a%20b.pdf)'), list);
    assert.equal(md('Attachments:\n\n- [a b.pdf](https://files.example/a%20b.pdf)'), list);
  });

  it('shows the label of Slack link markup inside code, not the markup', () => {
    const html = render('see (`<https://www.site.example|www.site.example>`) and `a.html`\n\n```\n<https://x.example/p>\n```');
    assert.match(html, /<code>www\.site\.example<\/code>/);
    assert.match(html, /<code>https:\/\/x\.example\/p\n<\/code>/);
    assert.doesNotMatch(html, /&lt;https/);
    // Outside code, `<…>` stays what markdown makes of it.
    assert.match(render('<https://x.example>'), /href="https:\/\/x\.example"/);
  });

  it('reserves the space of images whose size is known, scaled to the maximum height', () => {
    const html = render('![shot.png](https://files.example/a.png "1600x900") ![b](https://files.example/b.png "200x100") ![c](https://files.example/c.png)');
    assert.match(html, /class="att sized" src="https:\/\/files\.example\/a\.png" width="640" height="360"/);
    assert.match(html, /width="200" height="100"/);
    assert.match(html, /class="att" src="https:\/\/files\.example\/c\.png"/);
    assert.doesNotMatch(html, /title="\d+x\d+"/);
  });

  it('repairs links stored with spaces in their address', () => {
    assert.equal(
      md('- [a b.pdf](https://files.example/Shared Documents/a b.pdf)'),
      '<ul><li><a target="_blank" rel="noopener" href="https://files.example/Shared%20Documents/a%20b.pdf">a b.pdf</a></li></ul>',
    );
    assert.equal(
      md('[x](https://example.com "title")'),
      '<p><a target="_blank" rel="noopener" href="https://example.com" title="title">x</a></p>',
    );
  });

  it('breaks lines like chat does, but not in code or between blocks', () => {
    assert.equal(render('one\ntwo **b**\nthree', opts), '<p>one<br />\ntwo <strong>b</strong><br />\nthree</p>');
    assert.equal(render('```\na\nb\n```\nafter', opts), '<pre><code>a\nb\n</code></pre>\n\n<p>after</p>');
    assert.equal(md('> one\n> two'), '<blockquote><p>one<br />two</p></blockquote>');
    assert.equal(md('- a\n- b\n\n1. c'), '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
  });

  it('shows raw HTML and indented text as text', () => {
    assert.equal(md('<b>x</b> <script>alert(1)</script>'), '<p>&lt;b&gt;x&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(md('    indented'), '<p>indented</p>');
  });

  it('drops unsafe link protocols', () => {
    assert.equal(md('[x](javascript:alert(1))'), '<p><a target="_blank" rel="noopener" href="">x</a></p>');
  });

  it('links bare and bracketed URLs, and strikes through only with two tildes', () => {
    assert.equal(
      md('see <https://example.org> and https://example.com/x. ~~gone~~ ~5 min'),
      '<p>see <a target="_blank" rel="noopener" href="https://example.org">https://example.org</a> and <a target="_blank" rel="noopener" href="https://example.com/x">https://example.com/x</a>. <del>gone</del> ~5 min</p>',
    );
  });

  it('shows Slack and Teams images through the media proxy', () => {
    assert.equal(
      md('![shot](https://files.slack.com/a?b=1&c=2)'),
      '<p><img class="att" src="/api/media?u=https%3A%2F%2Ffiles.slack.com%2Fa%3Fb%3D1%26c%3D2" alt="shot" loading="lazy" tabindex="0"></p>',
    );
    assert.equal(
      md('![x](https://img.example/x.png)'),
      '<p><img class="att" src="https://img.example/x.png" alt="x" loading="lazy" tabindex="0"></p>',
    );
  });

  it('marks mentions and replaces emoji codes, except in code', () => {
    assert.equal(
      md("hi @Ada Lovelace, @Grace O'Hara and @Someone :eyes: :nope: `@Ada Lovelace :wave:`"),
      '<p>hi <span class="mention">@Ada Lovelace</span>, <span class="mention">@Grace O\'Hara</span> and <span class="mention">@Someone</span> 👀 :nope: <code>@Ada Lovelace :wave:</code></p>',
    );
    assert.equal(md('ask @Lovelace, Ada'), '<p>ask <span class="mention">@Lovelace, Ada</span></p>');
    assert.equal(md('@Ada Lovelacey'), '<p><span class="mention">@Ada</span> Lovelacey</p>');
    assert.equal(mentionPattern([]), null);
  });

  it('renders tables and task lists', () => {
    assert.equal(
      md('| a | b |\n|---|---|\n| 1 | 2 |'),
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    assert.equal(md('- [x] done'), '<ul><li><input type="checkbox" disabled="" checked="" /> done</li></ul>');
  });

  it('is bundled into the page, current with its source', async () => {
    const file = readFileSync(new URL('../src/ui-markdown.bundle.js', import.meta.url), 'utf8');
    assert.equal(file, await bundle(), 'run node scripts/ui-markdown.mjs');
    assert.ok(BUNDLE.startsWith('var Markdown='));
    const html = readFileSync(new URL('../ui/inbox.html', import.meta.url), 'utf8');
    const page = inboxPage(html);
    const script = page.slice(page.indexOf('<script>var Markdown=') + 8, page.indexOf('</script>', page.indexOf('<script>var Markdown=')));
    // In the browser, entities are decoded by the DOM.
    const document = {
      createElement: () => {
        let text = '';
        return {
          set innerHTML(v) { text = { '&copy;': '©' }[v] ?? v; },
          get textContent() { return text; },
        };
      },
    };
    // eslint-disable-next-line no-new-func
    const Markdown = new Function('document', `${script}\nreturn Markdown;`)(document);
    assert.equal(Markdown.render('**hi**\nthere &copy;'), '<p><strong>hi</strong><br />\nthere ©</p>');
    assert.throws(() => inboxPage(html.replace('<script>/* MARKDOWN */</script>', '')), /MARKDOWN/);
  });
});
