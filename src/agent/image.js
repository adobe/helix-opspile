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
 * The images of the agents' computers on the SLICC kernel (src/agent/kernel.js): which
 * programs a computer has. They are built from this repository's pinned packages and kept in
 * the `IMAGES` bucket by scripts/computer-images.mjs, which says what is where:
 * `images/index.json`, `images/<name>.json` and `blobs/<sha256>`. The Worker carries none of
 * them: a team chooses an image by name (the knowledge-base editor's Computer tool), and a
 * kernel installs it from the bucket when it boots, into its own root under /node_modules,
 * where it finds its commands.
 *
 * No Workers runtime is needed here, so this is tested in Node, with a bucket in memory.
 */

export const DEFAULT_IMAGE = 'base';
export const isImageName = (name) => /^[a-z][a-z0-9-]{0,31}$/.test(String(name || ''));

const MODULES = '/node_modules';
/** What is installed, in the kernel's root: `{ digest, packages: [name] }`. */
const STATE = `${MODULES}/.opspile-image.json`;
const decoder = new TextDecoder();

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0'))
  .join('');

async function json(bucket, key) {
  const object = bucket ? await bucket.get(key) : null;
  return object ? JSON.parse(await object.text()) : null;
}

/** The images in `bucket`: `[{ name, title, description, digest, bytes }]`; none without one. */
export async function listImages(bucket) {
  const index = await json(bucket, 'images/index.json').catch(() => null);
  return index && index.v === 1 && Array.isArray(index.images)
    ? index.images.filter((i) => isImageName(i.name)) : [];
}

/** The manifest of the image `name` in `bucket`, or null. */
export async function readImage(bucket, name) {
  const image = isImageName(name) ? await json(bucket, `images/${name}.json`) : null;
  return image && image.v === 1 && Array.isArray(image.packages) ? image : null;
}

/** The commands of `image` (a manifest), sorted. */
export const commandsOf = (image) => [...new Set(image.packages.flatMap((p) => p.commands))]
  .sort();

async function text(kernel, path) {
  try {
    return decoder.decode(await kernel.readFile(path));
  } catch {
    return null;
  }
}

/** The bytes of `file` (`{ path, sha256, size }`) from `bucket`, checked against its hash. */
async function blob(bucket, file) {
  if (!file.size) {
    return new Uint8Array(0);
  }
  const object = await bucket.get(`blobs/${file.sha256}`);
  if (!object) {
    throw new Error(`the images bucket has no blobs/${file.sha256} (${file.path})`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== file.sha256) {
    throw new Error(`blobs/${file.sha256} is not the file it names (${file.path})`);
  }
  return bytes;
}

/**
 * Makes what `kernel` has under /node_modules the image `image` (a manifest), from `bucket`:
 * `{ wrote, removed }`, the packages it wrote and removed. One read when the image is the one
 * installed (`STATE` has its digest). Else every package that is not there as the image has it
 * is written, its manifest last, so that one half written (the object stopped) is written
 * again; the packages of the image before that this one lacks are removed (`remove(path)`),
 * and `STATE` is written last of all. Nothing is ever taken from a package both have.
 */
export async function installImage(kernel, bucket, image, { remove } = {}) {
  let state = {};
  try {
    state = JSON.parse(await text(kernel, STATE)) || {};
  } catch {
    // Unreadable is as good as nothing installed.
  }
  if (state.digest === image.digest) {
    return { wrote: 0, removed: 0 };
  }
  let wrote = 0;
  for (const p of image.packages) {
    const dir = `${MODULES}/${p.name}`;
    // eslint-disable-next-line no-await-in-loop
    if (await text(kernel, `${dir}/package.json`) !== p.manifest) {
      for (const file of p.files) {
        // eslint-disable-next-line no-await-in-loop
        await kernel.writeFile(`${dir}/${file.path}`, await blob(bucket, file));
      }
      // eslint-disable-next-line no-await-in-loop
      await kernel.writeFile(`${dir}/package.json`, p.manifest);
      wrote += 1;
    }
  }
  const names = image.packages.map((p) => p.name);
  const gone = (Array.isArray(state.packages) ? state.packages : [])
    .filter((name) => !names.includes(name));
  for (const name of remove ? gone : []) {
    // eslint-disable-next-line no-await-in-loop
    await remove(`${MODULES}/${name}`);
  }
  // Packages that could not be removed are remembered, for the next change of image.
  const packages = remove ? names : [...new Set([...names, ...gone])];
  await kernel.writeFile(STATE, JSON.stringify({ digest: image.digest, packages }));
  return { wrote, removed: remove ? gone.length : 0 };
}
