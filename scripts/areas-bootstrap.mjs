#!/usr/bin/env node
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
 * `npm run areas:bootstrap -- --out <file>`: the built-in areas (src/label.js TOPICS) as files of
 * kb-team-admin (src/areas.js), `[{ repo, path, content }]`, as the knowledge-base editor's API
 * takes them. Written, they are what Clef asks from then on, the same questions with the same ids,
 * so labels go on as they were; people change them from there.
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { areaFile } from '../src/areas.js';
import { BUILT_IN_AREAS } from '../src/label.js';

const { values: args } = parseArgs({ options: { out: { type: 'string' } } });
const changes = BUILT_IN_AREAS.map((a) => ({
  repo: 'kb-team-admin',
  path: `areas/${a.id}.md`,
  content: areaFile({ title: a.name, what: a.what }, `${a.name}: one of the areas the inbox started with.`),
}));
const json = `${JSON.stringify(changes, null, 2)}\n`;
if (args.out) {
  writeFileSync(args.out, json);
  console.log(`${changes.length} areas in ${args.out}`);
} else {
  process.stdout.write(json);
}
