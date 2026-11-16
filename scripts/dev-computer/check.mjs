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
 * `npm run computer:check`: what Node's tests cannot run, checked on an agent's computer
 * (scripts/dev-computer/worker.mjs): the programs of the images of scripts/computer-images.mjs,
 * and that both shells refuse every change to the uploads with an exit code and an error. Without
 * an origin it starts `npm run computer:dev` on a free port and stops it after; with one it
 * checks that computer, the local one or the one deployed to Cloudflare, where the limits of
 * Dynamic Workers are real (.github/workflows/computer-stage.yml). Run it after updating
 * `@ai-ecoverse/slicc-kernel`, `@cloudflare/computer` or the images.
 *
 *   npm run computer:check
 *   npm run computer:check -- http://localhost:8788
 *   COMPUTER_TOKEN=… npm run computer:check -- --images https://<stage worker>
 *
 * `--images` first puts into the Worker's bucket the objects of the images it lacks
 * (`syncImages`, as `npm run computer:images` does for a deployment). `COMPUTER_TOKEN` is sent
 * in `x-opspile-computer-token`, which the deployed Worker requires. Each run's agents are new
 * (`thread=check-<run>-…`), so a computer boots from nothing, as an agent's first command does.
 * Exits 1 when a check fails; with GITHUB_STEP_SUMMARY, writes the results there too.
 */

import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, missingFrom, objectsOf } from '../computer-images.mjs';

/**
 * The checks: `command` runs in `runtime` (the kernel by default) with `image` (base by
 * default), on a computer of its own per runtime and image (so a check does not reboot
 * another's kernel) or of its own `thread`, with `uploads` (`{ name: text }`) put there first,
 * and passes when its output matches `match` (stdout, then stderr) and its exit code is 0.
 */
const ORIGINAL = 'line 1\nERROR boom\n';

/** Commands that change an upload, or the uploads, each of which the shell must refuse. */
export const CHANGES = [
  'echo overwrite > uploads/sample.log',
  ': > uploads/sample.log',
  'echo more >> uploads/sample.log',
  'exec 3>uploads/sample.log',
  'echo new > uploads/new.log',
  'rm uploads/sample.log',
];

/**
 * The uploads, in `runtime`: every change refused, with an exit code and an error, and the file
 * as it was; read, with the files next to them written; and read-only still once they change,
 * which takes a new Workspace. Each change runs in a subshell, whose exit code is printed.
 */
export function uploadChecks(runtime) {
  const uploads = { 'sample.log': ORIGINAL };
  return [
    ...CHANGES.map((change) => ({
      name: `${runtime}: the uploads refuse \`${change}\``,
      runtime,
      uploads,
      command: `( ${change} ); s=$?; cat uploads/sample.log; echo "exit $s"`,
      match: /^line 1\nERROR boom\nexit [1-9]\d*\n[\s\S]*read-only/i,
    })),
    {
      name: `${runtime}: the uploads are read, and the files next to them written`,
      runtime,
      uploads,
      command: 'cat uploads/sample.log && echo ok > notes.txt && cat notes.txt',
      match: /^line 1\nERROR boom\nok\n$/,
    },
    {
      name: `${runtime}: the uploads are read-only still once they change`,
      runtime,
      uploads: { ...uploads, 'other.log': 'other\n' },
      command: '( echo overwrite > uploads/other.log ); s=$?'
        + '; cat uploads/other.log uploads/sample.log notes.txt; echo "exit $s"',
      match: /^other\nline 1\nERROR boom\nok\nexit [1-9]\d*\n[\s\S]*read-only/i,
    },
  ];
}

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
  {
    // On a computer of its own, where grep has not run yet: a clone makes the kernel wait with
    // a timeout many times in one request, which once raised the request's subrequest depth
    // each time (the kernel's clock, a call into this object), until reading grep from the
    // images bucket failed (EIO).
    name: 'a program read for the first time after git, in a pipeline',
    thread: 'first-read',
    command: 'cd /tmp && git clone -q --depth 3 https://github.com/adobe/helix-opspile c'
      + ' && git -C c log --oneline | wc -l && git -C c blame -L1,1 package.json | grep -c "{"',
    match: /^[1-9]\d*\n1\n$/,
    timeout: 120,
  },
  { name: 'grep', command: 'printf "a\\nb\\na\\n" | grep -c a', match: /^2\n$/ },
  {
    // The forwarder's own answer: the CNAME and its TTL, not addresses the kernel made up.
    name: 'dig, host, nslookup',
    command: 'dig +noall +answer www.aem.live | awk \'{ print $4 }\' | sort -u'
      + ' && host www.aem.live | grep -c "is an alias for"'
      + ' && nslookup www.aem.live | grep -c "canonical name"'
      + ' && dig +short ns aem.live | wc -l',
    match: /^A\nCNAME\n[1-9]\n[1-9]\n[1-9]\d*\n$/,
  },
  {
    name: 'git clone, log, blame',
    command: 'cd /tmp && rm -rf c && git clone -q --depth 3 https://github.com/adobe/helix-opspile c'
      + ' && git -C c log --oneline | wc -l && git -C c blame -L1,1 package.json | cut -d")" -f2',
    match: /^[1-9]\d*\n \{\n$/,
    timeout: 120,
  },
  { name: 'grep, after git', command: 'printf "a\\nb\\na\\n" | grep -c a', match: /^2\n$/ },
  {
    name: 'openssl: a CA, a certificate, verify, and s_client on loopback',
    command: 'cd /tmp && rm -rf tls && mkdir tls && cd tls'
      + ' && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1'
      + ' -subj /CN=ca -keyout ca.key -out ca.pem 2> /dev/null'
      + ' && openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=localhost'
      + ' -keyout s.key -out s.csr 2> /dev/null'
      + ' && openssl x509 -req -in s.csr -CA ca.pem -CAkey ca.key -days 1 -out s.pem'
      + ' -extfile <(printf "subjectAltName=DNS:localhost") 2> /dev/null'
      + ' && openssl verify -CAfile ca.pem s.pem'
      + ' && openssl x509 -in s.pem -noout -ext subjectAltName | tail -1'
      + ' && { openssl s_server -accept 4433 -cert s.pem -key s.key -quiet -naccept 1'
      + ' > /dev/null 2>&1 & sleep 1;'
      + ' echo | openssl s_client -connect localhost:4433 -servername localhost -CAfile ca.pem'
      + ' -verify_return_error 2>&1 | grep -E "^Verify return code"; wait; }',
    match: /^s\.pem: OK\n +DNS:localhost\nVerify return code: 0 \(ok\)\n$/,
    timeout: 90,
  },
  {
    // A site's own chain, through the uplink (src/agent/uplink.js), checked against the roots.
    name: 'openssl: s_client to a site, port 443',
    command: 'openssl s_client -connect www.aem.live:443 -servername www.aem.live'
      + ' -verify_return_error < /dev/null 2>&1'
      + ' | grep -oE "^(New, TLSv1\\.[23]|Verify return code: .*)"'
      // The site's own certificate, not one of the kernel's proxy.
      + ' && openssl s_client -connect www.aem.live:443 -servername www.aem.live < /dev/null'
      + ' 2> /dev/null | openssl x509 -noout -issuer | grep -vic slicc',
    match: /^New, TLSv1\.[23]\nVerify return code: 0 \(ok\)\n1\n$/,
    timeout: 60,
  },
  {
    // What the agent is told: no other port leaves the computer.
    name: 'openssl: s_client to any other port is unreachable',
    command: 'openssl s_client -connect www.aem.live:80 < /dev/null > /dev/null 2>&1; echo $?',
    match: /^1\n$/,
  },
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
    // gh.wasm is 50 MB: its own Dynamic Worker, and its imports module beside it. Without a
    // real token, GitHub's own 401 shows that gh's HTTP reaches it through the transport.
    name: 'github: gh version, and gh api to github.com',
    image: 'github',
    command: 'gh version | head -1 | cut -d" " -f1-3'
      + ' && { GH_TOKEN=not-a-token gh api rate_limit 2>&1 | grep -c "Bad credentials"; true; }',
    match: /^gh version 2\.\d+\.\d+\n[1-9]\n$/,
    timeout: 120,
  },
  {
    name: 'data: rg, sqlite3, strings',
    image: 'data',
    command: "printf 'x\\nneedle\\n' | rg -c needle && sqlite3 :memory: 'select 6 * 7'"
      + ' && printf "\\0\\0hello\\0" | strings',
    match: /^1\n42\nhello\n$/,
  },
  ...uploadChecks('just-bash'),
  ...uploadChecks('slicc-kernel'),
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
  const runtime = check.runtime || 'slicc-kernel';
  const thread = `check-${run}-${check.thread || (runtime === 'slicc-kernel' ? image : runtime)}`;
  const headers = { 'content-type': 'application/json', ...headersOf(token) };
  const started = Date.now();
  try {
    if (check.uploads) {
      const put = await fetch(`${origin}/uploads?thread=${thread}`, {
        method: 'POST', headers, body: JSON.stringify(check.uploads),
      });
      if (!put.ok) {
        throw new Error(`could not put the uploads: ${put.status}`);
      }
    }
    const res = await fetch(`${origin}/?thread=${thread}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: check.command,
        runtime,
        ...(runtime === 'slicc-kernel' ? { image } : {}),
        timeout: check.timeout || 60,
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

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, 'localhost', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** Starts `npm run computer:dev` on a free port: `{ origin, stop }`, once its images are in. */
async function startDev() {
  const port = await freePort();
  const dev = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'dev.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`computer:dev did not start:\n${log}`)), 120_000);
    const seen = (chunk) => {
      log += chunk;
      if (log.includes('image objects are in the local bucket')) {
        clearTimeout(timer);
        resolve();
      }
    };
    dev.stdout.on('data', seen);
    dev.stderr.on('data', seen);
    dev.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`computer:dev exited (${code}):\n${log}`));
    });
  });
  return { origin: `http://localhost:${port}`, stop: () => dev.kill('SIGTERM') };
}

async function checkAll(origin, argv) {
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

async function main(argv) {
  const given = argv.find((a) => /^https?:\/\//.test(a));
  const dev = given ? null : await startDev();
  try {
    await checkAll(dev ? dev.origin : given, argv);
  } finally {
    if (dev) {
      dev.stop();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
