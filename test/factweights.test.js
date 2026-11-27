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
import { factKey, factOf, factWeights } from '../src/factweights.js';

// Made-up hosts, repositories and customers only.
describe('fact weights: keys (src/factweights.js)', () => {
  it('makes one key of every form of a value', () => {
    assert.equal(factKey('doc', 'docs/limits'), 'doc:docs/limits');
    assert.equal(factKey('doc', '/docs/admin.html'), 'doc:docs/admin');
    assert.equal(factKey('url', 'https://www.aem.live/docs/limits#rate-limits'), 'doc:docs/limits');
    assert.equal(factKey('url', 'https://aem.live/developer/byo-git/'), 'doc:developer/byo-git');
    // A documentation site's page, in any language, is one page.
    assert.equal(
      factKey('url', 'https://experienceleague.adobe.com/ja/docs/some-product/guide?lang=ja'),
      'doc:experienceleague.adobe.com/en/docs/some-product/guide',
    );
    assert.equal(factKey('url', 'https://github.com/fake-org/edge/pull/57/files#diff'), 'url:github.com/fake-org/edge/pull/57');
    assert.equal(factKey('url', 'https://github.com/Fake-Org/Edge.git'), 'repo:fake-org/edge');
    assert.equal(factKey('url', 'https://tools.aem.live/tools/user-admin/index.html'), 'tool:user-admin');
    assert.equal(factKey('url', 'https://www.shop.example.net/scripts/cart.js:35:18'), null);
    assert.equal(factKey('url', 'https://www.shop.fake/scripts/cart.js:35:18'), 'url:shop.fake/scripts/cart.js');
    assert.equal(factKey('affected_url', 'status.fake-cdn.net/incidents/1'), 'url:status.fake-cdn.net/incidents/1');
    assert.equal(factKey('error', '403 Forbidden'), 'http_status:403');
    assert.equal(factKey('error', 'Account not authorized for this site'), 'error:account not authorized for this site');
    assert.equal(factKey('header', 'x-error: \\[admin] failed'), 'header:x-error: [admin] failed');
    assert.equal(factKey('ticket', 'eds-55'), 'ticket:EDS-55');
    assert.equal(factKey('site', 'Fake-Org/Site-A'), 'site:fake-org/site-a');
  });

  it('names nothing with a placeholder, a generic host, a front page or free text', () => {
    for (const [field, value] of [
      ['site', 'org/site'], ['repo', '{owner}/{repo}'], ['site', 'your-org/your-site'],
      ['url', 'https://main'], ['url', 'http://workers.dev'], ['url', 'http://localhost:3000/x'],
      ['url', 'https://gmail.com/x'], ['url', 'https://schema.org/Product'], ['url', 'http://github.com'],
      ['url', 'https://www.aem.live/docs/#build'], ['url', 'https://10.0.0.1/x'],
      ['url', 'https://nam04.safelinks.protection.outlook.com/?url=x'], ['url', 'mailto:a@b.fake'],
      ['problem', 'The pages are slow'], ['deadline', '2026-11-02'], ['go_live', '2026-11-02'],
      ['doc', 'faq'],
    ]) {
      assert.equal(factKey(field, value), null, `${field} ${value}`);
    }
    // A customer's own front page is a page of theirs, all the same.
    assert.equal(factKey('url', 'http://shop.fake'), 'url:shop.fake');
  });

  it('shows a key as its value, with the page of a doc or a link', () => {
    assert.deepEqual(factOf('doc:docs/limits'), {
      field: 'doc', value: 'docs/limits', label: 'docs/limits', href: 'https://www.aem.live/docs/limits',
    });
    assert.equal(factOf('doc:experienceleague.adobe.com/en/docs/x').href, 'https://experienceleague.adobe.com/en/docs/x');
    assert.equal(factOf('url:github.com/fake-org/edge/pull/57').href, 'https://github.com/fake-org/edge/pull/57');
    assert.equal(factOf('repo:fake-org/edge').href, 'https://github.com/fake-org/edge');
    assert.equal(factOf('http_status:404').href, null);
  });
});

describe('fact weights: tf-idf (src/factweights.js)', () => {
  // 100 threads: a status code in 60 of them (and the only one most have), a doc in 8 of the 30
  // with a doc, a pull request in 3, and links of their own in 40, one of them in no other.
  const rows = [];
  const add = (i, field, value) => rows.push({
    thread: `t${i}`, field, value, org: `org${i % 10}`,
  });
  for (let i = 0; i < 100; i += 1) {
    [
      [i < 60, 'http_status', i < 50 ? '404' : '500'],
      [i < 30, 'doc', i < 8 ? 'docs/limits' : `docs/page-${i}`],
      [i < 8, 'url', 'https://www.aem.live/docs/limits'],
      [i >= 90 && i < 93, 'url', 'https://github.com/fake-org/edge/pull/5'],
      [i >= 50 && i < 90, 'url', `https://shop.fake/p${i % 20}`],
      [i === 99, 'url', 'https://shop.fake/one'],
      [true, 'problem', `problem ${i}`],
    ].filter(([has]) => has).forEach(([, field, value]) => add(i, field, value));
  }
  const { of, weights } = factWeights(rows, { threads: 120 });

  it('weighs rare values high, values most threads have low, and skips what names nothing', () => {
    const w = (k) => weights.get(k).weight;
    assert.equal(w('url:shop.fake/one'), 1);
    assert.ok(w('url:github.com/fake-org/edge/pull/5') > w('doc:docs/limits'));
    assert.ok(w('doc:docs/limits') > 0.2, w('doc:docs/limits'));
    // A status code: rare among all threads, but one of two among those with one.
    assert.ok(w('http_status:404') < 0.1, w('http_status:404'));
    assert.ok(w('http_status:404') < w('http_status:500'));
    assert.equal([...weights.keys()].some((k) => k.startsWith('problem:')), false);
  });

  it('counts a thread once per key, and the customers of its threads', () => {
    // The doc as the rule wrote it and as a link: one key, once.
    assert.deepEqual([...of.get('t0')], ['http_status:404', 'doc:docs/limits']);
    assert.equal(weights.get('doc:docs/limits').threads, 8);
    assert.equal(weights.get('doc:docs/limits').orgs, 8);
    assert.equal(weights.get('url:github.com/fake-org/edge/pull/5').orgs, 3);
    assert.equal(weights.get('url:shop.fake/one').orgs, 1);
  });
});
