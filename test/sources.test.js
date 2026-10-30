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
  cleanSources, fetchable, frameable, lookAt, MAX_SOURCES, pageMarkdown,
} from '../src/sources.js';

const OWN = 'opspile.test';
const page = (body, headers = {}, status = 200) => new Response(body, {
  status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
});
const site = (answers) => async (url) => {
  const answer = answers[url];
  if (!answer) {
    throw new Error(`unexpected fetch of ${url}`);
  }
  return answer();
};

describe('draft sources', () => {
  it('keeps http(s) addresses, with their title and quote', () => {
    assert.deepEqual(cleanSources([
      { url: 'https://docs.example.org/a', title: ' A page ', quote: ' Said **here** ' },
      { url: 'http://docs.example.org/b' },
      { url: 'https://docs.example.org/a', title: 'Again' },
    ]), {
      sources: [
        { url: 'https://docs.example.org/a', title: 'Again' },
        { url: 'http://docs.example.org/b' },
      ],
    });
    assert.deepEqual(cleanSources(undefined), { sources: [] });
  });

  it('refuses what a browser should not open, and too many', () => {
    // eslint-disable-next-line no-script-url
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', '', 'https://me:secret@docs.example.org/']) {
      assert.match(cleanSources([{ url }]).error, /http\(s\) address/, url);
    }
    const many = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => ({ url: `https://docs.example.org/${i}` }));
    assert.match(cleanSources(many).error, /at most/);
  });

  it('fetches public names only, never our own host', () => {
    const can = (u) => fetchable(new URL(u), OWN);
    assert.equal(can('https://docs.example.org/'), true);
    for (const u of ['https://opspile.test/api/me', 'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/',
      'http://[::1]/', 'http://metadata.google.internal/', 'http://printer/', 'ftp://docs.example.org/']) {
      assert.equal(can(u), false, u);
    }
  });

  it('reads whether a site may be framed from its headers', () => {
    const can = (h) => frameable(new Headers(h));
    assert.equal(can({}), true);
    assert.equal(can({ 'content-security-policy': "default-src 'self'" }), true);
    assert.equal(can({ 'content-security-policy': 'frame-ancestors *' }), true);
    assert.equal(can({ 'x-frame-options': 'SAMEORIGIN' }), false);
    assert.equal(can({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), false);
    assert.equal(can({ 'content-security-policy': 'frame-ancestors https://a.example.org' }), false);
  });

  it('shows a page that may be framed in a frame, after its redirects', async () => {
    const v = await lookAt('https://docs.example.org/a', {
      own: OWN,
      fetchImpl: site({
        'https://docs.example.org/a': () => new Response(null, { status: 301, headers: { location: '/b' } }),
        'https://docs.example.org/b': () => page('<h1>B</h1>'),
      }),
    });
    assert.deepEqual(v, { view: 'frame', url: 'https://docs.example.org/b' });
  });

  it('does not follow a redirect to somewhere it would not fetch', async () => {
    const v = await lookAt('https://docs.example.org/a', {
      own: OWN,
      fetchImpl: site({
        'https://docs.example.org/a': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      }),
    });
    assert.equal(v.view, 'none');
  });

  it('turns a page that refuses frames into Markdown', async () => {
    const html = `<html><head><title>Docs &amp; more</title><style>x{}</style></head><body>
      <nav><a href="/">Menu</a></nav><script>alert(1)</script>
      <main><h2>Purging</h2><p>Purged <b>at once</b>, see <a href="/more?a=1&amp;b=2">more</a>.</p>
      <ul><li>one</li><li>two &lt;three&gt;</li></ul><a href="javascript:evil()">bad</a></main>
      <footer>Legal</footer></body></html>`;
    const v = await lookAt('https://docs.example.org/a', {
      own: OWN,
      fetchImpl: site({ 'https://docs.example.org/a': () => page(html, { 'x-frame-options': 'DENY' }) }),
    });
    assert.equal(v.view, 'markdown');
    assert.equal(v.title, 'Docs & more');
    assert.equal(v.text, '## Purging\n\nPurged **at once**, see [more](https://docs.example.org/more?a=1&b=2).\n\n- one\n- two <three>\n\nbad');
  });

  it('passes Markdown files on as they are', async () => {
    const v = await lookAt('https://docs.example.org/a.md', {
      own: OWN,
      fetchImpl: site({
        'https://docs.example.org/a.md': () => new Response('# A\n\ntext', { headers: { 'content-type': 'text/plain' } }),
      }),
    });
    assert.deepEqual(v, { view: 'markdown', url: 'https://docs.example.org/a.md', text: '# A\n\ntext' });
  });

  it('says why when it cannot show a page', async () => {
    const look = (answer) => lookAt('https://docs.example.org/a', {
      own: OWN, fetchImpl: site({ 'https://docs.example.org/a': answer }),
    });
    assert.match((await look(() => page('no', {}, 403))).reason, /answered 403/);
    const unreachable = () => {
      throw new Error('dns');
    };
    assert.match((await look(unreachable)).reason, /could not be reached/);
    assert.match((await look(() => page('', { 'x-frame-options': 'DENY' }))).reason, /without running its scripts/);
    const pdf = await look(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }));
    assert.equal(pdf.view, 'none');
  });

  it('keeps the page\'s text, not its markup', () => {
    assert.equal(pageMarkdown('<div onclick="x()">Hello<img src=x onerror=y></div>', 'https://a.example.org/'), 'Hello');
  });
});
