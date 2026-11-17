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
 * programs a computer has, by what it is for. An image is a stack of layers, as a container
 * image is: each layer is a tree of files, an image names its layers from the bottom up (after
 * those of the image it is `from`), and where two layers have a path, the upper one's file is
 * the image's. They are built from the @ai-ecoverse/wasm-* packages (homescoop) this
 * repository pins, and live in the `IMAGES` bucket, not in the Worker: a kernel mounts its
 * team's image from there, read-only, when it boots.
 *
 *   node scripts/computer-images.mjs --out <dir>             # the bucket's objects, as files
 *   node scripts/computer-images.mjs --upload --mode prod    # to helix-opspile-images
 *   node scripts/computer-images.mjs --upload --mode stage --dry-run
 *   node scripts/computer-images.mjs --upload --local        # for `cf dev`: its local bucket
 *
 * In the bucket (`objectsOf`), everything but the images and their index named by its content:
 * - `blobs/<sha256>`: one file, so layers share what they have in common, and an upload sends
 *   only what is new;
 * - `layers/<sha256>.json`: a layer (`v` 1): its `name` and its `files`, each a `path` in the
 *   image, a `mode` (read-only: 0444, or 0555 for a program), a `size`, and its `sha256` (a
 *   blob) or, for a small file, its bytes themselves (`data`, base64). A blob over a piece
 *   (PIECE_BYTES) has its `pieces` too: `{ size, sha256 }`, the hash of each piece of `size`
 *   bytes, in order, so a read of a part of it is checked (a reader that does not know them
 *   reads the whole blob, by its `sha256`). An Emscripten program's JavaScript glue is there
 *   as an empty file: in a Worker the kernel runs the program without it, but finds the
 *   command by it;
 * - `images/<name>.json`: an image's manifest (`v` 2): its `layers` from the bottom up (`name`,
 *   `digest`, `bytes`), its `commands`, what the agent is told it has (`tools`), and `digest`,
 *   which names exactly this stack;
 * - `images/index.json`: the images there are, for the knowledge-base editor.
 *
 * `--upload` sends the blobs of the layers the bucket lacks, then those layers, then the
 * manifests, then the index: a kernel that boots meanwhile finds an image whole, the old one
 * or the new. It never deletes: a layer no image names any more stays, so a kernel that runs
 * an older image keeps reading it. It runs `cf` (the account of its profile, or
 * CLOUDFLARE_ACCOUNT_ID), after the deploy, which makes the bucket.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readdir, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname, join, relative, sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The layers: each a set of packages, with all of a package's commands or those named, and
 * the package's other files a program needs (`files`: paths in the package, a directory with
 * all it holds). A package is in one layer only.
 */
export const LAYERS = {
  shell: [
    { name: '@ai-ecoverse/wasm-bash' },
    { name: '@ai-ecoverse/wasm-coreutils' },
  ],
  text: [
    { name: '@ai-ecoverse/wasm-grep' },
    { name: '@ai-ecoverse/wasm-sed' },
    { name: '@ai-ecoverse/wasm-gawk' },
    { name: '@ai-ecoverse/wasm-jq' },
    { name: '@ai-ecoverse/wasm-findutils' },
    { name: '@ai-ecoverse/wasm-diffutils', commands: ['diff', 'cmp'] },
    { name: '@ai-ecoverse/wasm-tree' },
    { name: '@ai-ecoverse/wasm-which' },
    { name: '@ai-ecoverse/wasm-util-linux', commands: ['rev', 'column', 'hexdump'] },
    { name: '@ai-ecoverse/wasm-xxd' },
    { name: '@ai-ecoverse/wasm-patch' },
  ],
  archive: [
    { name: '@ai-ecoverse/wasm-gzip' },
    { name: '@ai-ecoverse/wasm-tar' },
    { name: '@ai-ecoverse/wasm-zip' },
    { name: '@ai-ecoverse/wasm-xz' },
    { name: '@ai-ecoverse/wasm-bzip2' },
  ],
  // BIND's dig, host and nslookup ask the kernel's DNS (127.0.0.53), which forwards what it
  // does not know over DNS over HTTPS (src/agent/agent.js, `network.doh`).
  net: [
    { name: '@ai-ecoverse/wasm-curl' },
    { name: '@ai-ecoverse/wasix-bind' },
  ],
  // openssl, with its configuration and Mozilla's roots. It has no TCP of its own out of the
  // computer, so s_client reaches only the kernel's loopback.
  tls: [
    { name: '@ai-ecoverse/wasix-openssl-cli', files: ['etc/ssl'] },
  ],
  // git runs its transports (git-remote-https) from libexec/git-core, by their paths.
  git: [
    { name: '@ai-ecoverse/wasm-git', files: ['libexec/git-core', 'share/git-core/templates'] },
  ],
  formats: [
    { name: '@ai-ecoverse/wasi-yq' },
    { name: '@ai-ecoverse/wasi-html-to-markdown' },
    { name: '@ai-ecoverse/wasm-file', files: ['share/misc/magic.mgc'] },
  ],
  // QuickJS-NG: the kernel runs no JS programs in a Worker, so its `node` is not to be had.
  js: [
    { name: '@ai-ecoverse/wasi-quickjs' },
  ],
  // gh, with its imports module (host/gh-host.mjs), which the kernel runs beside it.
  github: [
    { name: '@ai-ecoverse/wasi-gh' },
  ],
  data: [
    { name: '@ai-ecoverse/wasi-ripgrep' },
    { name: '@ai-ecoverse/wasm-sqlite3' },
    { name: '@ai-ecoverse/wasm-binutils', commands: ['strings'] },
  ],
};

const BASE_TOOLS = 'coreutils (cat, sort, uniq, head, tail, cut, tr, wc, base64, sha256sum, date and the rest), grep, sed, awk (gawk), jq, yq, find, xargs, diff, cmp, patch, tar, gzip, zip, unzip, xz, bzip2, tree, column, rev, hexdump, xxd, file, html2markdown, curl, dig, host, nslookup, openssl, git, qjs';

/**
 * The images: `name` is what a team's choice stores, `title` and `description` are for the
 * people who choose, `tools` is what the agent is told it has (every word of it a command of
 * the image: `build` checks), and `layers` names its layers (LAYERS) from the bottom up, on
 * top of those of the image it is `from`.
 */
export const IMAGES = [
  {
    name: 'base',
    title: 'Base',
    description: 'GNU bash, coreutils, grep, sed, gawk, jq, yq, find, diff, tar, gzip, zip,'
      + ' html2markdown, curl, dig, openssl, git and qjs (JavaScript): for reading logs, text,'
      + ' JSON and YAML, asking APIs and DNS, reading certificates, cloning repositories, and'
      + ' small scripts.',
    tools: BASE_TOOLS,
    layers: ['shell', 'text', 'archive', 'net', 'tls', 'js', 'git', 'formats'],
  },
  {
    name: 'data',
    from: 'base',
    title: 'Data',
    description: 'Base, with ripgrep, sqlite3 and strings: for searching many files and'
      + ' querying CSV or JSON as tables.',
    tools: `${BASE_TOOLS}, rg, sqlite3, strings`,
    layers: ['data'],
  },
  // Not in Base: gh.wasm is 50 MB, which the agent's object reads whole each time a Dynamic
  // Worker of gh starts cold (src/agent/image.js), and each gh has a Dynamic Worker to itself.
  {
    name: 'github',
    from: 'base',
    title: 'GitHub',
    description: 'Base, with gh (GitHub CLI): for reading repositories, issues, pull requests and'
      + ' workflow runs. Give the team a GH_TOKEN secret for github.com.',
    tools: `${BASE_TOOLS}, gh`,
    layers: ['github'],
  },
];

/** Files up to this size are in their layer itself, not in a blob of their own. */
const INLINE_BYTES = 16 * 1024;

/**
 * A blob larger than this is read in pieces of this size too (src/agent/image.js): its file
 * in the layer names the sha256 of each (`pieces`), so a piece is checked by itself.
 */
export const PIECE_BYTES = 1024 * 1024;

/** The pieces of a blob (`data`), when it has more than one: `{ size, sha256 }`, or none. */
export function piecesOf(data) {
  if (data.length <= PIECE_BYTES) {
    return undefined;
  }
  const sha256 = [];
  for (let at = 0; at < data.length; at += PIECE_BYTES) {
    sha256.push(createHash('sha256').update(data.subarray(at, at + PIECE_BYTES)).digest('hex'));
  }
  return { size: PIECE_BYTES, sha256 };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The files of a command entry (`slicc.commands.<name>`), relative to its package. */
const filesOf = (entry) => [entry.glue, entry.wasm, entry.script, entry.module, entry.imports,
  ...(entry.variants || []).map((v) => v.wasm)].filter((f) => typeof f === 'string');

/**
 * One package of an image: its manifest with only the commands kept, the paths of the files
 * those need, sorted, and which of them are glue. `present` (the package's files, when its
 * `files` are asked for) adds those under `files`, and counts as glue every one of them an
 * Emscripten package has beside its `.wasm`: a program another one runs by its path (git's
 * `libexec/git-core/git-remote-https`).
 */
export function imagePackage(manifest, { commands, files } = {}, present = []) {
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
  const under = (path) => (files || []).some((f) => path === f || path.startsWith(`${f}/`));
  const extra = present.filter(under);
  const unknown = (files || []).filter((f) => !present.some((p) => p === f || p.startsWith(`${f}/`)));
  if (unknown.length) {
    throw new Error(`${manifest.name} has no file ${unknown.join(', ')}`);
  }
  const paths = [...new Set([...Object.values(kept).flatMap(filesOf), ...extra])].sort();
  const glue = [...new Set([...Object.values(kept).map((c) => c.glue).filter(Boolean),
    ...((manifest.slicc || {}).abi === 'emscripten'
      ? extra.filter((p) => extra.includes(`${p}.wasm`)) : [])])].sort();
  return { manifest: slim, paths, glue };
}

/** The programs `tools` names: its words, without what stands in brackets as a gloss. */
export const toolNames = (tools) => tools.replace(/\((gawk)\)/g, '')
  .replace(/ and the rest/g, '')
  .split(/[\s,()]+/)
  .filter((w) => w && w !== 'and');

/** The names of the layers of `image` from the bottom up, those of its `from` first. */
export function layerNames(image, images = IMAGES, seen = []) {
  if (seen.includes(image.name)) {
    throw new Error(`image ${image.name} is from itself`);
  }
  const parent = image.from ? images.find((i) => i.name === image.from) : null;
  if (image.from && !parent) {
    throw new Error(`image ${image.name} is from ${image.from}, which there is none of`);
  }
  return [...(parent ? layerNames(parent, images, [...seen, image.name]) : []), ...image.layers];
}

/** The paths of the files in `dir`, relative to it, sorted. */
async function filesIn(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

/**
 * One layer of `packages` (a list as in LAYERS) from `modules`: `{ layer, body, digest,
 * blobs, commands }`. `layer` is what the bucket has (`body`, its JSON, named by `digest`),
 * with each package under `node_modules/`: its manifest, with only the commands kept, and
 * their files.
 */
export async function buildLayer(name, packages, modules) {
  const blobs = new Map();
  const files = [];
  const commands = [];
  const add = (path, data, mode) => {
    const hash = sha256(data);
    const inline = data.length <= INLINE_BYTES;
    if (!inline) {
      blobs.set(hash, data);
    }
    const pieces = inline ? undefined : piecesOf(data);
    files.push({
      path,
      mode,
      size: data.length,
      ...(inline ? { data: data.toString('base64') } : { sha256: hash }),
      ...(pieces ? { pieces } : {}),
    });
  };
  for (const spec of packages) {
    const dir = join(modules, spec.name);
    // eslint-disable-next-line no-await-in-loop
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    // eslint-disable-next-line no-await-in-loop
    const present = spec.files ? await filesIn(dir) : [];
    const { manifest: slim, paths, glue } = imagePackage(manifest, spec, present);
    const at = `node_modules/${spec.name}`;
    add(`${at}/package.json`, Buffer.from(JSON.stringify(slim, null, 2)), 0o444);
    for (const path of paths) {
      // An empty file stands for a glue: the kernel is given no bytes for it.
      // eslint-disable-next-line no-await-in-loop
      add(`${at}/${path}`, glue.includes(path) ? Buffer.alloc(0) : await readFile(join(dir, path)), 0o555);
    }
    commands.push(...Object.keys(slim.slicc.commands));
  }
  files.sort((x, y) => (x.path < y.path ? -1 : 1));
  const layer = { v: 1, name, files };
  const body = `${JSON.stringify(layer)}\n`;
  return {
    layer, body, digest: sha256(body), blobs, commands,
  };
}

/**
 * Builds `images` (IMAGES) of `layers` (LAYERS) from `modules` (node_modules): `{ images,
 * layers, blobs }`, `images` the manifests as the bucket has them, `layers` the built layers
 * (buildLayer) by name, `blobs` the files by their sha256.
 */
export async function build({
  modules = join(root, 'node_modules'), images = IMAGES, layers = LAYERS,
} = {}) {
  const built = new Map();
  const blobs = new Map();
  const out = [];
  for (const image of images) {
    const stack = [];
    for (const name of layerNames(image, images)) {
      if (!layers[name]) {
        throw new Error(`image ${image.name} has a layer ${name}, which there is none of`);
      }
      // eslint-disable-next-line no-await-in-loop
      built.set(name, built.get(name) || await buildLayer(name, layers[name], modules));
      stack.push(built.get(name));
    }
    // The upper layer's file is the image's.
    const merged = new Map(stack.flatMap((l) => l.layer.files.map((f) => [f.path, f])));
    const commands = [...new Set(stack.flatMap((l) => l.commands))].sort();
    const unknown = toolNames(image.tools).filter((w) => !commands.includes(w));
    if (unknown.length) {
      throw new Error(`image ${image.name} tells the agent of ${unknown.join(', ')}, which it has not`);
    }
    out.push({
      v: 2,
      name: image.name,
      title: image.title,
      description: image.description,
      tools: image.tools,
      commands,
      digest: sha256(stack.map((l) => l.digest).join('\n')),
      bytes: [...merged.values()].reduce((n, f) => n + f.size, 0),
      layers: stack.map((l) => ({
        name: l.layer.name,
        digest: l.digest,
        bytes: l.layer.files.reduce((n, f) => n + f.size, 0),
      })),
    });
    stack.forEach((l) => l.blobs.forEach((data, hash) => blobs.set(hash, data)));
  }
  return { images: out, layers: built, blobs };
}

/** The index of `images` (their manifests): what the knowledge-base editor lists. */
export const indexOf = (images) => ({
  v: 2,
  images: images.map(({
    name, title, description, digest, bytes, layers,
  }) => ({
    name, title, description, digest, bytes, layers: layers.map((l) => l.name),
  })),
});

/**
 * What `build` made, as the bucket's objects, in upload order: `[{ key, body, type }]`, a
 * layer's with the keys of its blobs (`blobs`).
 */
export function objectsOf({ images, layers, blobs }) {
  const json = (key, value) => ({ key, body: `${JSON.stringify(value)}\n`, type: 'application/json' });
  return [
    ...[...blobs].sort(([a], [b]) => a.localeCompare(b))
      .map(([hash, body]) => ({ key: `blobs/${hash}`, body, type: 'application/octet-stream' })),
    ...[...layers.values()].map((l) => ({
      key: `layers/${l.digest}.json`,
      body: l.body,
      type: 'application/json',
      blobs: [...l.blobs.keys()].map((hash) => `blobs/${hash}`),
    })),
    ...images.map((image) => json(`images/${image.name}.json`, image)),
    json('images/index.json', indexOf(images)),
  ];
}

/**
 * The objects of `objects` the bucket lacks, given `read(key)` (its text, or null): every
 * layer that is not there, with the blobs no layer that is there names (a layer is written
 * after its blobs), and every manifest and the index whose text differs.
 */
export async function missingFrom(objects, read) {
  const there = new Set();
  for (const o of objects.filter((x) => x.blobs)) {
    // eslint-disable-next-line no-await-in-loop
    if (await read(o.key).catch(() => null) === o.body) {
      [o.key, ...o.blobs].forEach((key) => there.add(key));
    }
  }
  const out = [];
  for (const o of objects) {
    if (o.blobs || o.key.startsWith('blobs/')) {
      if (!there.has(o.key)) {
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
