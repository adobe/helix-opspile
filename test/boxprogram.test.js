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
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { PROGRAM } from '../src/agent/boxprogram.js';

// A stdio MCP server standing in for chrome-devtools-mcp: no imports, so it runs as CommonJS
// and as an ES module. `roots` asks the client for its roots first; `stats` says what it saw.
const FAKE_SERVER = String.raw`
const seen = { initialize: 0, initialized: 0, cancelled: [], declined: null };
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let waiting = null;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === 'initialize') {
      seen.initialize += 1;
      out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    } else if (m.method === 'notifications/initialized') {
      seen.initialized += 1;
    } else if (m.method === 'notifications/cancelled') {
      seen.cancelled.push(m.params.requestId);
    } else if (m.method === 'tools/list') {
      out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'stats', inputSchema: { type: 'object' } }] } });
    } else if (m.method === 'tools/call' && m.params.name === 'roots') {
      waiting = m.id;
      out({ jsonrpc: '2.0', id: 'server-1', method: 'roots/list' });
    } else if (m.id === 'server-1') {
      seen.declined = m.error && m.error.code;
      out({ jsonrpc: '2.0', id: waiting, result: { content: [{ type: 'text', text: 'asked' }] } });
    } else if (m.method === 'tools/call' && m.params.name === 'slow') {
      // never answers
    } else if (m.method === 'tools/call' && m.params.name === 'quit') {
      process.exit(3);
    } else if (m.method === 'tools/call') {
      out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(seen) }], id: m.id } });
    }
  }
});
`;

const dir = mkdtempSync(join(tmpdir(), 'opspile-box-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});

let nextPort = 18500 + Math.floor(Math.random() * 500);
const running = [];
after(() => running.forEach((p) => p.kill('SIGKILL')));

/** Runs the program with `env`; resolves to `{ port, proc, log }` once it listens. */
async function box(env) {
  nextPort += 1;
  const port = nextPort;
  const proc = spawn(process.execPath, ['-e', PROGRAM], {
    env: {
      PATH: process.env.PATH, BOX_PORT: String(port), CDM_ARGS: '[]', ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  running.push(proc);
  const log = [];
  proc.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 100; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`http://127.0.0.1:${port}/health`);
      return { port, proc, log };
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
  }
  throw new Error(`the box did not listen: ${log.join('')}`);
}

async function health(port, want) {
  let res;
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.status === want) {
      return res.text();
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  return `${res.status} ${await res.text()}`;
}

const post = async (port, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};

describe('the browser box program', () => {
  it('serves a stdio MCP server over Streamable HTTP', async () => {
    const bin = join(dir, 'server.js');
    writeFileSync(bin, FAKE_SERVER);
    const { port } = await box({ CDM_BIN: bin, CDM_CALL_MS: '1500' });
    assert.equal(await health(port, 200), 'ready');

    const discover = await post(port, {
      jsonrpc: '2.0', id: 1, method: 'server/discover', params: {},
    });
    assert.equal(discover.body.error.code, -32601, 'a 2025-era server: fall back to initialize');
    const init = { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const first = await post(port, { ...init, id: 2 });
    assert.equal(first.body.id, 2);
    assert.equal(first.body.result.serverInfo.name, 'fake');
    assert.equal((await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    // A second connection: answered from memory, the server initialized once.
    const second = await post(port, { ...init, id: 'again' });
    assert.equal(second.body.id, 'again');
    assert.deepEqual(second.body.result, first.body.result);
    await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // The server's own requests are declined; the call still finishes.
    const roots = await post(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'roots', arguments: {} },
    });
    assert.equal(roots.body.result.content[0].text, 'asked');

    // Two connections may use the same id at once: each gets its own answer.
    const [a, b] = await Promise.all([
      post(port, {
        jsonrpc: '2.0', id: 7, method: 'tools/list', params: {},
      }),
      post(port, {
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'stats', arguments: {} },
      }),
    ]);
    assert.equal(a.body.id, 7);
    assert.equal(a.body.result.tools[0].name, 'stats');
    assert.equal(b.body.id, 7);
    assert.match(b.body.result.id, /^b\d+$/, 'the server saw an id of the box\'s own');

    // A cancelled call is cancelled under the id the server knows; it times out here.
    const slow = post(port, {
      jsonrpc: '2.0', id: 'slow-1', method: 'tools/call', params: { name: 'slow', arguments: {} },
    });
    await sleep(100);
    await post(port, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow-1' } });
    const timedOut = await slow;
    assert.equal(timedOut.body.error.code, -32001);
    const stats = JSON.parse((await post(port, {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'stats', arguments: {} },
    }))
      .body.result.content[0].text);
    assert.equal(stats.initialize, 1);
    assert.equal(stats.initialized, 1);
    assert.equal(stats.declined, -32601);
    assert.deepEqual(stats.cancelled.length, 1);
    assert.match(String(stats.cancelled[0]), /^b\d+$/);

    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`)).status, 405, 'no standing stream');
    assert.equal((await post(port, 'nope')).status, 200);
  });

  it('exits when the server does, so that the box starts over', async () => {
    const bin = join(dir, 'server.js');
    writeFileSync(bin, FAKE_SERVER);
    const { port, proc } = await box({ CDM_BIN: bin });
    await health(port, 200);
    const exited = new Promise((r) => {
      proc.on('exit', r);
    });
    post(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quit', arguments: {} },
    }).catch(() => {});
    assert.equal(await exited, 1);
  });

  it('installs the pinned package, and nothing that does not match its hash', async () => {
    const pkg = join(dir, 'pkg');
    mkdirSync(join(pkg, 'package/build/src/bin'), { recursive: true });
    writeFileSync(join(pkg, 'package/build/src/bin/chrome-devtools-mcp.js'), FAKE_SERVER);
    execFileSync('tar', ['-czf', join(dir, 'cdm.tgz'), '-C', pkg, 'package']);
    const tgz = readFileSync(join(dir, 'cdm.tgz'));
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const registry = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tgz);
    });
    await new Promise((r) => {
      registry.listen(0, '127.0.0.1', r);
    });
    const tarball = `http://127.0.0.1:${registry.address().port}/cdm.tgz`;
    try {
      const good = await box({ CDM_DIR: join(dir, 'good'), CDM_TARBALL: tarball, CDM_INTEGRITY: integrity });
      assert.equal(await health(good.port, 200), 'ready');
      const init = await post(good.port, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      assert.equal(init.body.result.serverInfo.name, 'fake');

      const bad = await box({ CDM_DIR: join(dir, 'bad'), CDM_TARBALL: tarball, CDM_INTEGRITY: 'sha512-AAAA' });
      assert.match(await health(bad.port, 500), /integrity/);
      assert.equal((await post(bad.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 503);
    } finally {
      registry.close();
    }
  });
});
