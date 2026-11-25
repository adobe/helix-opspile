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
import { api } from '../src/api.js';
import {
  fileName, MAX_DRAFT_FILES, savedFiles, sniffImage, storeDraftFile,
} from '../src/draftfiles.js';
import { readComputerFile, workspacePath } from '../src/agent/computer.js';
import { agentToolsExtension, opspileExtension } from '../src/agent/tools.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, channels and pictures only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const ROOT = 'slack:E1:C1:1.1';
const TARGET = {
  key: ROOT, team: 'helix', org: 'acme', source: 'slack', tenant: 'E1', channelId: 'C1', threads: [ROOT],
};
// The first bytes of each kind, and enough after them.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    path, root_at, last_at, any_at, messages, updated_at) VALUES (?, 'slack', 'E1', 'C1', '1.1',
    'acme', 'helix', 'p/1.1/', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z',
    '2026-10-21T10:00:00Z', 1, '2026-10-21T10:00:00Z')`).run(ROOT);
  return {
    DB, FILES: fakeBucket(), CHANNELS: fakeBucket(), STAFF_DOMAINS: 'staff.example', SLACK_BOT_TOKEN: 'xoxb-made-up',
  };
}

const call = (e, method, path, body) => api(
  new Request(`https://opspile.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
  e,
  new URL(`https://opspile.test${path}`),
  { viewer: ADA },
);

/** A computer's working directory, in memory, as a Workspace's `fs` and as ctx.computerFile. */
function fakeComputer(files) {
  const fs = {
    async stat(path) {
      if (!(path in files)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { isFile: true, size: files[path].length };
    },
    async readFile(path) {
      return new Response(files[path]).body;
    },
  };
  return { fs, computerFile: (path, options) => readComputerFile(fs, path, options) };
}

function tools(e, computer, on = ['computer', 'post_message']) {
  const ctx = {
    env: e,
    hasThread: true,
    target: async () => TARGET,
    verdicts: async () => new Map(),
    inSidebar: async () => false,
    ...(computer ? { computerFile: computer.computerFile } : {}),
  };
  const all = [...opspileExtension(ctx).tools, ...(agentToolsExtension(ctx, on).tools || [])];
  const byName = Object.fromEntries(all.map((t) => [t.name, t]));
  return async (name, args) => {
    const res = await byName[name].execute(args, {});
    return { ...res, text: res.output.filter((o) => o.type === 'text').map((o) => o.text).join('') };
  };
}

describe('the files of a draft', () => {
  it('are pictures by their bytes, not their names', async () => {
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(JPEG), 'image/jpeg');
    assert.equal(sniffImage(new TextEncoder().encode('GIF89a…')), 'image/gif');
    assert.equal(sniffImage(SVG), null);
    assert.equal(fileName('/workspace/shots/a\u0007.png'), 'a.png');
    const e = env();
    assert.match((await storeDraftFile(e, { bytes: SVG, name: 'x.png' })).error, /x\.png is not a PNG, JPEG, GIF or WebP picture/);
    const { file } = await storeDraftFile(e, { bytes: PNG, name: 'shot.png' });
    assert.match(file.id, /^df_[0-9a-f-]{36}$/);
    assert.deepEqual({ ...file, id: 'x' }, {
      id: 'x', name: 'shot.png', type: 'image/png', size: PNG.length,
    });
    assert.equal(e.FILES.objects.get(`drafts/${file.id}`).options.httpMetadata.contentType, 'image/png');
  });

  it('are kept by id, or replaced, up to four', () => {
    const a = { id: 'df_a' };
    const b = { id: 'df_b' };
    assert.deepEqual(savedFiles([a, b]).files, [a, b]);
    assert.deepEqual(savedFiles([a, b], ['df_b']).files, [b]);
    assert.deepEqual(savedFiles([a, b], [], [{ id: 'df_c' }]).files, [{ id: 'df_c' }]);
    assert.match(savedFiles([a], ['df_z']).error, /not the draft's/);
    assert.match(savedFiles([], [], Array(MAX_DRAFT_FILES + 1).fill(a)).error, /at most 4 files/);
  });

  it('are found only in the working directory', async () => {
    assert.equal(workspacePath('shot.png'), '/workspace/shot.png');
    assert.equal(workspacePath('/workspace/a/../b.png'), '/workspace/b.png');
    assert.equal(workspacePath('../etc/passwd'), null);
    assert.equal(workspacePath('/tmp/x.png'), null);
    const { fs } = fakeComputer({ '/workspace/shot.png': PNG });
    assert.deepEqual(await readComputerFile(fs, 'shot.png'), { path: '/workspace/shot.png', name: 'shot.png', bytes: PNG });
    assert.match((await readComputerFile(fs, 'none.png')).error, /there is no file \/workspace\/none\.png/);
    assert.match((await readComputerFile(fs, 'shot.png', { max: 4 })).error, /over/);
  });
});

describe('the agent\'s screenshots', () => {
  const realFetch = globalThis.fetch;
  let sent;
  beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      sent.push({ path: u.pathname, body: init.body });
      if (u.pathname === '/api/files.getUploadURLExternal') {
        return Response.json({ ok: true, upload_url: 'https://files.slack.example/upload/1', file_id: 'F1' });
      }
      if (u.hostname === 'files.slack.example') {
        return new Response('OK');
      }
      if (u.pathname === '/api/files.completeUploadExternal') {
        return Response.json({ ok: true, files: [{ id: 'F1' }] });
      }
      if (u.pathname === '/api/conversations.replies' || u.pathname === '/api/conversations.history') {
        return Response.json({ ok: true, messages: [{ ts: '1.2', files: [{ id: 'F1' }] }] });
      }
      return Response.json({ ok: true, ts: '1.2' });
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('are looked at by the agent, from its computer', async () => {
    const run = tools(env(), fakeComputer({ '/workspace/shot.png': PNG, '/workspace/page.svg': SVG }));
    const seen = await run('view_image', { path: 'shot.png' });
    assert.equal(seen.isError, undefined);
    assert.match(seen.text, /^\/workspace\/shot\.png \(image\/png, 2×3 pixels, 1 KB\):$/);
    assert.deepEqual(seen.output[1], { type: 'image', data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png' });
    assert.match((await run('view_image', { path: 'page.svg' })).text, /is not a PNG, JPEG, GIF or WebP picture/);
    assert.match((await tools(env(), null)('view_image', { path: 'shot.png' })).text, /you have no computer/);
  });

  it('go with the draft, which the inbox shows and sends with them', async () => {
    const e = env();
    const run = tools(e, fakeComputer({ '/workspace/shot.png': PNG, '/workspace/page.svg': SVG }));
    const text = 'Here is how the banner looks at 390 pixels, with the fix.';
    const saved = await quiet(() => run('update_draft', { text, files: ['shot.png'] }));
    assert.equal(saved.isError, undefined, saved.text);
    assert.match(saved.text, /^saved \(version [^,]+, tags nobody, with shot\.png\)/);
    const { draft } = await (await call(e, 'GET', `/api/draft?thread=${encodeURIComponent(ROOT)}`)).json();
    assert.equal(draft.files.length, 1);
    const [f] = draft.files;
    assert.equal(f.name, 'shot.png');
    assert.match((await run('get_draft', {})).text, /files \(sent with it\):\n- shot\.png \(image\/png, 1 KB\)/);

    // The inbox gets the picture, as a picture that runs nothing.
    const res = await call(e, 'GET', `/api/draft/file?thread=${encodeURIComponent(ROOT)}&id=${f.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
    assert.equal((await call(e, 'GET', `/api/draft/file?thread=${encodeURIComponent(ROOT)}&id=df_00000000-0000-0000-0000-000000000000`)).status, 404);

    // A person's edit keeps them, or takes one off by leaving its id out.
    const kept = await (await call(e, 'PUT', '/api/draft', { thread: ROOT, text: `${text} Edited.`, base: draft.updated_at })).json();
    assert.deepEqual(kept.draft.files, draft.files);
    const off = await (await call(e, 'PUT', '/api/draft', {
      thread: ROOT, text, base: kept.draft.updated_at, files: [],
    })).json();
    assert.deepEqual(off.draft.files, []);

    // Only pictures, from the working directory; nothing is saved otherwise.
    assert.match((await run('update_draft', { text, base: off.draft.updated_at, files: ['page.svg'] })).text, /^Nothing was saved: \/workspace\/page\.svg is not a PNG/);
    assert.match((await run('update_draft', { text, base: off.draft.updated_at, files: ['/etc/passwd'] })).text, /^Nothing was saved: \/etc\/passwd is not a file of your working directory/);
    assert.match((await tools(e, null)('update_draft', { text, base: off.draft.updated_at, files: ['shot.png'] })).text, /^Nothing was saved: you have no computer/);
  });

  it('go with a post, where the channel takes them', async () => {
    const e = env();
    const run = tools(e, fakeComputer({ '/workspace/shot.png': PNG }));
    const res = await quiet(() => run('post_message', { text: 'The fix, at 390 pixels.', files: ['shot.png'] }));
    assert.equal(res.isError, undefined, res.text);
    assert.match(res.text, /^posted on Slack \(message [^ ]+, tags nobody, with shot\.png\)/);
    assert.ok(sent.some((s) => s.path === '/api/files.completeUploadExternal'));
    assert.match((await run('post_message', { text: 'x', files: ['none.png'] })).text, /^Nothing was posted: there is no file \/workspace\/none\.png/);
  });
});
