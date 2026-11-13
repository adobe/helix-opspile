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
 * The images of the agents' computers on the SLICC kernel (src/agent/image.js): which
 * programs a computer has, by what it is for. An image is built from the @ai-ecoverse/wasm-*
 * packages (homescoop) this repository pins, and lives in the `IMAGES` bucket, not in the
 * Worker: a kernel installs its team's image from there when it boots.
 *
 *   node scripts/computer-images.mjs --out <dir>             # the bucket's objects, as files
 *   node scripts/computer-images.mjs --upload --mode prod    # to helix-opspile-images
 *   node scripts/computer-images.mjs --upload --mode stage --dry-run
 *   node scripts/computer-images.mjs --upload --local        # for `cf dev`: its local bucket
 *
 * In the bucket (`objectsOf`):
 * - `blobs/<sha256>`: one file of a package, by its content, so images share what they have
 *   in common, and an upload sends only what is new;
 * - `images/<name>.json`: an image's manifest (`v` 1): its packages, each with the manifest
 *   the kernel reads its commands from and its files (`path`, `sha256`, `size`), what the
 *   agent is told it has (`tools`), and `digest`, which names exactly these contents. An
 *   Emscripten program's JavaScript glue is there as an empty file: in a Worker the kernel
 *   runs the program without it, but finds the command by it;
 * - `images/index.json`: the images there are, for the knowledge-base editor.
 *
 * `--upload` asks the bucket what it has (the index and its manifests) and sends the blobs no
 * manifest there names, then the manifests, then the index: a kernel that boots meanwhile
 * finds an image whole, the old one or the new. It never deletes: a blob no image names any
 * more stays. It runs `cf` (the account of its profile, or CLOUDFLARE_ACCOUNT_ID), after the
 * deploy, which makes the bucket.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What every image has: the shell, the text tools, archives and curl. */
const BASE = [
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
  { name: '@ai-ecoverse/wasm-zip' },
  { name: '@ai-ecoverse/wasm-tree' },
  { name: '@ai-ecoverse/wasm-which' },
  { name: '@ai-ecoverse/wasm-util-linux', commands: ['rev', 'column', 'hexdump'] },
];

const BASE_TOOLS = 'coreutils (cat, sort, uniq, head, tail, cut, tr, wc, base64, sha256sum, date and the rest), grep, sed, awk (gawk), find, xargs, diff, cmp, tar, gzip, zip, unzip, tree, column, rev, hexdump, curl';

/**
 * The images: `name` is what a team's choice stores, `title` and `description` are for the
 * people who choose, `tools` is what the agent is told it has (every word of it a command of
 * the image: `build` checks), and each package comes with all of its commands or those named.
 * jq is in none yet: @ai-ecoverse/wasm-jq needs a kernel that runs programs linked with
 * pthreads.
 */
export const IMAGES = [
  {
    name: 'base',
    title: 'Base',
    description: 'GNU bash, coreutils, grep, sed, gawk, find, diff, tar, gzip, zip and curl:'
      + ' for reading logs and text, and asking APIs.',
    tools: BASE_TOOLS,
    packages: BASE,
  },
  {
    name: 'data',
    title: 'Data',
    description: 'Base, with ripgrep, sqlite3 and strings: for searching many files and'
      + ' querying CSV or JSON as tables.',
    tools: `${BASE_TOOLS}, rg, sqlite3, strings`,
    packages: [
      ...BASE,
      { name: '@ai-ecoverse/wasi-ripgrep' },
      { name: '@ai-ecoverse/wasm-sqlite3' },
      { name: '@ai-ecoverse/wasm-binutils', commands: ['strings'] },
    ],
  },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The files of a command entry (`slicc.commands.<name>`), relative to its package. */
const filesOf = (entry) => [entry.glue, entry.wasm, entry.script, entry.module,
  ...(entry.variants || []).map((v) => v.wasm)].filter((f) => typeof f === 'string');

/**
 * One package of an image: its manifest with only the commands kept, the paths of the files
 * those need, sorted, and which of them are glue.
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
  const glue = [...new Set(Object.values(kept).map((c) => c.glue).filter(Boolean))].sort();
  return { manifest: slim, paths, glue };
}

/** The programs `tools` names: its words, without what stands in brackets as a gloss. */
export const toolNames = (tools) => tools.replace(/\((gawk)\)/g, '')
  .replace(/ and the rest/g, '')
  .split(/[\s,()]+/)
  .filter((w) => w && w !== 'and');

/**
 * Builds `images` (IMAGES) from `modules` (node_modules): `{ images, blobs }`, `images` the
 * manifests as the bucket has them, `blobs` the files by their sha256.
 */
export async function build({ modules = join(root, 'node_modules'), images = IMAGES } = {}) {
  const blobs = new Map();
  const packed = new Map();
  const pack = async (spec) => {
    const dir = join(modules, spec.name);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const { manifest: slim, paths, glue } = imagePackage(manifest, spec);
    const files = [];
    for (const path of paths) {
      // eslint-disable-next-line no-await-in-loop
      const data = glue.includes(path) ? Buffer.alloc(0) : await readFile(join(dir, path));
      const hash = sha256(data);
      // An empty file needs no object: the kernel is given no bytes for it.
      if (data.length) {
        blobs.set(hash, data);
      }
      files.push({ path, sha256: hash, size: data.length });
    }
    return {
      name: spec.name,
      version: manifest.version,
      manifest: JSON.stringify(slim, null, 2),
      commands: Object.keys(slim.slicc.commands).sort(),
      files,
    };
  };
  const out = [];
  for (const image of images) {
    const packages = [];
    for (const spec of image.packages) {
      const key = JSON.stringify(spec);
      // eslint-disable-next-line no-await-in-loop
      packed.set(key, packed.get(key) || await pack(spec));
      packages.push(packed.get(key));
    }
    const commands = new Set(packages.flatMap((p) => p.commands));
    const unknown = toolNames(image.tools).filter((w) => !commands.has(w));
    if (unknown.length) {
      throw new Error(`image ${image.name} tells the agent of ${unknown.join(', ')}, which it has not`);
    }
    out.push({
      v: 1,
      name: image.name,
      title: image.title,
      description: image.description,
      tools: image.tools,
      digest: sha256(JSON.stringify(packages)),
      bytes: packages.flatMap((p) => p.files).reduce((n, f) => n + f.size, 0),
      packages,
    });
  }
  return { images: out, blobs };
}

/** The index of `images` (their manifests): what the knowledge-base editor lists. */
export const indexOf = (images) => ({
  v: 1,
  images: images.map(({
    name, title, description, digest, bytes,
  }) => ({
    name, title, description, digest, bytes,
  })),
});

/** What `build` made, as the bucket's objects, in upload order: `[{ key, body, type }]`. */
export function objectsOf({ images, blobs }) {
  const json = (key, value) => ({ key, body: `${JSON.stringify(value)}\n`, type: 'application/json' });
  return [
    ...[...blobs].sort(([a], [b]) => a.localeCompare(b))
      .map(([hash, body]) => ({ key: `blobs/${hash}`, body, type: 'application/octet-stream' })),
    ...images.map((image) => json(`images/${image.name}.json`, image)),
    json('images/index.json', indexOf(images)),
  ];
}

/**
 * The objects of `objects` the bucket lacks, given `read(key)` (its text, or null): every
 * blob that no manifest of the bucket's index names, and every manifest and the index whose
 * text differs.
 */
export async function missingFrom(objects, read) {
  const parsed = async (key) => {
    try {
      return JSON.parse(await read(key));
    } catch {
      return null;
    }
  };
  const have = new Set();
  const index = await parsed('images/index.json');
  for (const { name } of (index && index.images) || []) {
    // eslint-disable-next-line no-await-in-loop
    const manifest = await parsed(`images/${name}.json`);
    for (const p of (manifest && manifest.packages) || []) {
      p.files.forEach((f) => have.add(`blobs/${f.sha256}`));
    }
  }
  const out = [];
  for (const o of objects) {
    if (o.key.startsWith('blobs/')) {
      if (!have.has(o.key)) {
        out.push(o);
      }
    // eslint-disable-next-line no-await-in-loop
    } else if (await read(o.key).catch(() => null) !== o.body) {
      out.push(o);
    }
  }
  return out;
}

const run = promisify(execFile);
const cf = (args) => run(join(root, 'node_modules', '.bin', 'cf'), args, {
  cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CF_SEND_TELEMETRY: 'false' },
});

/** The bucket of a deployment (`--mode`), as cloudflare.config.ts names it. */
export const bucketOf = (mode) => `helix-opspile-images${mode === 'prod' ? '' : `-${mode || 'dev'}`}`;

async function upload(objects, { mode, dryRun, local = [] }) {
  const bucket = bucketOf(mode);
  const read = async (key) => (await cf(['r2', 'objects', 'get', key, '--bucket-name', bucket,
    '--text', ...local])).stdout;
  const missing = await missingFrom(objects, read);
  const dir = await mkdtemp(join(tmpdir(), 'computer-images-'));
  try {
    for (const o of missing) {
      console.log(`${dryRun ? 'would upload' : 'upload'} ${bucket}/${o.key} (${o.body.length} bytes)`);
      if (!dryRun) {
        const file = join(dir, 'object');
        // eslint-disable-next-line no-await-in-loop
        await writeFile(file, o.body);
        // eslint-disable-next-line no-await-in-loop
        await cf(['r2', 'objects', 'put', o.key, '--bucket-name', bucket, '--file', file,
          '--content-type', o.type, ...local]);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`${bucket}: ${missing.length} of ${objects.length} objects ${dryRun ? 'differ' : 'uploaded'}`);
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name) => (flag(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const objects = objectsOf(await build());
  if (value('--out')) {
    for (const o of objects) {
      const file = join(value('--out'), o.key);
      // eslint-disable-next-line no-await-in-loop
      await mkdir(dirname(file), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await writeFile(file, o.body);
    }
    console.log(`wrote ${objects.length} objects to ${value('--out')}`);
  }
  if (flag('--upload')) {
    const local = flag('--local')
      ? ['--local', ...(value('--persist-to') ? ['--persist-to', value('--persist-to')] : [])]
      : [];
    await upload(objects, { mode: value('--mode'), dryRun: flag('--dry-run'), local });
  }
  if (!value('--out') && !flag('--upload')) {
    console.error('give --out <dir> or --upload [--mode prod|stage] [--local] [--dry-run]');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
