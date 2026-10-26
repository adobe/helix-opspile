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
 * The program a browser box runs in its container (src/agent/browser.js), as `node -e`: Node
 * and nothing else, so the box needs no image of its own. It fetches the pinned
 * chrome-devtools-mcp tarball (through the box's outbound handler, the container has no
 * Internet), checks its sha512, unpacks it, starts it on stdio and answers MCP's Streamable
 * HTTP on :8080 for it, one JSON response per POST:
 *
 * - `server/discover` gets "method not found", so 2026 clients fall back to `initialize`;
 * - the first `initialize` is forwarded and its result remembered, later ones are answered
 *   with it (one server process serves every connection of the box);
 * - requests are forwarded under ids of their own, so two connections' ids never collide;
 *   `notifications/cancelled` follows them;
 * - the server's own requests (roots, sampling, elicitation) are declined;
 * - `GET /health` says whether it is ready.
 *
 * If chrome-devtools-mcp exits, so does the program, and the box starts over with the next
 * request. Kept as a string, without backticks or template substitutions; the tests run it.
 */

export const PROGRAM = String.raw`const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const PORT = Number(process.env.BOX_PORT || 8080);
const DIR = process.env.CDM_DIR || '/opt/cdm';
const BIN = process.env.CDM_BIN || DIR + '/package/build/src/bin/chrome-devtools-mcp.js';
const TARBALL = process.env.CDM_TARBALL;
const INTEGRITY = process.env.CDM_INTEGRITY;
const ARGS = JSON.parse(process.env.CDM_ARGS || '[]');
const CALL_MS = Number(process.env.CDM_CALL_MS || 180000);

let child = null;
let state = 'installing';
let problem = null;
let init = null;
let initialized = false;
let buf = '';
let seq = 0;
const pending = new Map();
const byClientId = new Map();

const log = (...a) => console.error('[box]', ...a);

async function install() {
  if (fs.existsSync(BIN)) {
    return;
  }
  let res;
  for (let i = 0; i < 30; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(TARBALL);
      break;
    } catch (e) {
      // DNS for the intercepted host may not answer before the intercept is registered.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 1000); });
    }
  }
  if (!res || !res.ok) {
    throw new Error('could not fetch chrome-devtools-mcp (' + (res ? res.status : 'no answer') + ')');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (digest !== INTEGRITY) {
    throw new Error('chrome-devtools-mcp does not match its integrity hash');
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(DIR + '/cdm.tgz', bytes);
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', DIR + '/cdm.tgz', '-C', DIR], { stdio: 'inherit' });
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('tar exited ' + code))));
  });
}

function send(m) {
  child.stdin.write(JSON.stringify(m) + '\n');
}

function onLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    log('not JSON:', line.slice(0, 200));
    return;
  }
  if (m.method && m.id !== undefined) {
    // A request of the server's (roots, sampling, elicitation): this client offers none.
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'the client does not support ' + m.method } });
    return;
  }
  if (m.method) {
    return;
  }
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    p(m);
  }
}

function start() {
  child = spawn(process.execPath, [BIN, ...ARGS], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      CI: '1',
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
      CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1',
    },
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        onLine(line);
      }
      i = buf.indexOf('\n');
    }
  });
  child.on('exit', (code, signal) => {
    problem = 'chrome-devtools-mcp exited (' + (code ?? signal) + ')';
    state = 'failed';
    log(problem);
    for (const p of pending.values()) {
      p({ error: { code: -32000, message: problem } });
    }
    pending.clear();
    // The box starts over with the next request.
    setTimeout(() => process.exit(1), 100);
  });
  state = 'ready';
}

/** Forwards a request under an id of its own, so that two clients' ids never collide. */
function request(m, ms) {
  seq += 1;
  const id = 'b' + seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      byClientId.delete(String(m.id));
      resolve({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'timed out after ' + ms / 1000 + ' s' } });
    }, ms);
    byClientId.set(String(m.id), id);
    pending.set(id, (r) => {
      clearTimeout(timer);
      byClientId.delete(String(m.id));
      resolve({ ...r, jsonrpc: '2.0', id: m.id });
    });
    send({ ...m, id });
  });
}

async function handle(m) {
  if (!m || typeof m !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const isRequest = m.method && m.id !== undefined;
  if (m.method === 'server/discover' && isRequest) {
    // A 2025-era server: the client falls back to initialize.
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
  }
  if (m.method === 'initialize' && isRequest) {
    // One server process serves every client of this box: initialized once, then remembered.
    if (init) {
      return { jsonrpc: '2.0', id: m.id, result: init };
    }
    const r = await request(m, 60000);
    if (r.result) {
      init = r.result;
    }
    return r;
  }
  if (m.method === 'notifications/initialized') {
    if (!initialized) {
      initialized = true;
      send(m);
    }
    return null;
  }
  if (m.method === 'notifications/cancelled') {
    const id = m.params && byClientId.get(String(m.params.requestId));
    if (id) {
      send({ ...m, params: { ...m.params, requestId: id } });
    }
    return null;
  }
  if (isRequest) {
    return request(m, CALL_MS);
  }
  if (m.method) {
    send(m);
  }
  return null;
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  if (req.url === '/health') {
    reply(res, { ready: 200, failed: 500 }[state] || 503, problem || state);
    return;
  }
  if (req.url !== '/mcp') {
    reply(res, 404, 'not found');
    return;
  }
  if (req.method === 'GET') {
    reply(res, 405, 'no stream');
    return;
  }
  if (req.method === 'DELETE') {
    reply(res, 200, 'ok');
    return;
  }
  if (req.method !== 'POST') {
    reply(res, 405, 'POST only');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    if (state !== 'ready') {
      reply(res, 503, problem || state);
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const out = (await Promise.all((Array.isArray(body) ? body : [body]).map(handle)))
      .filter(Boolean);
    if (!out.length) {
      res.writeHead(202);
      res.end();
      return;
    }
    reply(res, 200, Array.isArray(body) ? out : out[0]);
  });
}).listen(PORT, '0.0.0.0');

install().then(start).catch((e) => {
  problem = 'install failed: ' + e.message;
  state = 'failed';
  log(problem);
});
`;
