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
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import {
  candidateHosts, faviconProxy, findIcons, forgetIcons, orgDomain, pageIcons, pageTitle,
  registrable, sniff,
} from '../src/favicons.js';
import { CLEF } from '../src/label.js';

const ENV = { STAFF_DOMAINS: 'staff.example' };
const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);

/** An .ico of one bitmap entry and one PNG entry (`width` px). */
function ico(width) {
  const png = PNG(7);
  const bmp = new Uint8Array(40);
  const b = new Uint8Array(6 + 32 + bmp.length + png.length);
  const v = new DataView(b.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, 2, true);
  b[6] = 16;
  v.setUint32(6 + 8, bmp.length, true);
  v.setUint32(6 + 12, 38, true);
  b[22] = width;
  v.setUint32(22 + 8, png.length, true);
  v.setUint32(22 + 12, 38 + bmp.length, true);
  b.set(png, 38 + bmp.length);
  return b;
}

describe('favicons: where to look', () => {
  it('takes the org part of a domain', () => {
    assert.equal(registrable('non.acme.example'), 'acme.example');
    assert.equal(registrable('shop.acme.com.au'), 'acme.com.au');
    assert.equal(registrable('acme.com'), 'acme.com');
  });

  it('leaves out mail domains that are not the org\'s', () => {
    assert.equal(orgDomain(ENV, 'acme.example'), true);
    for (const d of ['staff.example', 'mail.staff.example', 'gmail.com', 'tenant.onmicrosoft.com', 'nodot']) {
      assert.equal(orgDomain(ENV, d), false, d);
    }
  });

  it('guesses the org\'s websites from its mail domains, slug and name', () => {
    assert.deepEqual(candidateHosts(ENV, {
      slug: 'acme-labs', name: 'ACME Laboratories', domains: ['non.acme.example', 'gmail.com'],
    }), ['acme.example', 'www.acme.example', 'non.acme.example', 'www.non.acme.example',
      'acme-labs.com', 'www.acme-labs.com', 'acmelabs.com', 'www.acmelabs.com', 'acme.com', 'www.acme.com']);
    assert.deepEqual(candidateHosts(ENV, { slug: 'initech' }), ['initech.com', 'www.initech.com']);
  });
});

describe('favicons: images and pages', () => {
  it('tells image types apart, and finds the PNG in an .ico', () => {
    assert.equal(sniff(PNG(1)), 'png');
    assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(sniff(new TextEncoder().encode('RIFF0000WEBPVP8 ')), 'webp');
    assert.equal(sniff(new TextEncoder().encode('  <svg xmlns="x"></svg>')), 'svg');
    assert.equal(sniff(new TextEncoder().encode('<!-- made by hand --><svg viewBox="0 0 1 1"/>')), 'svg');
    assert.equal(sniff(ico(32)), 'ico');
    assert.equal(sniff(new TextEncoder().encode('<html>')), null);
  });

  it('reads the icons and the title a page names', () => {
    const html = `<html><head><title>  ACME &amp; Co
      — Home </title>
      <link rel="stylesheet" href="/a.css">
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link href='https://cdn.acme.example/touch.png' rel='apple-touch-icon'>
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="shortcut icon" href="http://acme.example/old.ico">
      <link rel="icon" href="/favicon-32.png"></head></html>`;
    // An SVG comes after the others: Clef does not read it.
    assert.deepEqual(pageIcons(html, new URL('https://www.acme.example/home')), [
      'https://cdn.acme.example/touch.png', 'https://www.acme.example/favicon-32.png',
      'https://www.acme.example/icon.svg']);
    assert.equal(pageTitle(html), 'ACME & Co — Home');
    assert.equal(pageTitle('<html></html>'), null);
  });
});

describe('favicons: finding an org\'s', () => {
  const realFetch = globalThis.fetch;
  let fetched;
  let agents;
  beforeEach(() => {
    forgetIcons();
    fetched = [];
    agents = new Set();
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      agents.add(init.headers && init.headers['user-agent']);
      fetched.push(u.host === 'www.google.com' ? `google:${u.searchParams.get('domain')}` : u.href);
      if (u.host === 'www.google.com') {
        const d = u.searchParams.get('domain');
        // Google knows acme.example (and www., the same image) and a parked look-alike.
        if (d === 'acme.example' || d === 'www.acme.example') {
          return new Response(PNG(1), { headers: { 'content-type': 'image/png' } });
        }
        if (d === 'acmelabs.com') {
          return new Response(PNG(2), { headers: { 'content-type': 'image/png' } });
        }
        if (d === 'acme.com') {
          return new Response(null, { status: 503 });
        }
        return new Response(PNG(9), { status: 404 });
      }
      if (u.href === 'https://acme.example/') {
        return Object.defineProperty(new Response('<title>ACME</title><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/logo.svg">', {
          headers: { 'content-type': 'text/html' },
        }), 'url', { value: 'https://www.acme.example/' });
      }
      if (u.href === 'https://www.acme.example/touch.png') {
        return new Response(PNG(3));
      }
      if (u.href === 'https://www.acme.example/logo.svg') {
        return new Response('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
      }
      if (u.href === 'https://www.acme.example/favicon.ico') {
        return new Response(ico(48));
      }
      throw new Error('no such host');
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetches the candidates, and ranks them by what Clef says', async () => {
    const asked = [];
    const env = {
      ...ENV,
      AI: {
        async run(model, body) {
          assert.equal(model, CLEF);
          asked.push(body);
          const answers = {};
          body.images.forEach((img, i) => {
            const n = Buffer.from(img.base64, 'base64')[8];
            // acmelabs.com is somebody else's; the .ico's PNG is the stock one.
            answers[`site${i}`] = { noul: n === 2 ? 0.1 : 0.9 };
            answers[`stock${i}`] = { noul: n === 7 ? 0.8 : 0.1 };
          });
          return { answers };
        },
      },
    };
    const org = {
      slug: 'acme-labs', name: null, type: 'customer', domains: ['acme.example'],
    };
    const icons = await findIcons(env, org);
    assert.deepEqual(icons.map((c) => [c.icon, c.via, c.host, Math.round(c.p * 100)]), [
      ['acme.example', 'favicon', 'acme.example', 90],
      ['https://www.acme.example/touch.png', 'site', 'www.acme.example', 90],
      ['https://www.acme.example/favicon.ico', 'site', 'www.acme.example', 42],
      ['acmelabs.com', 'favicon', 'acmelabs.com', 30],
      // Offered, but not shown to Clef.
      ['https://www.acme.example/logo.svg', 'site', 'www.acme.example', 0],
    ]);
    assert.equal(icons.at(-1).p, null);
    assert.equal(icons.at(-1).svg, true);
    assert.equal(icons[0].title, 'ACME');
    // Sites are asked as a browser asks.
    assert.deepEqual([...agents].map((a) => /^Mozilla\/5\.0 \(Macintosh.*Chrome\/[\d.]+ Safari/.test(a)), [true]);
    assert.equal(icons[0].image, undefined);
    // Four images per question set; Clef is told where each is from.
    assert.deepEqual(asked.map((b) => b.images.length), [4]);
    assert.match(asked[0].state, /1\. the favicon of acme\.example \(the site's title: "ACME"\)/);
    assert.match(asked[0].state, /an icon the website www\.acme\.example names, www\.acme\.example\/touch\.png/);
    // acme.com answered 503, and was asked again.
    assert.equal(fetched.filter((f) => f === 'google:acme.com').length, 2);

    // Remembered for an hour, unless asked to look again.
    const n = fetched.length;
    await findIcons(env, org);
    assert.equal(fetched.length, n);
    await findIcons(env, org, { fresh: true });
    assert.ok(fetched.length > n);
  });

  it('still lists the candidates when Clef fails', async () => {
    const down = async () => {
      throw new Error('down');
    };
    const env = { ...ENV, AI: { run: down } };
    const { log } = console;
    console.log = () => {};
    try {
      const icons = await findIcons(env, { slug: 'acme', domains: ['acme.example'] });
      assert.ok(icons.length);
      assert.ok(icons.every((c) => c.p === null));
    } finally {
      console.log = log;
    }
  });

  it('answers 404 for a domain Google has no favicon of', async () => {
    assert.equal((await faviconProxy('acme.example')).status, 200);
    assert.equal((await faviconProxy('nothing.example')).status, 404);
    assert.equal((await faviconProxy('not a domain')).status, 400);
  });
});
