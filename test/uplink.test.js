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
import { describe, it } from 'node:test';
import { DOH_JSON, errnoOf, socketUplink } from '../src/agent/uplink.js';

/** A socket as `cloudflare:sockets` makes it, whose far end answers `reply` to what it gets. */
function fakeSocket({ opened, reply = (b) => b } = {}) {
  const sent = [];
  let closed = false;
  let push;
  const readable = new ReadableStream({
    start(controller) {
      push = controller;
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      sent.push(chunk);
      push.enqueue(reply(chunk));
    },
    close() {
      push.close();
    },
  });
  return {
    sent,
    get closed() {
      return closed;
    },
    opened: opened || Promise.resolve({ remoteAddress: '192.0.2.7:443', localAddress: '10.0.0.2:51000' }),
    readable,
    writable,
    close: async () => {
      closed = true;
    },
  };
}

describe('the uplink of the computer', () => {
  it('routes every outside address to it, IPv4 only, and no UDP', () => {
    const uplink = socketUplink({ connect: () => {}, fetch: () => {} });
    assert.deepEqual(uplink.traits, { tcp: true, udp: false, ipv6: false });
    assert.deepEqual(uplink.routes, { prefixes: [], exit: true });
  });

  it('dials port 443 over a Worker socket, without TLS of its own, and carries bytes both ways', async () => {
    const dialled = [];
    let socket;
    const uplink = socketUplink({
      connect: (address, options) => {
        dialled.push([address, options]);
        socket = fakeSocket({ reply: (b) => b.map((x) => x + 1) });
        return socket;
      },
      fetch: () => {},
    });
    const conn = await uplink.dial({
      network: 'tcp', host: '192.0.2.7', port: 443, signal: new AbortController().signal,
    });
    assert.deepEqual(dialled, [[{ hostname: '192.0.2.7', port: 443 },
      { secureTransport: 'off', allowHalfOpen: true }]]);
    assert.deepEqual([conn.localAddr, conn.remoteAddr], ['10.0.0.2:51000', '192.0.2.7:443']);
    assert.equal(await conn.write(new Uint8Array([1, 2])), 2);
    assert.deepEqual([...await conn.read()], [2, 3]);
    conn.closeWrite();
    assert.equal(await conn.read(), null);
    conn.close();
    assert.ok(socket.closed);
  });

  it('refuses every other port, and turns a failed connect into the errno the kernel takes', async () => {
    const uplink = socketUplink({
      connect: () => fakeSocket({ opened: Promise.reject(new Error('connection refused')) }),
      fetch: () => {},
    });
    const { signal } = new AbortController();
    await assert.rejects(uplink.dial({
      network: 'tcp', host: '192.0.2.7', port: 22, signal,
    }), { code: 'ENETUNREACH', message: /only port 443/ });
    await assert.rejects(uplink.dial({
      network: 'tcp', host: '192.0.2.7', port: 443, signal,
    }), { code: 'ECONNREFUSED' });
    const throwing = socketUplink({
      connect: () => {
        throw new Error('proxy request failed, cannot connect to the specified address');
      },
      fetch: () => {},
    });
    await assert.rejects(throwing.dial({
      network: 'tcp', host: '192.0.2.7', port: 443, signal,
    }), { code: 'EHOSTUNREACH' });
    assert.deepEqual(
      ['Connection timed out', 'stream was reset', 'x'].map(errnoOf),
      ['ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'],
    );
  });

  it('closes a socket whose dial the kernel gave up on', async () => {
    let socket;
    const uplink = socketUplink({
      connect: () => {
        socket = fakeSocket({ opened: new Promise(() => {}) });
        return socket;
      },
      fetch: () => {},
    });
    const abort = new AbortController();
    uplink.dial({
      network: 'tcp', host: '192.0.2.7', port: 443, signal: abort.signal,
    }).catch(() => {});
    abort.abort();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.ok(socket.closed);
  });

  it('resolves names over DNS over HTTPS, A records only, with their TTL', async () => {
    const asked = [];
    const answers = {
      'www.example.com': {
        Answer: [
          { type: 5, data: 'edge.example.net.', TTL: 300 },
          { type: 1, data: '192.0.2.1', TTL: 120 },
          { type: 1, data: '192.0.2.2', TTL: 60 },
        ],
      },
      'none.example.com': { Status: 3 },
    };
    const uplink = socketUplink({
      connect: () => {},
      fetch: async (url, init) => {
        asked.push([url, init.headers.accept]);
        const name = new URL(url).searchParams.get('name');
        return name === 'down.example.com'
          ? new Response('', { status: 502 }) : Response.json(answers[name]);
      },
    });
    assert.deepEqual(await uplink.resolve('www.example.com', 0), {
      addresses: ['192.0.2.1', '192.0.2.2'], ttl: 60,
    });
    assert.deepEqual(asked[0], [`${DOH_JSON}?name=www.example.com&type=A`, 'application/dns-json']);
    assert.deepEqual(await uplink.resolve('none.example.com', 4), []);
    assert.deepEqual(await uplink.resolve('down.example.com', 4), []);
    assert.deepEqual(await uplink.resolve('www.example.com', 6), []);
    assert.equal(asked.length, 3);
  });
});
