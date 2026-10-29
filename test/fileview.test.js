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
import { isText, threadFile } from '../src/fileview.js';

// Made-up workspaces, ids and files only.
const KEY = 'slack:E1:C1:1.1';
const CSV = 'https://acme.slack.com/files/U2/F0CSV/table.csv';
const PDF = 'https://acme.slack.com/files/U2/F0PDF/flow.pdf';
const HAR = 'https://acme.slack.com/files/U2/F0HAR/trace.har';
const FILES = {
  F0CSV: { name: 'table.csv', mimetype: 'text/csv', body: 'a,b\n1,2\n' },
  F0PDF: { name: 'flow.pdf', mimetype: 'application/pdf', body: '%PDF' },
  F0HAR: { name: 'trace.har', mimetype: 'application/octet-stream', body: '{"log":{}}' },
};
const MESSAGES = [
  { id: '1.1', at: 'a', body: `See.\n\nAttachments:\n- [table.csv](${CSV})\n- [flow.pdf](${PDF})\n- [trace.har](${HAR})` },
  {
    id: '1.2', at: 'b', deletedAt: 'c', body: '- [gone.csv](https://acme.slack.com/files/U2/F0GONE/gone.csv)',
  },
];
const env = {
  SLACK_BOT_TOKEN: 'xoxb-made-up',
  DB: {
    prepare: () => ({ bind: (key) => ({ first: async () => (key === KEY ? { thread: KEY, path: 'p/' } : null) }) }),
  },
};
const load = async () => MESSAGES;
const get = (key, u) => threadFile(env, key, u, { load });

describe('GET /api/file', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === '/api/files.info') {
        const id = u.searchParams.get('file');
        const f = FILES[id];
        return Response.json(f ? {
          ok: true,
          file: {
            id, ...f, size: f.body.length, url_private_download: `https://files.slack.com/files-pri/T1-${id}/download/${f.name}`,
          },
        } : { ok: false, error: 'file_not_found' });
      }
      if (u.hostname === 'files.slack.com' && init.headers.authorization === 'Bearer xoxb-made-up') {
        const f = Object.values(FILES).find((x) => u.pathname.endsWith(`/${x.name}`));
        return new Response(f.body, { headers: { 'content-type': f.mimetype } });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('passes on a text file of the thread as plain text, never as what it says it is', async () => {
    const res = await get(KEY, CSV);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'a,b\n1,2\n');
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-file-type'), 'text/csv');
    assert.equal(decodeURIComponent(res.headers.get('x-file-name')), 'table.csv');
    // Text by its name where the platform does not say.
    assert.equal(await (await get(KEY, HAR)).text(), '{"log":{}}');
  });

  it('refuses files that are not text, not of the thread, or of a deleted message', async () => {
    assert.equal((await get(KEY, PDF)).status, 415);
    assert.equal((await get(KEY, 'https://acme.slack.com/files/U2/F0GONE/gone.csv')).status, 404);
    assert.equal((await get(KEY, 'https://acme.slack.com/files/U2/F0OTHER/other.csv')).status, 404);
    assert.equal((await get('slack:E1:C1:9.9', CSV)).status, 404);
  });

  it('tells text from other files', () => {
    assert.ok(isText('text/csv', 'x'));
    assert.ok(isText('application/json; charset=utf-8', 'x'));
    assert.ok(isText('application/octet-stream', 'a.LOG'));
    assert.ok(!isText('text/html', 'a.html'));
    assert.ok(!isText('application/pdf', 'a.pdf'));
  });
});
