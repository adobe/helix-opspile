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
import { orgStacks } from '../src/api.js';
import { checkTech, saveTech } from '../src/extract.js';
import { vocab } from '../src/label.js';
import { layerOf, LAYERS, techLayers } from '../src/stack.js';
import { d1 } from './d1.js';

describe('a customer\'s tech stack', () => {
  it('is what its channels show, each technology at the highest probability of any', () => {
    assert.deepEqual(orgStacks([
      {
        thread: 'a', org: 'acme', tech: 'eds', p: 0.95,
      },
      {
        thread: 'b', org: 'acme', tech: 'eds', p: 1,
      },
      {
        thread: 'b', org: 'acme', tech: 'akamai', p: 0.8123,
      },
      {
        thread: 'c', org: 'globex', tech: 'da', p: 0.9,
      },
      {
        thread: 'd', org: null, tech: 'da', p: 0.9,
      },
    ]), {
      acme: [{ tech: 'eds', p: 1 }, { tech: 'akamai', p: 0.812 }],
      globex: [{ tech: 'da', p: 0.9 }],
    });
  });

  it('has each technology in a layer, the team\'s own or else the admin team\'s', async () => {
    assert.match(checkTech({
      tech: 'cdnx', name: 'CDN X', description: 'CDN X', layer: 'basement',
    }).error, /layer is one of edge, site/);
    assert.equal(checkTech({
      tech: 'cdnx', name: 'CDN X', description: 'CDN X', layer: 'edge',
    }).tech.layer, 'edge');
    const DB = d1();
    const env = { DB };
    await saveTech(env, 'admin', {
      tech: 'cdnx', name: 'CDN X', description: 'CDN X', layer: 'edge',
    }, 'Ada');
    // A team's own entry of the same id without a layer keeps the admin team's.
    await saveTech(env, 'helix', { tech: 'cdnx', name: 'Our CDN' }, 'Bo');
    await saveTech(env, 'helix', {
      tech: 'gitx', name: 'Git X', description: 'Git X', layer: 'code',
    }, 'Bo');
    const v = await vocab(env, 'helix');
    assert.equal(v.tech.cdnx, 'Our CDN');
    assert.equal(v.layers.cdnx, 'edge');
    assert.equal(v.layers.gitx, 'code');
    assert.deepEqual(v.stack[0], { id: 'edge', name: 'Edge' });
    // The migration put the admin team's in theirs.
    assert.equal(v.layers.akamai, 'edge');
    assert.equal(v.layers.da, 'content');
    assert.deepEqual(techLayers([{ tech: 'x', layer: 'nope' }, { tech: 'y', layer: 'site' }]), { y: 'site' });
  });
});

describe('the layers of a stack', () => {
  it('go top to bottom, by id or name, in any case', () => {
    assert.deepEqual(LAYERS.map((l) => l.id), ['edge', 'site', 'content', 'code', 'commerce', 'martech', 'identity', 'other']);
    assert.equal(layerOf('commerce AND data').id, 'commerce');
    assert.equal(layerOf('martech').name, 'Marketing and insights');
    assert.equal(layerOf('cdn'), null);
  });
});
