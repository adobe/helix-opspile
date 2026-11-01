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
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import {
  FILE_TTL_MS, keepThreadFiles, MAX_MOUNT_FILE, mountList, uploadsMount,
} from '../src/threadfiles.js';

// Made-up workspaces, ids and files only.
const NOW = Date.parse('2026-06-30T00:00:00.000Z');
const LOG = 'https://acme.slack.com/files/U2/F0LOG/app.log';
const HAR = 'https://acme.slack.com/files/U2/F0HAR/trace.har';
const OLD = 'https://acme.slack.com/files/U2/F0OLD/old.log';
const BAD = 'https://acme.slack.com/files/U2/F0BAD/bad.log';
const HUGE = 'https://acme.slack.com/files/U2/F0HUG/huge.log';
const FILES = {
  F0LOG: { name: 'app.log', mimetype: 'text/plain', body: 'a log' },
  F0HAR: {
    name: 'trace.har',
    mimetype: 'application/octet-stream',
    body: JSON.stringify({
      log: {
        entries: [{
          request: { method: 'GET', url: 'https://a.example/?token=made-up' },
          response: { status: 200, content: { text: 'the body' } },
        }],
      },
    }),
  },
  F0OLD: { name: 'old.log', mimetype: 'text/plain', body: 'old' },
  F0BAD: { name: 'bad.log', mimetype: 'text/plain', body: 'withheld' },
  F0HUG: {
    name: 'huge.log', mimetype: 'text/plain', body: 'x', size: 200 * 1024 * 1024,
  },
};
const THREAD = 'slack:E1:C1:1.1';
const msg = (id, url, at = '2026-06-29T00:00:00.000Z') => ({
  id, at, thread: THREAD, body: `See.\n\nAttachments:\n- [file](${url})`,
});

/** An R2 bucket in memory. */
function bucket() {
  const objects = new Map();
  const obj = (key) => {
    const o = objects.get(key);
    return o && {
      key,
      size: o.bytes.length,
      customMetadata: o.customMetadata,
      body: new Response(o.bytes).body,
    };
  };
  return {
    objects,
    head: async (key) => obj(key) || null,
    get: async (key) => obj(key) || null,
    put: async (key, body, options) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, ...options });
      return { key, size: bytes.length };
    },
  };
}

describe('the files of a thread', () => {
  const realFetch = globalThis.fetch;
  let env;
  beforeEach(() => {
    env = { SLACK_BOT_TOKEN: 'xoxb-made-up', FILES: bucket() };
    globalThis.FixedLengthStream = function FixedLengthStream() {
      return new TransformStream();
    };
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === '/api/files.info') {
        const id = u.searchParams.get('file');
        return Response.json({
          ok: true,
          file: {
            id, url_private: `https://files.slack.com/files-pri/T1-${id}/x`, ...FILES[id], size: FILES[id].size || FILES[id].body.length,
          },
        });
      }
      if (u.hostname === 'files.slack.com' && init.headers.authorization) {
        const id = /T1-(F[A-Z0-9]+)/.exec(u.pathname)[1];
        return new Response(FILES[id].body, { headers: { 'content-type': FILES[id].mimetype } });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.FixedLengthStream;
  });
  const keep = (messages, options = {}) => keepThreadFiles(env, messages, { now: NOW, ...options });

  it('copies a file once, and says when it expires', async () => {
    const [copy] = await keep([msg('1', LOG)]);
    assert.equal(copy.name, 'app.log');
    assert.equal(copy.size, 5);
    assert.equal(copy.expires, Date.parse('2026-06-29T00:00:00.000Z') + FILE_TTL_MS);
    assert.equal(env.FILES.objects.size, 1);
    const stored = env.FILES.objects.get(copy.key);
    assert.deepEqual(stored.customMetadata, { name: 'app.log', thread: THREAD, message: '1' });
    assert.ok(copy.key.startsWith(`${THREAD}/`));
    const fetched = globalThis.fetch;
    globalThis.fetch = async () => assert.fail('copied already');
    assert.deepEqual(await keep([msg('1', LOG)]), [copy]);
    globalThis.fetch = fetched;
  });

  it('writes the requests of a HAR beside it, without its bodies', async () => {
    const [copy] = await keep([msg('1', HAR)]);
    const lines = new TextDecoder().decode(env.FILES.objects.get(copy.requests.key).bytes);
    assert.ok(lines.includes('token=[hidden]'));
    assert.ok(!lines.includes('the body'));
    assert.deepEqual(await keep([msg('1', HAR)]), [copy]);
  });

  it('leaves files older than the 30 days, of withheld messages, and too large', async () => {
    const copies = await keep([
      msg('1', OLD, new Date(NOW - FILE_TTL_MS - 1000).toISOString()),
      msg('2', BAD),
      msg('3', HUGE),
      msg('4', LOG),
    ], { readable: (m) => m.id !== '2' });
    assert.deepEqual(copies.map((c) => c.name), ['app.log']);
  });

  it('goes on after a file that cannot be had', async () => {
    env.FILES.put = async (key, body, options) => {
      await new Response(body).arrayBuffer();
      if (options.customMetadata.name === 'bad.log') {
        throw new Error('no');
      }
      return { size: 1 };
    };
    assert.deepEqual((await keep([msg('1', BAD), msg('2', LOG)])).map((c) => c.name), ['app.log']);
  });
});

describe('the uploads folder', () => {
  const copy = (name, size, more = {}) => ({
    key: `k/${name}`, name, size, expires: 1000, ...more,
  });

  it('names files so that no two meet and none leaves the folder', () => {
    const { files } = mountList([
      copy('a.log', 1), copy('a.log', 1), copy('../../etc/passwd', 1), copy('.env', 1), copy('INDEX.txt', 1),
    ]);
    assert.deepEqual(files.map((f) => f.path), ['a.log', 'a-2.log', '_.._etc_passwd', 'env', 'INDEX-2.txt']);
  });

  it('leaves out what the shell cannot read, and says so, but keeps a HAR\'s requests', () => {
    const list = mountList([
      copy('big.har', MAX_MOUNT_FILE + 1, { requests: { key: 'k/r', size: 100 } }),
      copy('small.log', 10),
    ]);
    assert.deepEqual(list.files, [
      { key: 'k/r', path: 'big.har.requests.ndjson' }, { key: 'k/small.log', path: 'small.log' },
    ]);
    assert.match(list.index, /big\.har \(30\.0 MB\): too large for the shell, not here; .*big\.har\.requests\.ndjson/);
    assert.match(list.index, /small\.log \(0\.0 MB\)/);
  });

  it('stops at what a thread may hold', () => {
    const list = mountList(Array.from({ length: 8 }, (_, i) => copy(`${i}.log`, MAX_MOUNT_FILE)));
    assert.equal(list.files.length, 6);
    assert.equal(list.index.split('\n').filter((l) => l.includes('not here')).length, 2);
  });

  it('says when the first file goes', () => {
    assert.equal(mountList([copy('a', 1), copy('b', 1, { expires: 500 })]).expires, 500);
    assert.equal(mountList([]).expires, Infinity);
  });

  it('fills the mount, skipping what the bucket no longer has', async () => {
    const list = mountList([copy('a.log', 1), copy('gone.log', 1)]);
    const written = new Map();
    const bucketLike = { get: async (key) => (key === 'k/a.log' ? { body: new Response('a').body } : null) };
    const mount = uploadsMount(bucketLike, async () => list);
    assert.equal(mount.mode, 'read-only');
    await mount.materialize({
      root: '/workspace/uploads',
      writeFile: async (path, body) => written.set(path, await new Response(body).text()),
    });
    assert.deepEqual([...written.keys()], ['/workspace/uploads/INDEX.txt', '/workspace/uploads/a.log']);
    assert.equal(written.get('/workspace/uploads/a.log'), 'a');
  });

  it('has a new version when its list changes', async () => {
    let list = mountList([copy('a.log', 1)]);
    const mount = uploadsMount({}, async () => list);
    const first = await mount.version();
    assert.equal(await mount.version(), first);
    list = mountList([]);
    assert.notEqual(await mount.version(), first);
  });
});
