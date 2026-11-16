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

/**
 * The FMC visualization runner's gallery, which `npm run ui:dev` serves at /__dev/fmc: each good
 * example of the FMC visualization guidelines (scripts/fmc-figures.mjs), the original GIF from
 * fmc-modeling.org next to the runner's drawing of the same structure, and the stack drawings
 * of the fake data (scripts/dev-ui-kb.mjs) as the inbox draws them. The page draws them with
 * /inbox/fmc.js, as the inbox does, and says how long each took.
 */

import { readFile } from 'node:fs/promises';
import { page } from '../src/page.js';
import { parseStack, stackView } from '../src/stack.js';
import { SEED } from './dev-ui-kb.mjs';
import { FIGURES } from './fmc-figures.mjs';

const dir = new URL('./fmc-gallery/', import.meta.url);

/**
 * The fake data's drawings, and one of what Clef saw, as GET /api/kb/stack and the inbox give
 * them.
 */
export function galleryStacks() {
  const view = (repo) => stackView(parseStack(SEED[repo].files['stack.md']));
  return [{
    title: 'ACME, with kinds of parts and flows',
    note: 'People at the top, the site in a grey frame of its layers, someone else\'s system (Payments) outside it; storages rounded, request/response channels with R, read arrows, the authors\' modify access.',
    view: view('kb-org-acme'),
  }, {
    title: 'Umbrella: the same drawing as written before kinds',
    note: 'No Kind columns: every part an agent, every flow a channel the way the data goes; the visitors are added at the top.',
    view: view('kb-org-umbrella'),
  }, {
    title: 'Globex: no drawing, what Clef saw',
    note: 'Its technologies by layer, a layer model top to bottom, each with how sure Clef is.',
    view: {
      guess: true,
      summary: '',
      notes: '',
      flows: [],
      layers: [
        { id: 'edge', name: 'Edge', parts: [{ name: 'Akamai', tech: 'akamai', note: '90% sure' }] },
        { id: 'site', name: 'Site', parts: [{ name: 'Edge Delivery', tech: 'eds', note: '100% sure' }, { name: 'AEM Sites', tech: 'aem', note: '60% sure' }] },
        { id: 'content', name: 'Content', parts: [{ name: 'Document Authoring', tech: 'da', note: '80% sure' }, { name: 'SharePoint', tech: 'sharepoint', note: '70% sure' }] },
        { id: 'other', name: 'Other', parts: [{ name: 'Jira', tech: 'jira', note: '85% sure' }] },
      ],
    },
  }];
}

/** The gallery page, served as the Worker serves the pages (src/page.js `page`). */
export async function galleryPage(scripts) {
  const [html, css, js] = await Promise.all(['gallery.html', 'gallery.css', 'gallery.js']
    .map((f) => readFile(new URL(f, dir), 'utf8')));
  const data = `const FIGURES = ${JSON.stringify(FIGURES)};\nconst STACKS = ${JSON.stringify(galleryStacks())};\n`;
  return page(html, { ...scripts, 'fmc-gallery.css': css, 'fmc-gallery.js': `${data}${js}` });
}
