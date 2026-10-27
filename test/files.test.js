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
  fileRef, MAX_FILE_TEXT, pickFile, readThreadFile, SCREEN_CHUNK, threadFiles,
} from '../src/agent/files.js';

// Made-up workspaces, ids and files only.
const PDF = 'https://acme.slack.com/files/U2/F0PDF/flow.pdf';
const PNG = 'https://files.slack.com/files-pri/T1-F0PNG/shot.png';
const TXT = 'https://acme.slack.com/files/U2/F0TXT/notes.txt';
const MESSAGES = [
  { id: '1.1', at: 'a', body: `Here is the flow.\n\nAttachments:\n- [Quiz \\[v2\\] flow](${PDF})` },
  { id: '1.2', at: 'b', body: `![shot.png](${PNG} "10x10")\n\n- [notes.txt](${TXT})` },
  { id: '1.3', at: 'c', body: '- [secret.pdf](https://acme.slack.com/files/U2/F0BAD/secret.pdf)' },
  { id: '1.4', at: 'd', body: '[a page](https://example.com/page.pdf)' },
];
const FILES = {
  F0PDF: { name: 'flow.pdf', mimetype: 'application/pdf', size: 4 },
  F0PNG: { name: 'shot.png', mimetype: 'image/png', size: 4 },
  F0TXT: { name: 'notes.txt', mimetype: 'text/plain', size: 4 },
};
const readable = (m) => m.id !== '1.3';
const clean = async () => ({ p: 0.01, flagged: false });
/** A check that passes everything and notes what it was given. */
const recorder = (list, what) => async (t) => {
  list.push(what(t));
  return { p: 0.01, flagged: false };
};

describe('the files of a thread', () => {
  it('finds Slack and Discord files in the readable messages, by link or id', () => {
    assert.deepEqual(fileRef(PDF), { source: 'slack', id: 'F0PDF', url: PDF });
    assert.equal(fileRef(PNG).id, 'F0PNG');
    assert.equal(fileRef('https://cdn.discordapp.com/attachments/1/2/a.txt?ex=9').source, 'discord');
    assert.equal(fileRef('https://example.com/page.pdf'), null);
    const files = threadFiles(MESSAGES, readable);
    assert.deepEqual(files.map((f) => [f.id, f.name, f.message]), [
      ['F0PDF', 'Quiz [v2] flow', '1.1'], ['F0PNG', 'shot.png', '1.2'], ['F0TXT', 'notes.txt', '1.2'],
    ]);
    assert.equal(pickFile(files, 'f0pdf').id, 'F0PDF');
    assert.equal(pickFile(files, PNG).id, 'F0PNG');
    assert.equal(pickFile(files, 'https://acme.slack.com/files/U2/F0BAD/secret.pdf'), null);
  });
});

describe('read_file', () => {
  const realFetch = globalThis.fetch;
  let calls;
  let text;
  beforeEach(() => {
    calls = [];
    text = 'Persona -> Product Type -> Features';
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      calls.push({ url: String(url), auth: init.headers && init.headers.authorization });
      if (u.pathname === '/api/files.info') {
        const id = u.searchParams.get('file');
        const f = FILES[id];
        return Response.json(f ? {
          ok: true, file: { id, ...f, url_private_download: `https://files.slack.com/files-pri/T1-${id}/download/${f.name}` },
        } : { ok: false, error: 'file_not_found' });
      }
      if (u.hostname === 'files.slack.com') {
        if (init.headers.authorization !== 'Bearer xoxb-made-up') {
          return new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
        }
        const type = u.pathname.endsWith('.png') ? 'image/png' : 'application/octet-stream';
        return new Response(u.pathname.endsWith('.txt') ? text : new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': type } });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const converted = [];
  const env = (extra = {}) => ({
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    AI: {
      toMarkdown: async (doc) => {
        converted.push([doc.name, doc.blob.type]);
        return [{ name: doc.name, format: 'markdown', data: '# Holiday quiz\n\n1. Persona' }];
      },
    },
    ...extra,
  });
  const read = (e, wanted, more = {}) => readThreadFile(e, {
    messages: MESSAGES, readable, screen: clean, wanted, ...more,
  });

  it('converts a PDF to Markdown with the bot\'s token, and checks it for injections', async () => {
    const screened = [];
    const res = await read(env(), PDF, { screen: recorder(screened, (t) => t) });
    assert.equal(res.text, '# Holiday quiz\n\n1. Persona');
    assert.deepEqual([res.file.name, res.file.type, res.file.converted, res.file.message], ['flow.pdf', 'application/pdf', true, '1.1']);
    assert.deepEqual(converted.at(-1), ['flow.pdf', 'application/pdf']);
    assert.equal(calls.find((c) => c.url.includes('/download/')).auth, 'Bearer xoxb-made-up');
    assert.deepEqual(screened, ['# Holiday quiz\n\n1. Persona']);
  });

  it('hands images to the model as images, and plain text as it is, in parts', async () => {
    const img = await read(env(), 'F0PNG');
    assert.deepEqual([img.image.type, img.image.mimeType, img.image.data], ['image', 'image/png', 'AQIDBA==']);
    text = 'x'.repeat(MAX_FILE_TEXT + 10);
    const screened = [];
    const first = await read(env(), TXT, { screen: recorder(screened, (t) => t.length) });
    assert.equal(first.text.length, MAX_FILE_TEXT);
    assert.equal(first.more, MAX_FILE_TEXT);
    assert.equal(screened.length, Math.ceil(MAX_FILE_TEXT / SCREEN_CHUNK));
    const rest = await read(env(), TXT, { offset: first.more });
    assert.deepEqual([rest.text.length, rest.more], [10, undefined]);
  });

  it('withholds a file the check flags, and reads only the thread\'s readable files', async () => {
    const flagged = await read(env(), PDF, { screen: async () => ({ p: 0.93, flagged: true }) });
    assert.deepEqual([flagged.withheld, flagged.text], ['p=0.93', undefined]);
    calls = [];
    const hidden = await read(env(), 'https://acme.slack.com/files/U2/F0BAD/secret.pdf');
    assert.match(hidden.error, /not a file of your thread.*F0PDF/);
    const outside = await read(env(), 'https://example.com/page.pdf');
    assert.match(outside.error, /not a file of your thread/);
    assert.equal(calls.length, 0);
  });

  it('says why when Slack refuses the file or nothing can convert it', async () => {
    const missing = await readThreadFile(env(), {
      messages: [{ id: '2', body: '- [x](https://acme.slack.com/files/U2/F0GONE/x.pdf)' }], readable, screen: clean, wanted: 'F0GONE',
    });
    assert.match(missing.error, /Slack does not let opspile read this file \(file_not_found\)/);
    const noAi = await read(env({ AI: undefined }), PDF);
    assert.match(noAi.error, /cannot convert/);
    const noBot = await read(env({ SLACK_BOT_TOKEN: undefined }), PDF);
    assert.match(noBot.error, /Slack app is not set up/);
  });
});
