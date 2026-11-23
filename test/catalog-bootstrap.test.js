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
import { bootstrapFiles, compare } from '../scripts/catalog-bootstrap-lib.mjs';
import { checkCatalog } from '../src/catalog.js';
import { d1 } from './d1.js';

describe('the catalog bootstrap', () => {
  it('writes every technology of the tech stack as a catalog file that keeps it as it was', () => {
    const rows = d1().rows('SELECT team, tech, name, description, product, aliases, layer, enabled FROM tech_stack');
    const { teams } = bootstrapFiles(rows);
    for (const [team, files] of Object.entries(teams)) {
      for (const [path, text] of Object.entries(files)) {
        assert.equal(checkCatalog(path, text), null, `${team} ${path}`);
      }
    }
    const { report, rows: compiled } = compare(rows, teams);
    assert.ok(report.length > 50);
    assert.deepEqual(report.filter((r) => r.missing), []);
    // Nothing changes but the id (and where its product comes from), except what G3 moves.
    assert.deepEqual(report.filter((r) => r.changed.length).map((r) => [r.old, r.changed]), [['eds', ['aliases']]]);
    const eds = report.find((r) => r.old === 'eds');
    assert.deepEqual([eds.tech, eds.team], ['adobe/aem-sites/edge-delivery', 'helix']);
    assert.doesNotMatch(compiled.get('adobe/aem-sites/edge-delivery').aliases, /Managed CDN/);
    assert.match(compiled.get('adobe/aem-sites/managed-cdn').aliases, /Adobe Managed CDN/);
    assert.equal(compiled.get('adobe/aem-sites/edge-delivery').product, 'Experience Manager Sites');
    assert.equal(compiled.get('adobe/aem-sites/managed-cdn').product, 'Experience Manager Sites');
    assert.equal(report.find((r) => r.old === 'fastly').team, 'cdn');
  });
});
