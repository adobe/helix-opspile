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
import { queryParts } from '../src/agent/channelfind.js';

describe('channelfind queryParts', () => {
  it('keeps the words that name a company, not those every company has', () => {
    assert.deepEqual(queryParts('ACME TECHNOLOGIES - WWW'), { words: ['acme', 'www'], sites: [] });
    assert.deepEqual(queryParts('Acme Corp, Inc.'), { words: ['acme'], sites: [] });
    assert.deepEqual(queryParts('a b 12345'), { words: [], sites: [] });
  });

  it('reads a site or repository, an Edge Delivery host and a domain', () => {
    assert.deepEqual(queryParts('acme/www'), { words: ['acme'], sites: ['acme/www'] });
    assert.deepEqual(
      queryParts('https://main--www--acme.aem.page/de/page'),
      { words: ['acme'], sites: ['acme/www'] },
    );
    assert.deepEqual(queryParts('feature--shop--acme-eu.hlx.live'), { words: ['acme'], sites: ['acme-eu/shop'] });
    assert.deepEqual(queryParts('https://www.acme.com/products'), { words: ['acme'], sites: [] });
    assert.deepEqual(queryParts('ada@acme.co.uk'), { words: ['ada', 'acme'], sites: [] });
  });
});
