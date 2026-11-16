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
 * Writes src/ui-markdown.bundle.js: src/ui-markdown.js and micromark, bundled for the
 * browser, as a string that src/page.js puts into the inbox page; src/ui-editor.bundle.js,
 * src/ui-editor.js and CodeMirror, the knowledge-base editor's text field, the same way;
 * src/ui-highlight.bundle.js, src/ui-highlight.js and @pierre/highlights as an ES module, which
 * the Worker serves at /inbox/highlight.js (with its hash, `etag`), for the inbox to import
 * with the first code block it shows; src/ui-fmc.bundle.js, src/ui-fmc.js with Mermaid and ELK
 * (flowcharts only, `flowchartOnly`), which the Worker serves at /inbox/fmc.js for the inbox to
 * import when it first draws a stack; and src/ui-spectrum.bundle.js, Spectrum 2's design
 * tokens (@spectrum-css/tokens) by name, of which src/page.js puts those ui/spectrum*.css use
 * into the pages under /spectrum.
 *
 *   node scripts/ui-markdown.mjs
 *
 * The files are not committed: cloudflare.config.ts runs this on every cf deploy and cf dev,
 * and npm runs it before lint, test and ui:dev (`npm run build` by hand).
 */

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What is bundled: the source in src/, its global in the page (none for a module the Worker
 * serves on its own), and what it includes.
 */
export const BUNDLES = [{
  name: 'ui-markdown',
  global: 'Markdown',
  credits: `Includes micromark and its GFM extensions, (c) Titus Wormer, MIT License:
 * https://github.com/micromark/micromark`,
}, {
  name: 'ui-editor',
  global: 'Editor',
  credits: `Includes CodeMirror and Lezer, (c) Marijn Haverbeke and others, MIT License:
 * https://codemirror.net`,
}, {
  name: 'ui-highlight',
  credits: `Includes @pierre/highlights, (c) The Pierre Computer Company, Apache License 2.0:
 * https://diffs.com/highlights`,
}, {
  name: 'ui-fmc',
  credits: `Includes Mermaid, (c) Knut Sveidqvist and others, MIT License: https://mermaid.js.org;
 * and ELK (elkjs), (c) Kiel University and others, Eclipse Public License 2.0:
 * https://github.com/kieler/elkjs`,
  // eslint-disable-next-line no-use-before-define -- defined below, called at build time
  plugins: () => [flowchartOnly()],
}];

const MERMAID = join(root, 'node_modules', 'mermaid', 'dist');
/** Mermaid's chunks that a flowchart drawn with ELK needs, of those it imports when asked. */
const KEEP = /^(flowDiagram|elk|sizeCapture)-/;

/**
 * Mermaid as src/ui-fmc.js uses it: flowcharts laid out with ELK. Mermaid imports every other
 * diagram, layout and KaTeX when a text asks for it; here those imports fail instead, which
 * keeps the bundle to Mermaid's core, its flowchart and ELK (some 2.4 MB rather than 5.4 MB).
 * `mermaid-elk-render` is Mermaid's ELK layout, which src/ui-fmc.js wraps.
 */
export function flowchartOnly() {
  return {
    name: 'mermaid-flowchart-only',
    setup(b) {
      b.onResolve({ filter: /^mermaid-elk-render$/ }, () => {
        const dir = join(MERMAID, 'chunks', 'mermaid.core');
        const file = readdirSync(dir).find((f) => /^elk-[A-Z0-9]+\.mjs$/.test(f));
        if (!file) {
          throw new Error(`no ELK layout in ${dir}`);
        }
        return { path: join(dir, file) };
      });
      b.onLoad({ filter: /[\\/]mermaid[\\/]dist[\\/].*\.mjs$/ }, async (args) => {
        const code = await readFile(args.path, 'utf8');
        return {
          loader: 'js',
          contents: code.replace(/import\("(?:\.\/chunks\/mermaid\.core\/|\.\/)?([^"/]+?)(?:\.mjs)?"\)/g, (m, name) => (KEEP.test(name) ? m : 'Promise.reject(new Error("not in this build"))')),
        };
      });
    },
  };
}

/** A bundle, as the module that src/page.js imports (the markdown renderer by default). */
export async function bundle({
  name, global, credits, plugins,
} = BUNDLES[0]) {
  const result = await build({
    entryPoints: [join(root, 'src', `${name}.js`)],
    bundle: true,
    format: global ? 'iife' : 'esm',
    globalName: global,
    minify: true,
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
    plugins: plugins ? plugins() : [],
  });
  // In an inline <script>, `</script` would end it.
  const code = result.outputFiles[0].text.trim().replace(/<\/(script)/gi, '<\\/$1');
  const etag = global ? ''
    : `export const etag = '"${createHash('sha256').update(code).digest('hex').slice(0, 16)}"';\n`;
  return `/*
 * Generated by scripts/ui-markdown.mjs from src/${name}.js; do not edit.
 *
 * ${credits}
 */
/* eslint-disable */
export default ${JSON.stringify(code)};
${etag}`;
}

/**
 * Spectrum 2's tokens, as @spectrum-css/tokens declares them on its classes: `global` (the
 * `.spectrum` class) and the color schemes (`light`, `dark`) and scales (`medium`, `large`)
 * on theirs, each `{ name: value }` without the leading `--`.
 */
export async function spectrumTokens() {
  const dir = join(root, 'node_modules', '@spectrum-css', 'tokens');
  const { version } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const sets = {};
  for (const set of ['global', 'light', 'dark', 'medium', 'large']) {
    // eslint-disable-next-line no-await-in-loop -- five small files
    const css = await readFile(join(dir, 'dist', 'css', `${set}-vars.css`), 'utf8');
    sets[set] = Object.fromEntries([...css.matchAll(/--(spectrum-[a-z0-9-]+):\s*([^;]+);/g)]
      .map(([, name, value]) => [name, value.trim()]));
  }
  return `/*
 * Generated by scripts/ui-markdown.mjs from @spectrum-css/tokens ${version}; do not edit.
 *
 * Spectrum 2's design tokens, (c) Adobe, Apache License 2.0:
 * https://github.com/adobe/spectrum-css/tree/main/tokens
 */
/* eslint-disable */
export default ${JSON.stringify(sets)};
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const b of BUNDLES) {
    const out = join(root, 'src', `${b.name}.bundle.js`);
    // eslint-disable-next-line no-await-in-loop -- a few small builds, one after the other
    const source = await bundle(b);
    // eslint-disable-next-line no-await-in-loop
    await writeFile(out, source);
    console.log(`wrote ${out} (${Math.round(source.length / 1024)} KB)`);
  }
  const out = join(root, 'src', 'ui-spectrum.bundle.js');
  const tokens = await spectrumTokens();
  await writeFile(out, tokens);
  console.log(`wrote ${out} (${Math.round(tokens.length / 1024)} KB)`);
}
