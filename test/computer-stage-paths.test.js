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
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/computer-stage.yml';

/** The `paths` of the workflow's `push` trigger, in order. */
async function pathsOf() {
  const lines = (await readFile(join(root, WORKFLOW), 'utf8')).split('\n');
  const start = lines.indexOf('    paths:');
  assert.ok(start > 0, `${WORKFLOW} has no push paths`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^ {6}- '([^']+)'$/);
    if (!m) {
      break;
    }
    out.push(m[1]);
  }
  return out;
}

/** A GitHub filter pattern as a regular expression: `**` is any path, `*` any name. */
const globOf = (pattern) => new RegExp(`^${pattern
  .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  .replace(/\*\*/g, '\0')
  .replace(/\*/g, '[^/]*')
  .replace(/\0/g, '.*')}$`);

/** Whether `file` runs the workflow: the last pattern that matches it says, `!` excludes. */
const runs = (patterns, file) => patterns.reduce((on, p) => {
  const not = p.startsWith('!');
  return globOf(not ? p.slice(1) : p).test(file) ? !not : on;
}, false);

/** The files of the repository the computer is made of: what its Worker and checks import. */
async function importsOf() {
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: ['scripts/dev-computer/worker.mjs', 'scripts/dev-computer/check.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    external: ['cloudflare:*'],
    metafile: true,
    write: false,
    outdir: 'out',
    logLevel: 'silent',
  });
  return Object.keys(metafile.inputs).sort();
}

describe('the Computer on stage workflow', () => {
  it('runs when a file the computer imports changes, and not for the rest of src/', async () => {
    const patterns = await pathsOf();
    const imports = await importsOf();
    assert.ok(imports.includes('src/agent/agent.js') && imports.includes('src/agent/kernel.js'));
    const missing = imports.filter((f) => !runs(patterns, f));
    assert.deepEqual(missing, [], `add to the paths of ${WORKFLOW}: ${missing.join(', ')}`);
    const src = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' })
      .trim().split('\n');
    const extra = src.filter((f) => runs(patterns, f) && !imports.includes(f));
    assert.deepEqual(extra, [], `the computer does not import these, take them out of ${WORKFLOW}`);
  });

  it('runs for the packages and itself, and not for the pages, the docs or the tests', async () => {
    const patterns = await pathsOf();
    for (const f of [WORKFLOW, 'package.json', 'package-lock.json', 'scripts/computer-images.mjs',
      'scripts/dev-computer/wrangler.json', 'scripts/dev-computer/dev.mjs']) {
      assert.ok(runs(patterns, f), f);
    }
    for (const f of ['ui/inbox.js', 'ui/spectrum.css', 'src/page.js', 'src/api.js', 'README.md',
      'docs/ARCHITECTURE.md', 'test/computer-check.test.js', 'src/agent/stub.js']) {
      assert.ok(!runs(patterns, f), f);
    }
  });
});
