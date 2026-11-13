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
 * Writes src/computer-image/: the programs of the agents' computers that run on the SLICC
 * kernel (src/agent/kernel.js), taken from the @ai-ecoverse/wasm-* packages (homescoop) this
 * repository pins. A Worker cannot read node_modules, and wrangler compiles a `.wasm` import
 * where the kernel needs its bytes, so every file is copied as `<n>.bin` (wrangler imports
 * `*.bin` as an ArrayBuffer), and `index.js` lists them by package and path, as
 * `PACKAGES`: what the kernel installs under /node_modules.
 *
 *   node scripts/computer-image.mjs
 *
 * The files are not committed: cloudflare.config.ts runs this on every cf deploy and cf dev,
 * and npm runs it before lint and test (`npm run build` by hand).
 */

import {
  mkdir, readFile, rm, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src', 'computer-image');

/**
 * The image: each package with all of its commands, or only those named (`commands`). What
 * just-bash has and this has not is in docs/ARCHITECTURE.md ("Agent tools"): jq is not here
 * because @ai-ecoverse/wasm-jq is built with threads, which the kernel has none of in a Worker.
 */
export const IMAGE = [
  { name: '@ai-ecoverse/wasm-bash' },
  { name: '@ai-ecoverse/wasm-coreutils' },
  { name: '@ai-ecoverse/wasm-grep' },
  { name: '@ai-ecoverse/wasm-sed' },
  { name: '@ai-ecoverse/wasm-gawk' },
  { name: '@ai-ecoverse/wasm-findutils' },
  { name: '@ai-ecoverse/wasm-diffutils', commands: ['diff', 'cmp'] },
  { name: '@ai-ecoverse/wasm-curl' },
  { name: '@ai-ecoverse/wasm-gzip' },
  { name: '@ai-ecoverse/wasm-tar' },
  { name: '@ai-ecoverse/wasm-zip', commands: ['unzip', 'zipinfo'] },
  { name: '@ai-ecoverse/wasm-tree' },
  { name: '@ai-ecoverse/wasm-which' },
  { name: '@ai-ecoverse/wasm-util-linux', commands: ['rev', 'column', 'hexdump'] },
];

/** The files of a command entry (`slicc.commands.<name>`), relative to its package. */
const filesOf = (entry) => [entry.glue, entry.wasm, entry.script, entry.module,
  ...(entry.variants || []).map((v) => v.wasm)].filter((f) => typeof f === 'string');

/**
 * One package of the image: its manifest with only the commands kept, and the paths of the
 * files those need, sorted.
 */
export function imagePackage(manifest, { commands } = {}) {
  const all = (manifest.slicc && manifest.slicc.commands) || {};
  const missing = (commands || []).filter((c) => !all[c]);
  if (missing.length) {
    throw new Error(`${manifest.name} has no command ${missing.join(', ')}`);
  }
  const kept = Object.fromEntries(Object.entries(all)
    .filter(([name]) => !commands || commands.includes(name)));
  const slim = {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    ...(manifest.type ? { type: manifest.type } : {}),
    slicc: { ...manifest.slicc, commands: kept },
  };
  const paths = [...new Set(Object.values(kept).flatMap(filesOf))].sort();
  return { manifest: slim, paths };
}

/** Builds src/computer-image/ from node_modules: `{ packages, files, bytes }`. */
export async function build({ modules = join(root, 'node_modules'), out = OUT } = {}) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const imports = [];
  const packages = [];
  let bytes = 0;
  for (const spec of IMAGE) {
    const dir = join(modules, spec.name);
    // eslint-disable-next-line no-await-in-loop
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const { manifest: slim, paths } = imagePackage(manifest, spec);
    const files = [];
    for (const path of paths) {
      // eslint-disable-next-line no-await-in-loop
      const data = await readFile(join(dir, path));
      const id = `f${imports.length}`;
      // eslint-disable-next-line no-await-in-loop
      await writeFile(join(out, `${id}.bin`), data);
      imports.push(`import ${id} from './${id}.bin';`);
      files.push(`      ${JSON.stringify(path)}: ${id},`);
      bytes += data.length;
    }
    packages.push(`  {
    name: ${JSON.stringify(spec.name)},
    manifest: ${JSON.stringify(JSON.stringify(slim, null, 2))},
    files: {
${files.join('\n')}
    },
  },`);
  }
  await writeFile(join(out, 'index.js'), `// Generated by scripts/computer-image.mjs from node_modules: do not edit, do not commit.
/* eslint-disable */
${imports.join('\n')}

export const PACKAGES = [
${packages.join('\n')}
];
`);
  return { packages: IMAGE.length, files: imports.length, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
