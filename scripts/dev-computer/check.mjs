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
 * `npm run computer:check -- <origin>`: runs the programs of the images of
 * scripts/computer-images.mjs on an agent's computer (scripts/dev-computer/worker.mjs), the
 * local one of `npm run computer:dev` or the one deployed to Cloudflare, where the limits of
 * Dynamic Workers are real (.github/workflows/computer-stage.yml).
 *
 *   npm run computer:check -- http://localhost:8788
 *   COMPUTER_TOKEN=… npm run computer:check -- --images https://<stage worker>
 *
 * `--images` first puts into the Worker's bucket the objects of the images it lacks
 * (`syncImages`, as `npm run computer:images` does for a deployment). `COMPUTER_TOKEN` is sent
 * in `x-opspile-computer-token`, which the deployed Worker requires. Each run's agents are new
 * (`thread=check-<run>-…`), so a computer boots from nothing, as an agent's first command does.
 * Exits 1 when a check fails; with GITHUB_STEP_SUMMARY, writes the results there too.
 */

import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build, missingFrom, objectsOf } from '../computer-images.mjs';

/**
 * The checks: `command` runs on the kernel with `image` (base by default), on the computer of
 * `thread` (one per image, so a check does not reboot another's kernel), and passes when its
 * output matches `match` (stdout and stderr together) and its exit code is 0.
 */
export const CHECKS = [
  { name: 'boots', command: 'uname -s; id -un', match: /^Linux\nroot\n$/ },
  {
    name: 'curl over https',
    command: "curl -sS -o /dev/null -w '%{http_code}\\n' https://www.aem.live/",
    match: /^200\n$/,
  },
  {
    name: 'jq, four at once',
    command: 'echo \'{"a":[1,2]}\' | jq -c . | jq -c .a | jq -c add | jq .',
    match: /^3\n$/,
  },
  { name: 'qjs', command: "qjs -e 'console.log(6 * 7)'", match: /^42\n$/ },
  { name: 'grep', command: 'printf "a\\nb\\na\\n" | grep -c a', match: /^2\n$/ },
  { name: 'dig', command: 'dig +short a www.aem.live', match: /^(\S+\.\n)*(\d+\.){3}\d+\n/ },
  {
    name: 'git clone, log, blame',
    command: 'cd /tmp && rm -rf c && git clone -q --depth 3 https://github.com/adobe/helix-opspile c'
      + ' && git -C c log --oneline | wc -l && git -C c blame -L1,1 package.json | cut -d")" -f2',
    match: /^[1-9]\d*\n \{\n$/,
    timeout: 120,
  },
  { name: 'grep, after git', command: 'printf "a\\nb\\na\\n" | grep -c a', match: /^2\n$/ },
  {
    name: 'yq',
    command: "printf 'a:\\n  b: [1, 2]\\n' | yq -o json -I0 .a",
    match: /^\{"b":\[1,2\]\}\n$/,
  },
  {
    name: 'html2markdown',
    command: "printf '<h1>Hi</h1><p>a <b>b</b></p>' | html2markdown",
    match: /^# Hi\n\na \*\*b\*\*\n*$/,
  },
  {
    name: 'file, xxd, patch, xz, bzip2',
    command: 'cd /tmp && echo \'{"a":1}\' > j && file -b j && echo hi | xxd -p'
      + ' && printf "a\\nb\\n" > x && printf "a\\nc\\n" > y && { diff -u x y > p || true; }'
      + ' && patch -s x < p && tail -1 x && echo hi | xz | xz -dc && echo hi | bzip2 | bzcat',
    match: /^JSON text data\n68690a\nc\nhi\nhi\n$/,
  },
  {
    name: 'data: rg, sqlite3, strings',
    image: 'data',
    command: "printf 'x\\nneedle\\n' | rg -c needle && sqlite3 :memory: 'select 6 * 7'"
      + ' && printf "\\0\\0hello\\0" | strings',
    match: /^1\n42\nhello\n$/,
  },
];

/** Every command of `image` (a manifest) the computer has in /usr/bin. */
export const commandsCheck = (image) => ({
  name: `${image.name}: its ${image.commands.length} commands in /usr/bin`,
  image: image.name,
  command: `cd /usr/bin && for c in ${image.commands.map((c) => `'${c}'`).join(' ')}; do`
    + ' [ -x "$c" ] || echo "missing $c"; done; echo checked',
  match: /^checked\n$/,
});

const headersOf = (token) => (token ? { 'x-opspile-computer-token': token } : {});

/**
 * Puts the objects of `built` (scripts/computer-images.mjs `build`) that the Worker at
 * `origin` lacks into its bucket, in upload order: how many it put.
 */
export async function syncImages(origin, built, { token, log = console.log } = {}) {
  const objects = objectsOf(built);
  const read = async (key) => {
    const res = await fetch(`${origin}/images/${key}`, { headers: headersOf(token) });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`could not read ${key}: ${res.status}`);
    }
    return res.text();
  };
  const missing = await missingFrom(objects, read);
  for (const o of missing) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${origin}/images/${o.key}`, {
      method: 'PUT', body: o.body, headers: headersOf(token),
    });
    if (!res.ok) {
      throw new Error(`could not put ${o.key}: ${res.status}`);
    }
  }
  log(`images: ${missing.length} of ${objects.length} objects put`);
  return missing.length;
}

/** Runs `check` on the computer at `origin`: `{ name, ok, ms, output, exitCode, error }`. */
export async function runCheck(origin, check, { token, run }) {
  const image = check.image || 'base';
  const started = Date.now();
  try {
    const res = await fetch(`${origin}/?thread=check-${run}-${image}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headersOf(token) },
      body: JSON.stringify({
        command: check.command, runtime: 'slicc-kernel', image, timeout: check.timeout || 60,
      }),
    });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const output = `${body.stdout || ''}${body.stderr || ''}`;
    const ok = res.ok && !body.error && body.exitCode === 0 && check.match.test(output);
    return {
      name: check.name,
      ok,
      ms: Date.now() - started,
      output,
      exitCode: body.exitCode,
      error: body.error ? `${body.error}${body.message ? `: ${body.message}` : ''}` : undefined,
    };
  } catch (e) {
    return {
      name: check.name, ok: false, ms: Date.now() - started, output: '', error: e.message,
    };
  }
}

const tail = (text, lines = 15) => text.trimEnd().split('\n').slice(-lines).join('\n');

/**
 * The results as a Markdown table, and what the failed ones printed. Not where the computer is:
 * a step summary is public, and the stage Worker's address names the account.
 */
export function summaryOf(results) {
  const rows = results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.ms} ms |`);
  const failed = results.filter((r) => !r.ok).map((r) => `\n**${r.name}**`
    + ` (exit ${r.exitCode ?? '–'}${r.error ? `, ${r.error}` : ''}):\n\n\`\`\`\n${tail(r.output)}\n\`\`\``);
  return ['### The agent\'s computer', '', '| | Check | Time |',
    '| --- | --- | --- |', ...rows, ...failed, ''].join('\n');
}

async function main(argv) {
  const origin = argv.find((a) => /^https?:\/\//.test(a));
  if (!origin) {
    console.error('npm run computer:check -- [--images] <origin>');
    process.exitCode = 2;
    return;
  }
  const token = process.env.COMPUTER_TOKEN;
  const built = await build();
  if (argv.includes('--images')) {
    await syncImages(origin, built, { token });
  }
  const run = process.env.GITHUB_RUN_ID || Date.now().toString(36);
  const checks = [...CHECKS, ...built.images.map(commandsCheck)];
  const results = [];
  for (const check of checks) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runCheck(origin, check, { token, run });
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.ms} ms)`);
    if (!result.ok) {
      console.log(`  exit ${result.exitCode ?? '–'}${result.error ? `, ${result.error}` : ''}`);
      console.log(tail(result.output).replace(/^/gm, '  | '));
    }
    results.push(result);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryOf(results));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} of ${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
