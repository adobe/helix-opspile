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
import { quoteMarkdown } from '../src/markdown.js';
import {
  fileKind, mentionPattern, render, splitAttachments,
} from '../src/ui-markdown.js';
import { PAGES, SCRIPTS } from './ui.js';

// Made-up names and addresses only.
const proxy = (u) => (/^https:\/\/files\.slack\.com\//.test(u) ? `/api/media?u=${encodeURIComponent(u)}` : u);
const opts = {
  mentions: mentionPattern(['Ada Lovelace', "Grace O'Hara"]),
  emoji: (name) => ({ eyes: '👀', wave: '👋' }[name]),
  proxy,
};
const md = (src) => render(src, opts).replace(/\n/g, '');

describe('ui markdown', () => {
  it('renders attachment lists the same from Slack and Teams, as file cards', () => {
    const card = '<div class="files"><div class="file" data-kind="pdf"><span class="file-ico" aria-hidden="true">PDF</span>'
      + '<span class="file-nm"><a class="file-name" href="https://files.example/a%20b.pdf" target="_blank" rel="noopener" title="Open: a b.pdf">a b.pdf</a>'
      + '<span class="file-sub">PDF</span></span><a class="file-go" href="https://files.example/a%20b.pdf" target="_blank" rel="noopener" title="Open: a b.pdf" tabindex="-1" aria-hidden="true">↗</a></div></div>';
    assert.equal(md('Attachments:\n- [a b.pdf](https://files.example/a%20b.pdf)'), card);
    assert.equal(md('Attachments:\n\n- [a b.pdf](https://files.example/a%20b.pdf)'), card);
  });

  it('shows a message\'s files as cards: where they live, and a preview of tables and text', () => {
    const html = render('See these.\n\nAttachments:\n- [table (3).csv](https://acme.slack.com/files/U1/F1/table__3_.csv)\n'
      + '- [Quiz \\[v2\\].mov](https://acme.slack.com/files/U1/F2/quiz.mov)\n- [a.log](https://cdn.discordapp.com/attachments/1/2/a.log)');
    assert.match(html, /^<p>See these\.<\/p><div class="files">/);
    assert.doesNotMatch(html, /Attachments:/);
    assert.match(html, /data-kind="table" data-home="Slack"><span class="file-ico" aria-hidden="true">CSV<\/span>/);
    assert.match(html, /title="Open in Slack: table \(3\)\.csv">table \(3\)\.csv<\/a><span class="file-sub">Table · Slack<\/span>/);
    assert.match(html, /<button type="button" class="file-act" data-preview="table" aria-expanded="false"/);
    assert.match(html, />Quiz \[v2\]\.mov<\/a><span class="file-sub">Video · Slack<\/span><\/span><a class="file-go"/);
    assert.match(html, /data-kind="text" data-home="Discord">.*data-preview="text"/);
    // A file of another workspace: a card without a link.
    const unseen = render('Attachments:\n- CSV file (shared from another workspace; opspile cannot see it)');
    assert.match(unseen, /<span class="file-name">CSV file<\/span><span class="file-sub">Shared from another workspace; opspile cannot see it<\/span>/);
    assert.match(unseen, />CSV<\/span>/);
    assert.doesNotMatch(unseen, /data-preview|file-go/);
  });

  it('plays video and audio files in their cards, with Slack\'s still as the poster', () => {
    const fileUrl = (u, what) => `/api/file/${what}?u=${encodeURIComponent(u)}`;
    const html = render('Attachments:\n- [rec.mov](https://acme.slack.com/files/U1/F1/rec.mov)\n- [a.mp3](https://cdn.discordapp.com/attachments/1/2/a.mp3)\n- [b.mp4](https://cdn.discordapp.com/attachments/1/2/b.mp4)', { fileUrl });
    assert.match(html, /<div class="file has-player" data-kind="video" data-home="Slack"><video class="file-player" controls playsinline preload="none" src="\/api\/file\/stream\?u=https%3A%2F%2Facme\.slack\.com%2Ffiles%2FU1%2FF1%2Frec\.mov" poster="\/api\/file\/poster\?u=[^"]+" aria-label="Play: rec\.mov"><\/video>/);
    assert.match(html, /<audio class="file-player" controls preload="none" src="\/api\/file\/stream\?u=[^"]+a\.mp3"/);
    // Only Slack makes stills.
    assert.match(html, /<video [^>]*b\.mp4" aria-label/);
    // Without a place to load them from, they are cards as any other file.
    assert.doesNotMatch(render('Attachments:\n- [rec.mov](https://acme.slack.com/files/U1/F1/rec.mov)'), /<video|has-player/);
  });

  it('keeps the links of file cards as safe as other links', () => {
    const html = render('Attachments:\n- [x.csv](javascript:alert(1))\n- [<b>y</b>.txt](https://files.example/y.txt)');
    assert.doesNotMatch(html, /javascript:/);
    assert.doesNotMatch(html, /<b>/);
  });

  it('shows Slack\'s attached images without the "Attachments:" line, two or more as a gallery', () => {
    const html = render('Look\n\nAttachments:\n![a.png](https://files.slack.com/a.png "800x600")\n![b.png](https://files.slack.com/b.png "800x600")\n\n- [c.txt](https://files.example/c.txt)');
    assert.match(html, /^<p>Look<\/p>\n+<div class="gallery">(<img class="att sized"[^>]*>){2}<\/div>\s*<div class="files">/);
    assert.doesNotMatch(html, /Attachments:/);
  });

  it('leaves text of the person\'s own that starts with "Attachments:" as it is', () => {
    assert.equal(md('Attachments:\nThe logs are in the ticket.'), '<p>Attachments:<br />The logs are in the ticket.</p>');
    // Only the last list is the files; one earlier is text.
    assert.match(render('Attachments:\nsee below\n\nAttachments:\n- [a.csv](https://files.example/a.csv)'), /^<p>Attachments:<br \/>\nsee below<\/p><div class="files">/);
  });

  it('names a file\'s kind by its extension', () => {
    assert.deepEqual(fileKind('Report.XLSX'), { kind: 'sheet', label: 'Spreadsheet', ext: 'xlsx' });
    assert.deepEqual(fileKind('trace.har'), { kind: 'text', label: 'Text', ext: 'har' });
    assert.deepEqual(fileKind('README'), { kind: 'file', label: 'File', ext: '' });
    assert.equal(splitAttachments('no files'), null);
    assert.deepEqual(splitAttachments('Hi\n\nAttachments:\n- [a.csv](https://x.example/a.csv)'), {
      text: 'Hi\n\n', images: [], links: ['- [a.csv](https://x.example/a.csv)'], unseen: [],
    });
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

  it('shows images one after the other as a gallery, and no other images', () => {
    const img = (n) => `![${n}](https://files.example/${n}.png "800x600")`;
    const run = render(`Text.\n\n${img('a')}\n\n${img('b')}\n\n${img('c')} ${img('d')}\n\nMore text.`);
    assert.match(run, /^<p>Text\.<\/p>\n+<div class="gallery">(<img class="att sized"[^>]*>){4}<\/div>\n<p>More text\.<\/p>$/);
    // One image alone, or images with text between them, stay as they are.
    assert.doesNotMatch(render(img('a')), /gallery/);
    assert.doesNotMatch(render(`${img('a')}\n\nsee\n\n${img('b')}`), /gallery/);
    assert.doesNotMatch(render(`see ${img('a')} and ${img('b')}`), /gallery/);
    // Not in code.
    assert.doesNotMatch(render(`\`\`\`\n${img('a')}\n\n${img('b')}\n\`\`\``), /gallery/);
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

  it('links the channels a message names, by name, to where they are', () => {
    const channels = {
      C0AAAAAAAA1: {
        name: 'acme-ops', href: '/inbox?team=ops&filters=1&f.customer=acme', inbox: true, title: '#acme-ops: Acme in Ops',
      },
      'beta-help': { name: 'beta-help', href: 'https://slack.com/archives/C0BBBBBBBB2' },
    };
    const html = render('New channel: #C0AAAAAAAA1. Ask in #beta-help, not #other, `#C0AAAAAAAA1` or [#beta-help](https://x.example)', {
      channel: (token) => channels[token],
    }).replace(/\n/g, '');
    assert.equal(html, '<p>New channel: <a class="channel" href="/inbox?team=ops&amp;filters=1&amp;f.customer=acme" data-inbox title="#acme-ops: Acme in Ops">#acme-ops</a>. '
      + 'Ask in <a class="channel" href="https://slack.com/archives/C0BBBBBBBB2" target="_blank" rel="noopener">#beta-help</a>, not #other, '
      + '<code>#C0AAAAAAAA1</code> or <a target="_blank" rel="noopener" href="https://x.example">#beta-help</a></p>');
    // Without channels, the text stays as it was.
    assert.equal(md('see #C0AAAAAAAA1'), '<p>see #C0AAAAAAAA1</p>');
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

  it('tells mentions of Adobe people from those of customers and partners', () => {
    const kinds = { 'ada lovelace': 'adobe', "grace o'hara": 'customer', someone: 'partner' };
    const out = render("@Ada Lovelace, @Grace O'Hara, @Someone and @Nobody", {
      ...opts, kindOf: (name) => kinds[name.toLowerCase()],
    });
    assert.equal(
      out,
      '<p><span class="mention adobe" title="Adobe">@Ada Lovelace</span>, '
        + '<span class="mention external customer" title="Customer, not Adobe">@Grace O\'Hara</span>, '
        + '<span class="mention external partner" title="Partner, not Adobe">@Someone</span> and '
        + '<span class="mention">@Nobody</span></p>',
    );
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
    const served = inboxPage(PAGES['inbox.html'], SCRIPTS);
    const at = served.indexOf('var Markdown=');
    const script = served.slice(at, served.indexOf('</script>', at));
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
  });
});

describe('quoted messages', () => {
  it('shows a quoted message as a card: its author, linked to it, and when it was posted', () => {
    const html = md(`Any news?\n\n${quoteMarkdown({
      author: 'Ada Lovelace', url: 'https://example.slack.com/archives/C1/p1?thread_ts=0.1&cid=C1', at: '2026-10-21T11:43:20.000Z', text: 'Preview is *down* for :eyes:',
    })}`);
    assert.match(html, /^<p>Any news\?<\/p><blockquote class="quote"><p class="quote-by"><a target="_blank" rel="noopener" href="https:\/\/example\.slack\.com\/archives\/C1\/p1\?thread_ts=0\.1&amp;cid=C1" title="Open the quoted message"><b>Ada Lovelace<\/b><\/a> <time datetime="2026-10-21T11:43:20\.000Z">[^<]+<\/time><\/p><p>Preview is <em>down<\/em> for 👀<\/p><\/blockquote>$/);
  });

  it('keeps a quote typed by hand a quote', () => {
    assert.equal(md('> [Ada](https://example.com/a)\n>\n> said so'), '<blockquote><p><a target="_blank" rel="noopener" href="https://example.com/a">Ada</a></p><p>said so</p></blockquote>');
  });
});
