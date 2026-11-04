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
import { BUNDLES, bundle } from '../scripts/ui-markdown.mjs';
import { HIGHLIGHT_PATH, highlightScript, spectrumColor } from '../src/page.js';
import HIGHLIGHT, { etag } from '../src/ui-highlight.bundle.js';
import {
  GROUPS, LONGEST, guessLanguage, highlight,
} from '../src/ui-highlight.js';
import { render } from '../src/ui-markdown.js';
import { SCRIPTS } from './ui.js';

/** The text of highlighted HTML, as the browser shows it. */
const textOf = (html) => html.replace(/<[^>]*>/g, '')
  .replace(/&(lt|gt|quot|amp);/g, (_, e) => ({
    lt: '<', gt: '>', quot: '"', amp: '&',
  }[e]));

describe('code highlighting', () => {
  it('guesses the language of a block that names none, and leaves prose alone', () => {
    const cases = [
      ['{\n  "source": { "type": "markup", "retries": 3 }\n}', 'json'],
      ['[1, 2, 3]', 'json'],
      // Cut off, or with a trailing comma: JSON all the same.
      ['{\n  "owner": "acme",\n  "repo": "web",\n', 'jsonc'],
      ['<?xml version="1.0"?>\n<jcr:root jcr:primaryType="sling:Folder"/>', 'xml'],
      ['<div class="hero">\n  <h1>Hi</h1>\n</div>', 'html'],
      ['<!DOCTYPE html>\n<html></html>', 'html'],
      ['--- a/config.yaml\n+++ b/config.yaml\n@@ -1 +1 @@\n-old: 1\n+new: 2', 'diff'],
      ['RewriteCond %{REQUEST_URI} ^/old\nRewriteRule ^/old/(.*)$ /new/$1 [R=301,L]', 'apache'],
      ['GET /index.html HTTP/1.1\nHost: www.example.com', 'http'],
      ['2026-10-21 10:02:11.204 *ERROR* [main] Failed\n2026-10-21 10:02:12.001 *INFO* [main] Retried', 'log'],
      ['21.10.2026 10:02:11.204 *WARN* [qtp] Slow request', 'log'],
      ['SELECT id, path FROM pages WHERE status = \'draft\'', 'sql'],
      ['package com.example;\n\nimport java.util.List;\n\npublic class A {}', 'java'],
      ['const a = await fetch(url);\nconsole.log(a.status);', 'javascript'],
      ['def handler(event):\n    return event["body"]', 'python'],
      ['.hero {\n  color: red;\n  margin: 0;\n}', 'css'],
      ['curl -sS https://www.example.com/ | head', 'bash'],
      ['$ npm run build', 'bash'],
      ['name: acme\nversion: 2\nitems:\n  - a\n  - b', 'yaml'],
      // Prose, an error message, a stack, an access log: plain text.
      ['The preview is down again since this morning.', ''],
      ['Error: fetch failed\n    at main (index.js:1:2)', ''],
      ['GET /index.plain.html 503 1203ms\nGET /nav.plain.html 200 41ms', ''],
      ['Note: this is not YAML, it is a sentence.', ''],
      ['', ''],
    ];
    for (const [code, lang] of cases) {
      assert.equal(guessLanguage(code), lang, code);
    }
  });

  it('writes runs of the token groups, and exactly the block\'s text', () => {
    const code = '{\n  "a": "<b> & c",\n  "n": 1,\n  "t": true\n}\n';
    const html = highlight(code);
    assert.equal(textOf(html), code);
    assert.match(html, /<span class="hl-property">&quot;a&quot;<\/span>: <span class="hl-string">&quot;&lt;b&gt; &amp; c&quot;<\/span>/);
    assert.match(html, /<span class="hl-constant">1<\/span>/);
    assert.match(html, /<span class="hl-constant">true<\/span>/);
    // Nothing but the groups' classes, and no style.
    for (const [, cls] of html.matchAll(/<span class="([^"]*)">/g)) {
      assert.ok(Object.values(GROUPS).map((g) => `hl-${g}`).includes(cls), cls);
    }
    assert.doesNotMatch(html, /style=/);
    const js = highlight('// hi\nconst x = f(1);', 'JS');
    assert.match(js, /^<span class="hl-comment">\/\/ hi<\/span>\n<span class="hl-keyword">const <\/span>/);
    assert.match(js, /<span class="hl-function">f<\/span>/);
    // The fence's info string: its first word is the language.
    assert.ok(highlight('a: 1', 'yaml title="x"'));
  });

  it('leaves plain what it cannot or should not highlight', () => {
    assert.equal(highlight('hello there'), null);
    assert.equal(highlight('{"a": 1}', 'text'), null);
    assert.equal(highlight('{"a": 1}', 'plaintext'), null);
    assert.equal(highlight('x = 1', 'no-such-language'), null);
    assert.equal(highlight(`[${'1,'.repeat(LONGEST / 2)}1]`), null);
    // A line of a thousand characters or more is one run in the text's color.
    const long = `const a = "${'x'.repeat(1200)}";`;
    assert.equal(highlight(long, 'js'), long.replace(/"/g, '&quot;'));
  });

  it('highlights fenced code in markdown with what the page gives it', () => {
    const seen = [];
    const lit = (code, lang) => {
      seen.push([code, lang]);
      return lang === 'none' ? null : `<span class="hl-string">${code.length}</span>`;
    };
    const html = render('see `a < b`\n\n```\na < b & "c"\n```\n\n```json\n{}\n```\n\n```none\nx\n```\n\n> ```\n> q\n> ```', { highlight: lit });
    assert.deepEqual(seen, [['a < b & "c"\n', ''], ['{}\n', 'json'], ['x\n', 'none'], ['q\n', '']]);
    assert.match(html, /<code>a &lt; b<\/code>/);
    assert.match(html, /<pre class="hl"><code><span class="hl-string">12<\/span><\/code><\/pre>/);
    assert.match(html, /<pre class="hl"><code><span class="hl-string">3<\/span><\/code><\/pre>/);
    // One it leaves plain stays as micromark wrote it.
    assert.match(html, /<pre><code class="language-none">x\n<\/code><\/pre>/);
    assert.match(html, /<blockquote>\n?<pre class="hl">/);
    // Without a highlighter, nothing changes.
    assert.match(render('```\na\n```'), /^<pre><code>a\n<\/code><\/pre>$/);
    // With the real one, emoji codes and mentions in code stay as typed.
    const real = render('```\n{ "e": ":eyes:", "m": "@Ada Lovelace" }\n```', { highlight, emoji: () => '👀' });
    assert.match(real, /:eyes:/);
    assert.doesNotMatch(real, /👀|class="mention/);
  });

  it('colors every group with a Spectrum 2 token that keeps 4.5:1 on a code block', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const over = (base, top, alpha) => base.map((v, i) => v * (1 - alpha) + top[i] * alpha);
    for (const group of new Set(Object.values(GROUPS))) {
      assert.match(css, new RegExp(`\\.spectrum \\.bubble pre\\.hl \\.hl-${group}[ ,]`), group);
    }
    const colors = [...css.matchAll(/pre\.hl \.hl-[a-z]+ \{ color: var\(--(spectrum-[a-z0-9-]+)\)/g)]
      .map((m) => m[1]);
    assert.ok(colors.length >= 9);
    for (const scheme of ['light', 'dark']) {
      // A code block is the faint overlay (--s2-hover) on a bubble, or on the pane (the agent's).
      const tint = rgb(spectrumColor('spectrum-gray-1000', scheme));
      const alpha = Number(spectrumColor('spectrum-transparent-black-100-opacity', scheme));
      const grounds = ['spectrum-gray-100', 'spectrum-background-base-color']
        .map((name) => over(rgb(spectrumColor(name, scheme)), tint, alpha));
      for (const color of colors) {
        for (const ground of grounds) {
          const r = ratio(rgb(spectrumColor(color, scheme)), ground);
          assert.ok(r >= 4.5, `${color} in ${scheme}: ${r.toFixed(2)}`);
        }
      }
    }
  });

  it('is served on its own, current with its source, and the inbox imports it', async () => {
    const file = readFileSync(new URL('../src/ui-highlight.bundle.js', import.meta.url), 'utf8');
    assert.equal(file, await bundle(BUNDLES.find((b) => b.name === 'ui-highlight')), 'run node scripts/ui-markdown.mjs');
    assert.match(HIGHLIGHT, /export\{[^}]*\bhighlight\b/);
    assert.ok(SCRIPTS['inbox.js'].includes(`'${HIGHLIGHT_PATH}'`));
    const get = (path, headers = {}, method = 'GET') => highlightScript({ method, headers: new Headers(headers) }, path);
    const ok = get(HIGHLIGHT_PATH);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(ok.headers.get('etag'), etag);
    assert.equal(await ok.text(), HIGHLIGHT);
    assert.equal(get(HIGHLIGHT_PATH, { 'if-none-match': etag }).status, 304);
    assert.equal(get(HIGHLIGHT_PATH, { 'if-none-match': `W/${etag}` }).status, 304);
    assert.equal(get(HIGHLIGHT_PATH, { 'if-none-match': '"old"' }).status, 200);
    assert.equal(await get(HIGHLIGHT_PATH, {}, 'HEAD').text(), '');
    assert.equal(get(HIGHLIGHT_PATH, {}, 'POST'), null);
    assert.equal(get('/inbox/other.js'), null);
  });

  it('works in the browser bundle as it does here', async () => {
    const url = `data:text/javascript;base64,${Buffer.from(HIGHLIGHT).toString('base64')}`;
    const served = await import(url);
    const code = '{\n  "a": [1, true, null]\n}';
    assert.equal(served.highlight(code), highlight(code));
  });
});
