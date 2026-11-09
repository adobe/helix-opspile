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
  filePoster, forgetFiles, isText, mediaType, streamFile, threadFile,
} from '../src/fileview.js';

// Made-up workspaces, ids and files only.
const KEY = 'slack:E1:C1:1.1';
const CSV = 'https://acme.slack.com/files/U2/F0CSV/table.csv';
const PDF = 'https://acme.slack.com/files/U2/F0PDF/flow.pdf';
const HAR = 'https://acme.slack.com/files/U2/F0HAR/trace.har';
const MOV = 'https://acme.slack.com/files/U2/F0MOV/rec.mov';
const ODD = 'https://acme.slack.com/files/U2/F0ODD/odd.mov';
const VIDEO = 'a video, 0123456789';
const FILES = {
  F0MOV: {
    name: 'rec.mov', mimetype: 'video/quicktime', body: VIDEO, mp4: 'https://files.slack.com/files-tmb/T1-F0MOV/rec.mp4', thumb_video: 'https://files.slack.com/files-tmb/T1-F0MOV/rec_thumb_video.jpeg',
  },
  // A remote file: its URL is not Slack's, so the token never goes there.
  F0ODD: {
    name: 'odd.mov', mimetype: 'video/quicktime', body: '', url_private: 'https://elsewhere.example/odd.mov',
  },
  F0CSV: { name: 'table.csv', mimetype: 'text/csv', body: 'a,b\n1,2\n' },
  F0PDF: { name: 'flow.pdf', mimetype: 'application/pdf', body: '%PDF' },
  F0HAR: { name: 'trace.har', mimetype: 'application/octet-stream', body: '{"log":{}}' },
};
const MESSAGES = [
  { id: '1.1', at: 'a', body: `See.\n\nAttachments:\n- [table.csv](${CSV})\n- [flow.pdf](${PDF})\n- [trace.har](${HAR})\n- [rec.mov](${MOV})\n- [odd.mov](${ODD})` },
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
  let sent;
  beforeEach(() => {
    forgetFiles();
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
      sent.push({ url: String(url), headers: init.headers || {} });
      const u = new URL(url);
      if (u.pathname === '/api/files.info') {
        const id = u.searchParams.get('file');
        const f = FILES[id];
        return Response.json(f ? {
          ok: true,
          file: {
            id, url_private: `https://files.slack.com/files-pri/T1-${id}/${f.name}`, url_private_download: `https://files.slack.com/files-pri/T1-${id}/download/${f.name}`, size: f.body.length, ...f,
          },
        } : { ok: false, error: 'file_not_found' });
      }
      if (u.hostname === 'files.slack.com' && init.headers.authorization === 'Bearer xoxb-made-up') {
        if (u.pathname.endsWith('.jpeg')) {
          return new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } });
        }
        if (u.pathname.endsWith('.mp4')) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range || '');
          return m ? new Response(VIDEO.slice(Number(m[1]), Number(m[2]) + 1), {
            status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${m[1]}-${m[2]}/${VIDEO.length}`, 'content-length': String(Number(m[2]) - Number(m[1]) + 1) },
          }) : new Response(VIDEO, { headers: { 'content-type': 'video/mp4' } });
        }
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

  it('passes a large HAR through, and keeps the limit for other text', async () => {
    const big = 'x'.repeat(1024);
    FILES.F0HAR.size = 77 * 1024 * 1024;
    FILES.F0HAR.body = big;
    FILES.F0CSV.size = 11 * 1024 * 1024;
    try {
      assert.equal(await (await get(KEY, HAR)).text(), big);
      const csv = await get(KEY, CSV);
      assert.equal(csv.status, 502);
      assert.equal((await csv.json()).error, 'too large (11 MB; up to 10 MB)');
      FILES.F0HAR.size = 151 * 1024 * 1024;
      assert.equal((await (await get(KEY, HAR)).json()).error, 'too large (151 MB; up to 150 MB)');
    } finally {
      delete FILES.F0HAR.size;
      delete FILES.F0CSV.size;
      FILES.F0HAR.body = '{"log":{}}';
    }
  });

  it('refuses files that are not text, not of the thread, or of a deleted message', async () => {
    assert.equal((await get(KEY, PDF)).status, 415);
    assert.equal((await get(KEY, 'https://acme.slack.com/files/U2/F0GONE/gone.csv')).status, 404);
    assert.equal((await get(KEY, 'https://acme.slack.com/files/U2/F0OTHER/other.csv')).status, 404);
    assert.equal((await get('slack:E1:C1:9.9', CSV)).status, 404);
  });

  it('streams a video in the parts the player asks for, Slack\'s MP4 copy where there is one', async () => {
    const req = (range) => new Request('https://inbox.example/api/file/stream', { headers: range ? { range } : {} });
    const part = await streamFile(env, KEY, MOV, req('bytes=2-6'), { load });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'video');
    assert.equal(part.headers.get('content-type'), 'video/mp4');
    assert.equal(part.headers.get('content-range'), `bytes 2-6/${VIDEO.length}`);
    assert.equal(part.headers.get('accept-ranges'), 'bytes');
    assert.equal(sent.at(-1).url, FILES.F0MOV.mp4);
    assert.equal(sent.at(-1).headers.authorization, 'Bearer xoxb-made-up');
    // The thread and Slack's answer are kept: the next part costs one fetch.
    const before = sent.length;
    assert.equal(await (await streamFile(env, KEY, MOV, req(), { load })).text(), VIDEO);
    assert.equal(sent.length, before + 1);
    // Not video, not of the thread, or not on Slack's file host: refused, the token kept.
    assert.equal((await streamFile(env, KEY, CSV, req(), { load })).status, 415);
    assert.equal((await streamFile(env, KEY, 'https://acme.slack.com/files/U2/F0X/x.mov', req(), { load })).status, 404);
    assert.equal((await streamFile(env, KEY, ODD, req(), { load })).status, 502);
    assert.ok(!sent.some((c) => c.url.startsWith('https://elsewhere.example')));
  });

  it('shows Slack\'s still of a video as its poster', async () => {
    const res = await filePoster(env, KEY, MOV, { load });
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(await res.text(), 'jpeg');
    assert.equal((await filePoster(env, KEY, CSV, { load })).status, 404);
  });

  it('tells video and audio by type or name', () => {
    assert.equal(mediaType('video/quicktime', 'x'), 'video/quicktime');
    assert.equal(mediaType('application/octet-stream', 'a.MP4'), 'video/mp4');
    assert.equal(mediaType('', 'a.m4a'), 'audio/mp4');
    assert.equal(mediaType('text/html', 'a.html'), null);
  });

  it('tells text from other files', () => {
    assert.ok(isText('text/csv', 'x'));
    assert.ok(isText('application/json; charset=utf-8', 'x'));
    assert.ok(isText('application/octet-stream', 'a.LOG'));
    assert.ok(!isText('text/html', 'a.html'));
    assert.ok(!isText('application/pdf', 'a.pdf'));
  });
});
