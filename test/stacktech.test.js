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
import { checkStackTech, fixStackTech } from '../src/stacktech.js';
import { parseStack } from '../src/stack.js';
import { splitFrontmatter } from '../src/agent/okf.js';
import { d1 } from './d1.js';

const stack = (rows) => `---\ntype: Stack Drawing\ntitle: Tech stack of Acme\ndescription: x\nstatus: stable\n---\n\nHow it is put together.\n\n## Parts\n\n| Layer | Part | Tech | Kind |\n| --- | --- | --- | --- |\n${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n`;
const parts = (text) => parseStack(splitFrontmatter(text).body).parts.map((p) => [p.name, p.tech]);

const ROWS = [
  {
    tech: 'cloudflare/cdn', name: 'Cloudflare', description: 'Cloudflare as CDN', aliases: 'Cloudflare CDN', enabled: 1,
  },
  {
    tech: 'microsoft/sharepoint', name: 'SharePoint', description: 'SharePoint as the content source', aliases: 'SharePoint Online', enabled: 1,
  },
  {
    tech: 'adobe/aem-sites/edge-delivery', name: 'Edge Delivery', description: 'Edge Delivery', aliases: 'EDS', enabled: 1,
  },
];

describe('a stack drawing\'s technologies', () => {
  it('are the catalog\'s: moved ids follow, covered names are filled in, own and people stay', () => {
    const text = stack([
      ['edge', 'Cloudflare', '', ''],
      ['site', 'Edge Delivery', 'eds', ''],
      ['content', 'SharePoint Online', '', 'storage'],
      ['commerce', 'Their PIM', 'own', 'storage'],
      ['other', 'Cloudflare fan', '', 'person'],
      ['other', 'Something else', 'nope', ''],
    ]);
    const r = fixStackTech(text, ROWS, { eds: 'adobe/aem-sites/edge-delivery' });
    assert.deepEqual(parts(r.text), [
      ['Cloudflare', 'cloudflare/cdn'], ['Edge Delivery', 'adobe/aem-sites/edge-delivery'],
      ['SharePoint Online', 'microsoft/sharepoint'], ['Their PIM', 'own'], ['Cloudflare fan', null], ['Something else', 'nope'],
    ]);
    assert.deepEqual(r.filled.map((f) => f.part), ['Cloudflare', 'SharePoint Online']);
    assert.deepEqual(r.moved, [{ part: 'Edge Delivery', from: 'eds', tech: 'adobe/aem-sites/edge-delivery' }]);
    assert.deepEqual(r.unknown, [{ part: 'Something else', tech: 'nope' }]);
    // Its other frontmatter and its title stay.
    assert.match(r.text, /title: Tech stack of Acme/);
    assert.match(r.text, /status: stable/);
    // Nothing to change: the text as it was.
    const same = stack([['edge', 'Cloudflare', 'cloudflare/cdn', '']]);
    assert.equal(fixStackTech(same, ROWS).text, same);
  });

  it('are checked on a write: an id no team has is refused for an agent, kept for a person', async () => {
    const DB = d1();
    const env = { DB };
    const bad = [{ path: 'stack.md', content: stack([['edge', 'Thing', 'nope', ''], ['edge', 'Akamai CDN', '', '']]) }];
    assert.match((await checkStackTech(env, bad)).error, /no team has the technology nope \(part Thing\)/);
    const r = await checkStackTech(env, bad, { staff: true });
    assert.deepEqual(r.filled, [{ part: 'Akamai CDN', tech: 'akamai' }]);
    assert.deepEqual(parts(r.changes[0].content), [['Thing', 'nope'], ['Akamai CDN', 'akamai']]);
    const other = [{ path: 'sites/www.md', content: 'x' }];
    assert.equal((await checkStackTech(env, other)).changes, other);
  });
});
