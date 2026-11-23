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
 * `npm run catalog:bootstrap -- --database <D1 id> --out <dir>`: the teams' catalogs as the tech
 * stack in D1 has it (scripts/catalog-bootstrap-lib.mjs), read-only. It writes each team's files
 * under `<dir>/<team>/products/…`, `changes.json` (`[{ repo, path, content }]`, what the
 * knowledge-base editor's API takes, one file per write) and prints what each technology
 * becomes. Writing them is a write to production: the files go through the editor (or its API,
 * `PUT /api/kb/file`), as an admin, so that each write compiles.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { bootstrapFiles, compare } from './catalog-bootstrap-lib.mjs';

const { values: args } = parseArgs({
  options: { database: { type: 'string' }, profile: { type: 'string' }, out: { type: 'string' } },
});
if (!args.database || !args.out) {
  console.error('usage: npm run catalog:bootstrap -- --database <D1 id> --out <dir> [--profile <cf profile>]');
  process.exit(1);
}

const profile = args.profile ? ['--profile', args.profile] : [];
const rows = JSON.parse(execFileSync('cf', ['d1', 'query', args.database, '-q', ...profile, '--sql',
  'SELECT team, tech, name, description, product, aliases, layer, enabled FROM tech_stack WHERE path IS NULL'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}))[0].results;

const { teams, skipped } = bootstrapFiles(rows);
const changes = [];
for (const [team, files] of Object.entries(teams).sort()) {
  for (const [path, content] of Object.entries(files).sort()) {
    const file = join(args.out, team, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    changes.push({ repo: `kb-team-${team}`, path, content });
  }
}
writeFileSync(join(args.out, 'changes.json'), `${JSON.stringify(changes, null, 2)}\n`);

const { report } = compare(rows, teams);
console.log(`${rows.length} rows in D1, ${changes.length} files in ${Object.keys(teams).length} knowledge bases`);
for (const [team, files] of Object.entries(teams).sort()) {
  console.log(`  kb-team-${team}: ${Object.keys(files).length}`);
}
if (skipped.length) {
  console.log(`no place for ${skipped.join(', ')}: a category of its team's`);
}
for (const r of report) {
  if (r.missing) {
    console.log(`  ${r.old}: MISSING`);
  } else {
    const product = r.product[0] === r.product[1] ? '' : `  product ${r.product[0]} → ${r.product[1]}`;
    console.log(`  ${r.old.padEnd(15)} → ${r.tech.padEnd(38)} ${r.team.padEnd(20)}${r.changed.length ? ` changed: ${r.changed.join(', ')}` : ''}${product}`);
  }
}
