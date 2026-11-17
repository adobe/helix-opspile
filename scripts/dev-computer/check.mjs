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
 *   npm run computer:check -- --measure default,48/48 http://localhost:8788
 *
 * `--measure` checks nothing: it measures what an agent of the GitHub image costs, with each
 * cache it names (`measure`: the Worker's own, and what the isolate keeps in all and of one
 * file, in MiB), and how much memory is free in its object after it.
 * `--images` first puts into the Worker's bucket the objects of the images it lacks
 * (`syncImages`, as `npm run computer:images` does for a deployment). `COMPUTER_TOKEN` is sent
 * in `x-opspile-computer-token`, which the deployed Worker requires. Each run's agents are new
 * (`thread=check-<run>-…`), so a computer boots from nothing, as an agent's first command does.
 * First it waits for the computer to answer (`waitForReady`, two minutes at most: on stage it has
 * just been deployed). A request the network fails, or Cloudflare answers for a Worker not there
 * yet, is tried again a few times (`request`); a check fails only on what its command did, or
 * when that does not stop, and names the request. Exits 1 when a check fails, or a request does;
 * with GITHUB_STEP_SUMMARY, writes the results there too.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/**
 * Two commands of an agent of the GitHub image, in order, on a computer of their own: once the
 * second made its object exceed its memory (kernel 1.189.0 kept a copy of every program it
 * ran, gh's 50 MB too, beside the image cache's).
 */
export const GITHUB_SESSION = [
  'GH_TOKEN=x gh version | head -1 | cut -d" " -f1-2 && echo \'{"a":1}\' | jq -c .'
    + ' && printf "a\\n" | grep a | sed s/a/b/ | awk \'{print}\''
    + ' && curl -sS -o /dev/null -w "%{http_code}\\n" https://www.aem.live/'
    + ' && dig +short www.aem.live | grep -c . && qjs -e "console.log(6 * 7)"'
    + ' && openssl version | cut -d" " -f1',
  'cd /tmp && rm -rf c && git clone -q --depth 1 https://github.com/adobe/helix-shared c'
    + ' && git -C c log --oneline | wc -l && printf "a: 1\\n" | yq .a'
    + ' && GH_TOKEN=x gh version | head -1 | cut -d" " -f1-2'
    + ' && tar --version | head -1 | cut -d" " -f1-2 && gzip --version | head -1 | cut -d" " -f1'
    + ' && diff --version | head -1 | cut -d" " -f1 && tree --version | cut -d" " -f1'
    + ' && printf "<p>hi</p>" | html2markdown && echo hi | xxd -p && file -b c/package.json',
];
const GITHUB_SESSION_OUTPUT = [
  /^gh version\n\{"a":1\}\nb\n200\n[1-9]\d*\n42\nOpenSSL\n$/,
  /^1\n1\ngh version\ntar \(GNU\ngzip\ndiff\ntree\nhi\n68690a\nJSON text data\n$/,
];

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
  ...GITHUB_SESSION.map((command, i) => ({
    name: `github: a session, command ${i + 1} of ${GITHUB_SESSION.length}`,
    image: 'github',
    thread: 'github-session',
    command,
    match: GITHUB_SESSION_OUTPUT[i],
    timeout: 120,
  })),
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

/**
 * Files of the base image read in parts, as a program reads a data file (file's magic, under
 * the isolate's per-file limit, and yq's wasm, over it): whole, its first 1.5 MB, its last
 * 3 MB and 100 kB from 2 MB on, none of them where a piece of the image driver begins or
 * ends (src/agent/image.js), each checked against what `built` (`build`) has of it.
 */
export function rangeChecks(built) {
  const sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const base = built.images.find((i) => i.name === 'base');
  const files = new Map(base.layers.flatMap(({ name }) => built.layers.get(name).layer.files)
    .map((f) => [f.path, f]));
  return [
    'node_modules/@ai-ecoverse/wasm-file/share/misc/magic.mgc',
    'node_modules/@ai-ecoverse/wasi-yq/bin/yq.wasm',
  ].map((path) => {
    const body = built.blobs.get(files.get(path).sha256);
    const parts = [body, body.subarray(0, 1_500_000), body.subarray(body.length - 3_000_000),
      body.subarray(2_000_000, 2_100_000)];
    const at = `/opt/image/${path}`;
    return {
      name: `base: ${path.split('/').pop()} read whole and in parts`,
      command: `f=${at}; sha256sum < $f; head -c 1500000 $f | sha256sum;`
        + ' tail -c 3000000 $f | sha256sum; tail -c +2000001 $f | head -c 100000 | sha256sum',
      match: new RegExp(`^${parts.map((p) => `${sha256(p)}  -\\n`).join('')}$`),
      timeout: 120,
    };
  });
}

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
 * What a request to the computer is tried again on: Cloudflare's own answers while a Worker is
 * not there yet or is busy (429, 502–504, 520–530), and 403, which the Worker answers for an
 * old token while a deploy has not reached every isolate yet (the run before put an unknown one
 * there). Never 500, which is the Worker's own answer when a command throws, nor the answer of
 * a command that ran: what a check says of a program is its result, not a reason to try again.
 */
export const TRANSIENT = new Set([403, 408, 425, 429, 502, 503, 504,
  520, 521, 522, 523, 524, 525, 526, 527, 530]);

/** Whether `e` is fetch's own failure: the connection, not the request (undici's messages). */
export const isNetworkError = (e) => e instanceof TypeError
  && (e.message === 'fetch failed' || e.message === 'terminated');

/** `fetch failed (ECONNRESET)`: the error, and what undici says caused it. */
export function reasonOf(e) {
  const cause = e?.cause;
  const why = cause && (cause.code || cause.message);
  return why ? `${e.message} (${why})` : String(e?.message || e);
}

const pause = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Fetches `url` and reads the answer with `read` (`(res) => …`, the response itself when not
 * given), trying again on a network error, also one while reading the body, and on a TRANSIENT
 * status: `tries` times at most, `delay` ms after the first, twice as long after each next one
 * up to `maxDelay`. Every failure names `what` (`PUT /images/…`, never the origin: the stage
 * Worker's address names the account). The last answer, when it is a status still, is an error.
 */
export async function request(what, url, init = {}, {
  read = (res) => res, tries = 6, delay = 1000, maxDelay = 8000, sleep = pause,
  log = console.log,
} = {}) {
  for (let i = 1; ; i += 1) {
    let why;
    let cause;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, init);
      if (!TRANSIENT.has(res.status)) {
        // eslint-disable-next-line no-await-in-loop
        return await read(res);
      }
      why = `HTTP ${res.status}`;
      // eslint-disable-next-line no-await-in-loop
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      if (!isNetworkError(e)) {
        throw e;
      }
      why = reasonOf(e);
      cause = e;
    }
    if (i >= tries) {
      throw new Error(`${what}: ${why}, ${tries} tries`, { cause });
    }
    const ms = Math.min(delay * 2 ** (i - 1), maxDelay);
    log(`  ${what}: ${why}, again in ${ms} ms`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(ms);
  }
}

/**
 * Waits until the computer at `origin` answers `GET /health` with `ok` for `token`, for
 * `limit` ms at most: the Worker just deployed may not answer yet, or only with the old token.
 */
export async function waitForReady(origin, {
  token, limit = 120_000, every = 2000, sleep = pause, now = Date.now, log = console.log,
} = {}) {
  const until = now() + limit;
  let why;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${origin}/health`, { headers: headersOf(token) });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok && text.trim() === 'ok') {
        return;
      }
      why = `HTTP ${res.status}`;
    } catch (e) {
      if (!isNetworkError(e)) {
        throw e;
      }
      why = reasonOf(e);
    }
    if (now() + every > until) {
      throw new Error(`GET /health: ${why}, still after ${Math.round(limit / 1000)} s`);
    }
    log(`  GET /health: ${why}, again in ${every} ms`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(every);
  }
}

/**
 * Puts the objects of `built` (scripts/computer-images.mjs `build`) that the Worker at
 * `origin` lacks into its bucket, in upload order: how many it put. `retry` is `request`'s.
 */
export async function syncImages(origin, built, { token, log = console.log, retry = {} } = {}) {
  const objects = objectsOf(built);
  const read = (key) => request(`GET /images/${key}`, `${origin}/images/${key}`, {
    headers: headersOf(token),
  }, {
    log,
    ...retry,
    read: async (res) => {
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`could not read ${key}: ${res.status}`);
      }
      return res.text();
    },
  });
  const missing = await missingFrom(objects, read);
  for (const o of missing) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(`PUT /images/${o.key}`, `${origin}/images/${o.key}`, {
      method: 'PUT', body: o.body, headers: headersOf(token),
    }, { log, ...retry });
    if (!res.ok) {
      throw new Error(`could not put ${o.key}: ${res.status}`);
    }
  }
  log(`images: ${missing.length} of ${objects.length} objects put`);
  return missing.length;
}

/**
 * Runs `check` on the computer at `origin`: `{ name, ok, ms, output, exitCode, error }`. A
 * request the network failed is tried again (`request`), and the command with it: none of them
 * fails because it ran before.
 */
export async function runCheck(origin, check, { token, run, retry = {} }) {
  const image = check.image || 'base';
  const runtime = check.runtime || 'slicc-kernel';
  const thread = `check-${run}-${check.thread || (runtime === 'slicc-kernel' ? image : runtime)}`;
  const headers = { 'content-type': 'application/json', ...headersOf(token) };
  const started = Date.now();
  try {
    if (check.uploads) {
      const path = `/uploads?thread=${thread}`;
      const put = await request(`POST ${path}`, `${origin}${path}`, {
        method: 'POST', headers, body: JSON.stringify(check.uploads),
      }, retry);
      if (!put.ok) {
        throw new Error(`could not put the uploads: ${put.status}`);
      }
    }
    const { res, body } = await request(`POST /?thread=${thread}`, `${origin}/?thread=${thread}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: check.command,
        runtime,
        ...(runtime === 'slicc-kernel' ? { image } : {}),
        timeout: check.timeout || 60,
      }),
    }, {
      ...retry,
      // The body is read here, so that a connection lost while it comes is tried again too.
      read: async (r) => {
        const text = await r.text();
        try {
          return { res: r, body: JSON.parse(text) };
        } catch {
          return { res: r, body: { error: `HTTP ${r.status}` } };
        }
      },
    });
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

/**
 * The caches `--measure` tries: `{ label, mib, fileMib }` (null sizes: the Worker's own), from
 * `spec` (`default,48/48,64/64`: what the isolate keeps in all, and of one file, in MiB).
 */
export function cachesOf(spec = 'default') {
  return String(spec).split(',').filter(Boolean).map((c) => {
    const m = /^(\d+)\/(\d+)$/.exec(c);
    return m ? { label: c, mib: Number(m[1]), fileMib: Number(m[2]) }
      : { label: 'default', mib: null, fileMib: null };
  });
}

const MB = (n) => Math.round((n || 0) / 1e5) / 10;

/**
 * What an agent of the GitHub image costs, on the computer at `origin`, with each of `caches`
 * (cachesOf), each on an agent of its own: GITHUB_SESSION, then its kernel ended and the first
 * command again (as when the object lets its kernel go and boots it again), each with its time
 * and what the isolate asked of the images bucket then; and at the end how much memory its
 * object had free (`/probe`, `step` MiB more each time until the isolate is reset, or `max`;
 * each held for a second).
 * `[{ label, steps: [{ name, ms, ok, gets, fetchedMB, keptMB, error }], freeMiB }]`.
 */
export async function measure(origin, caches, {
  token, run, step = 8, max = 256, log = console.log,
} = {}) {
  const headers = { 'content-type': 'application/json', ...headersOf(token) };
  const post = async (thread, path, body) => {
    const res = await fetch(`${origin}${path}?thread=${thread}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return { status: res.status, ...JSON.parse(text) };
    } catch {
      return { status: res.status, error: text.trim().slice(0, 200) };
    }
  };
  const out = [];
  for (const cache of caches) {
    const thread = `measure-${run}-${cache.label.replace(/\//g, '-')}`;
    const steps = [];
    // What the isolate asked of the bucket before (another agent's, in the same isolate).
    // eslint-disable-next-line no-await-in-loop
    let before = (await post(thread, '/probe', { mib: 0 }).catch(() => ({}))).images || null;
    const exec = async (name, command, first) => {
      const started = Date.now();
      const body = await post(thread, '/', {
        command,
        image: 'github',
        timeout: 120,
        ...(first ? { cache: cache.mib ? { mib: cache.mib, fileMib: cache.fileMib } : {} } : {}),
      }).catch((e) => ({ error: reasonOf(e) }));
      const now = body.images;
      const result = {
        name,
        ms: Date.now() - started,
        ok: !body.error && body.exitCode === 0,
        gets: now && before ? now.gets - before.gets : now?.gets,
        fetchedMB: MB(now && before ? now.fetched - before.fetched : now?.fetched),
        keptMB: MB(now?.bytes),
        ...(body.error ? { error: `${body.error}${body.message ? `: ${body.message}` : ''}`.slice(0, 160) } : {}),
      };
      before = now || null;
      steps.push(result);
      log(`  ${cache.label}: ${name}: ${result.ok ? 'ok' : 'FAIL'} ${result.ms} ms, ${result.gets ?? '–'} GETs`
        + ` (${result.fetchedMB} MB), ${result.keptMB} MB kept${result.error ? `, ${result.error}` : ''}`);
    };
    // eslint-disable-next-line no-await-in-loop
    await exec('command 1', GITHUB_SESSION[0], true);
    // eslint-disable-next-line no-await-in-loop
    await exec('command 2', GITHUB_SESSION[1]);
    // eslint-disable-next-line no-await-in-loop
    await post(thread, '/drop', {}).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await exec('command 1, its kernel booted again', GITHUB_SESSION[0]);
    let freeMiB = 0;
    for (let mib = step; mib <= max; mib += step) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(thread, '/probe', { mib }).catch((e) => ({ error: reasonOf(e) }));
      if (res.error || res.mib !== mib) {
        break;
      }
      freeMiB = mib;
    }
    log(`  ${cache.label}: ${freeMiB} MiB free after it (${freeMiB >= max ? 'at least' : 'to the nearest'} ${step} MiB)`);
    out.push({ label: cache.label, steps, freeMiB });
  }
  return out;
}

/** What `measure` found, as a Markdown table. */
export function measuredOf(results, { max = 256 } = {}) {
  const rows = results.flatMap((r) => [
    ...r.steps.map((s) => `| ${r.label} | ${s.ok ? '✅' : '❌'} ${s.name} | ${s.ms} ms | ${s.gets ?? '–'}`
      + ` (${s.fetchedMB} MB) | ${s.keptMB} MB |${s.error ? ` ${s.error.replace(/\|/g, '/')}` : ''}`),
    `| ${r.label} | free in the object after it | ${r.freeMiB >= max ? '≥ ' : ''}${r.freeMiB} MiB | | |`,
  ]);
  return ['### What an agent of the GitHub image costs', '',
    '| Cache (MiB, of one file) | Step | Time | GETs (fetched) | Kept |', '| --- | --- | --- | --- | --- |',
    ...rows, ''].join('\n');
}

async function checkAll(origin, argv) {
  const token = process.env.COMPUTER_TOKEN;
  const built = await build();
  await waitForReady(origin, { token });
  if (argv.includes('--images')) {
    await syncImages(origin, built, { token });
  }
  const run = process.env.GITHUB_RUN_ID || Date.now().toString(36);
  if (argv.includes('--measure')) {
    const spec = argv[argv.indexOf('--measure') + 1];
    const results = await measure(origin, cachesOf(/^https?:/.test(spec || '') ? undefined : spec), {
      token, run: `${run}-${process.env.GITHUB_RUN_ATTEMPT || 1}`,
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, measuredOf(results));
    }
    return;
  }
  const checks = [...CHECKS, ...rangeChecks(built), ...built.images.map(commandsCheck)];
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
  } catch (e) {
    // What failed, by its request, not an uncaught rejection (and not the origin it went to).
    console.log(`FAIL ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (dev) {
      dev.stop();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
