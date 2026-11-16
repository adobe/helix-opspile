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
import { checkChanges } from '../src/agent/kbwrite.js';
import { checkConcept } from '../src/agent/okf.js';
import { api, orgStacks } from '../src/api.js';
import { checkTech, saveTech } from '../src/extract.js';
import { vocab } from '../src/label.js';
import {
  checkStack, layerOf, LAYERS, parseStack, stackFile, stackView, techLayers,
} from '../src/stack.js';
import { d1 } from './d1.js';
import { fakeRepo } from './fakes.js';
import { SCRIPTS } from './ui.js';

// Made-up customers, people and systems only.
const DRAWING = {
  summary: 'ACME sells on Edge Delivery behind Akamai. Orders go to their ERP.',
  parts: [
    {
      layer: 'commerce', name: 'Their ERP', tech: 'erp', note: 'orders | invoices',
    },
    {
      layer: 'edge', name: 'Akamai', tech: 'akamai', note: '[www.acme.example](https://www.acme.example/)',
    },
    {
      layer: 'Site', name: 'Edge Delivery', tech: 'eds', note: 'the shop, `acme/shop`',
    },
    { layer: 'content', name: 'Document Authoring', tech: 'da' },
    { layer: 'code', name: 'Order sync', note: 'every 5 minutes' },
  ],
  flows: [
    { from: 'Akamai', to: 'Edge Delivery', label: 'every page' },
    { from: 'Order sync', to: 'Their ERP', label: 'orders' },
  ],
};

describe('stack drawings', () => {
  it('are Markdown that reads as it is: a summary, the parts by layer, the flows', () => {
    const file = stackFile(DRAWING, { title: 'Tech stack of ACME' });
    assert.equal(file, `---
type: Tech Stack
title: Tech stack of ACME
description: ACME sells on Edge Delivery behind Akamai.
---

ACME sells on Edge Delivery behind Akamai. Orders go to their ERP.

## Parts

| Layer | Part | Tech | Note |
| --- | --- | --- | --- |
| Edge | Akamai | akamai | [www.acme.example](https://www.acme.example/) |
| Site | Edge Delivery | eds | the shop, \`acme/shop\` |
| Content | Document Authoring | da | |
| Code | Order sync | | every 5 minutes |
| Commerce and data | Their ERP | erp | orders \\| invoices |

## Flows

| From | To | What |
| --- | --- | --- |
| Akamai | Edge Delivery | every page |
| Order sync | Their ERP | orders |
`);
    // Read back as written, and written again the same.
    const read = parseStack(file);
    assert.equal(read.summary, 'ACME sells on Edge Delivery behind Akamai. Orders go to their ERP.');
    assert.deepEqual(read.parts.map((p) => [p.layer, p.name, p.tech, p.note]), [
      ['edge', 'Akamai', 'akamai', '[www.acme.example](https://www.acme.example/)'],
      ['site', 'Edge Delivery', 'eds', 'the shop, `acme/shop`'],
      ['content', 'Document Authoring', 'da', ''],
      ['code', 'Order sync', null, 'every 5 minutes'],
      ['commerce', 'Their ERP', 'erp', 'orders | invoices'],
    ]);
    assert.deepEqual(read.flows, DRAWING.flows);
    assert.equal(stackFile(read, { title: 'Tech stack of ACME' }), file);
  });

  it('keep what else the file had: its frontmatter, and notes after the tables', () => {
    const keep = 'title: Old\ntags: [cdn]\nsources:\n  - id: t1\n    resource: https://chat.example/p1\ngenerated: { by: x, at: y }';
    const file = stackFile({ ...DRAWING, notes: '## Open questions\n\n- Which CDN for the B2B shop?' }, { keep });
    assert.match(file, /^---\ntype: Tech Stack\ntitle: Tech stack\ndescription: [^\n]+\ntags: \[cdn\]\nsources:\n {2}- id: t1\n {4}resource: https:\/\/chat\.example\/p1\n---\n/);
    assert.equal(parseStack(file).notes, '## Open questions\n\n- Which CDN for the B2B shop?');
    // Text a person put between a heading and its table is kept with the notes too.
    const edited = file.replace('## Flows\n', '## Flows\n\nAs of November.\n');
    assert.equal(parseStack(edited).flows.length, 2);
    assert.match(parseStack(edited).notes, /^As of November\.\n\n## Open questions/);
  });

  it('say what is wrong with one, for whoever wrote it', () => {
    const body = (parts, flows = '') => `Summary.\n\n## Parts\n\n| Layer | Part | Tech |\n| --- | --- | --- |\n${parts}\n${flows ? `\n## Flows\n\n| From | To |\n| --- | --- |\n${flows}\n` : ''}`;
    assert.match(checkStack('Just text.'), /"## Parts" heading with a table/);
    assert.match(checkStack('## Parts\n\n| Name | What |\n| --- | --- |\n| a | b |\n'), /columns Layer and Part/);
    assert.match(checkStack(body('| Basement | DB | |')), /parts, row 1: the layer is one of Edge, Site, Content, Code/);
    assert.match(checkStack(body('| Edge | Akamai | |\n| Site | akamai | |')), /parts, row 2: there is another part called akamai/);
    assert.match(checkStack(body('| Edge | Akamai | Akamai CDN |')), /Tech is the id of a technology/);
    assert.match(checkStack(body('| Edge | Akamai | |', '| Akamai | Fastly |')), /flows, row 1: From and To are the names of parts/);
    assert.match(checkStack(body('| Edge | Akamai | |', '| Akamai | akamai |')), /from one part to another/);
    assert.match(checkStack(body(Array.from({ length: 41 }, (_, i) => `| Site | p${i} | |`).join('\n'))), /at most 40 parts/);
    assert.equal(checkStack(body('| Edge | Akamai | akamai |', '')), null);
    // Layers by id or name, in any case.
    assert.equal(layerOf('commerce AND data').id, 'commerce');
    assert.equal(layerOf('martech').name, 'Marketing and insights');
    assert.equal(layerOf('cdn'), null);
  });

  it('are refused as stack.md when they cannot be drawn, by agents and people alike', () => {
    const bad = '---\ntype: Tech Stack\n---\n\nNo tables.\n';
    assert.match(checkConcept('stack.md', bad), /^not a stack drawing: a stack drawing has a "## Parts" heading/);
    assert.match(checkChanges([{ path: 'stack.md', content: bad }], { staff: true }), /^stack\.md: not a stack drawing/);
    assert.equal(checkConcept('stack.md', stackFile(DRAWING)), null);
    // Elsewhere, a concept of that type is any concept.
    assert.equal(checkConcept('sites/stack.md', bad), null);
  });

  it('are drawn by layer, top to bottom, leaving out the empty ones', () => {
    const view = stackView(parseStack(stackFile(DRAWING)));
    assert.deepEqual(view.layers.map((l) => [l.id, l.name, l.parts.map((p) => p.name)]), [
      ['edge', 'Edge', ['Akamai']],
      ['site', 'Site', ['Edge Delivery']],
      ['content', 'Content', ['Document Authoring']],
      ['code', 'Code', ['Order sync']],
      ['commerce', 'Commerce and data', ['Their ERP']],
    ]);
    assert.deepEqual(LAYERS.map((l) => l.id), ['edge', 'site', 'content', 'code', 'commerce', 'martech', 'identity', 'other']);
  });
});

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

describe('GET /api/kb/stack', () => {
  const ADMIN = {
    id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'admin' }, { slug: 'helix' }],
  };
  const OUTSIDER = {
    id: 3, email: 'cy@staff.example', name: 'Cy', teams: [{ slug: 'edge' }],
  };
  const call = (env, me, path) => {
    const url = new URL(`https://opspile.example${path}`);
    return api(new Request(url), env, url, { viewer: me });
  };

  it('draws the customer\'s stack.md for whoever may read its knowledge base', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }] });
    DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
      ('kb-org-acme', 'org', 'acme', 'r', '2026-10-22T00:00:00Z'),
      ('kb-org-globex', 'org', 'globex', 'r', '2026-10-22T00:00:00Z'),
      ('kb-org-initech', 'org', 'initech', 'r', '2026-10-22T00:00:00Z')`);
    const drawn = stackFile(DRAWING).replace('---\n\n', 'generated: { by: opspile-agent/m, at: 2026-11-10T09:00:00Z }\n---\n\n');
    const repos = {
      'kb-org-acme': { 'stack.md': drawn },
      'kb-org-globex': { 'sites/www.md': '---\ntype: Site\n---\n' },
      'kb-org-initech': { 'stack.md': '---\ntype: Tech Stack\n---\n\nNo tables.\n' },
    };
    const env = { DB, ARTIFACTS: { get: async (name) => fakeRepo(repos[name]) } };
    const res = await (await call(env, ADMIN, '/api/kb/stack?org=acme')).json();
    assert.equal(res.repo, 'kb-org-acme');
    assert.equal(res.path, 'stack.md');
    assert.equal(res.by, 'opspile-agent/m');
    assert.equal(res.at, '2026-11-10T09:00:00Z');
    assert.equal(res.may, true);
    assert.deepEqual(res.drawing.layers.map((l) => l.id), ['edge', 'site', 'content', 'code', 'commerce']);
    assert.deepEqual(res.drawing.flows, DRAWING.flows);
    // None yet, or one that cannot be drawn: no drawing, and why.
    assert.equal((await (await call(env, ADMIN, '/api/kb/stack?org=globex')).json()).drawing, null);
    const broken = await (await call(env, ADMIN, '/api/kb/stack?org=initech')).json();
    assert.equal(broken.drawing, null);
    assert.match(broken.error, /"## Parts" heading/);
    // Nobody else's, and no customer without a knowledge base.
    assert.equal((await call(env, OUTSIDER, '/api/kb/stack?org=acme')).status, 404);
    assert.equal((await call(env, ADMIN, '/api/kb/stack?org=nope')).status, 404);
    assert.equal((await call(env, ADMIN, '/api/kb/stack?org=_unassigned')).status, 404);
  });
});

describe('ui/stack.js', () => {
  // eslint-disable-next-line no-new-func
  const Stack = new Function('globalThis', `${SCRIPTS['stack.js']}\nreturn globalThis.Stack;`)({});
  const order = LAYERS.map(({ id, name }) => ({ id, name }));

  it('draws a customer without a drawing from what Clef saw, by layer', () => {
    const view = Stack.fromDetected([
      { tech: 'eds', name: 'Edge Delivery', p: 1 },
      { tech: 'akamai', name: 'Akamai', p: 0.9 },
      { tech: 'nope', name: 'Nope', p: 0.85 },
    ], { eds: 'site', akamai: 'edge' }, order);
    assert.deepEqual(view.layers.map((l) => [l.id, l.parts.map((p) => `${p.name} ${p.note}`)]), [
      ['edge', ['Akamai 90% sure']], ['site', ['Edge Delivery 100% sure']], ['other', ['Nope 85% sure']],
    ]);
    assert.deepEqual(view.flows, []);
  });

  it('writes everything it is given as text, and lists what Clef saw that it does not draw', () => {
    const view = stackView(parseStack(stackFile({
      summary: 'S',
      parts: [{
        layer: 'edge', name: 'A <b>CDN</b>', tech: 'akamai', note: '<img src=x onerror=alert(1)>',
      }],
    })));
    const html = Stack.html(view, {
      detected: [{ tech: 'akamai', name: 'Akamai', p: 0.9 }, { tech: 'da', name: 'Document <i>Authoring</i>', p: 0.8 }],
    });
    assert.doesNotMatch(html, /<b>CDN|<img|<i>/);
    assert.match(html, /<div class="stk-part stk-seen" tabindex="0" data-part="0" title="A &lt;b&gt;CDN&lt;\/b&gt;\nAkamai: 90% sure from their threads"><b>A &lt;b&gt;CDN&lt;\/b&gt;<\/b>/);
    assert.match(html, /<div class="stk-more"><span class="stk-mh">Also in their threads<\/span><span class="stk-chip" title="80% sure from their threads">Document &lt;i&gt;Authoring&lt;\/i&gt;<\/span><\/div>/);
  });
});
