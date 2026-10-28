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
import {
  canonicalUrl, hostedImages, isTeamsFileKey, keptTeamsFile, shareId, teamsFileKey,
  threadChannel, withTeamsFiles,
} from '../src/teamsfiles.js';
import { api, media } from '../src/api.js';
import { indexMessage } from '../src/threads.js';
import { readThreadFile } from '../src/agent/files.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up ids only.
const KEY = 'teams/tenant-1/team-1/19:c@thread.tacv2/2026/10/28/1-2.json';
const THREAD = 'teams:tenant-1:team-1:19:c@thread.tacv2:1';
const WHERE = { tenant: 'tenant-1', team: 'team-1', channel: '19:c@thread.tacv2' };
const SHOT = 'https://contoso.sharepoint.com/sites/x/Shared Documents/Main/Screenshot 10.02.11\u202fAM.png';
const LOG = 'https://contoso.sharepoint.com/sites/x/Shared Documents/Main/build.log';
const HOSTED = 'https://graph.microsoft.com/v1.0/teams/team-1/channels/19:c@thread.tacv2/messages/1/hostedContents/aWQ9/$value';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const message = (extra = {}) => ({
  id: '2',
  replyToId: '1',
  createdDateTime: '2026-10-28T16:00:00Z',
  channelIdentity: { teamId: 'team-1', channelId: '19:c@thread.tacv2' },
  body: { contentType: 'html', content: '<attachment id="a-1"></attachment>' },
  attachments: [
    {
      id: 'a-1', contentType: 'reference', name: 'Screenshot 10.02.11\u202fAM.png', contentUrl: SHOT,
    },
    {
      id: 'a-2', contentType: 'reference', name: 'build.log', contentUrl: LOG,
    },
  ],
  ...extra,
});

/** A Graph that has the two SharePoint files and the hosted image, and counts its calls. */
function fakeGraph({ denied = false } = {}) {
  const calls = [];
  const items = {
    [shareId(canonicalUrl(SHOT))]: {
      name: 'Screenshot 10.02.11\u202fAM.png',
      size: PNG.length,
      file: { mimeType: 'image/png' },
      image: { width: 1280, height: 720 },
      '@microsoft.graph.downloadUrl': 'https://download.example/shot',
    },
    [shareId(canonicalUrl(LOG))]: {
      id: 'item-2', name: 'build.log', size: 5, file: { mimeType: 'text/plain' }, parentReference: { driveId: 'drive-1' },
    },
  };
  const graph = async (path) => {
    calls.push(path);
    if (path === HOSTED) {
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    if (path === '/drives/drive-1/items/item-2/content') {
      return new Response('lines', { headers: { 'content-type': 'text/plain' } });
    }
    const m = /^\/shares\/([^/]+)\/driveItem$/.exec(path);
    if (denied || !m || !items[m[1]]) {
      return new Response('{}', { status: denied ? 403 : 404 });
    }
    return Response.json(items[m[1]]);
  };
  return { graph, calls };
}

async function withDownloads(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    assert.equal(String(u), 'https://download.example/shot');
    return new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

describe('Teams files', () => {
  it('keys a copy by its channel and its canonical URL', async () => {
    assert.deepEqual(threadChannel(THREAD), WHERE);
    assert.equal(threadChannel('slack:E1:C1:1.1'), null);
    const key = await teamsFileKey(WHERE, SHOT);
    assert.match(key, /^teams\/tenant-1\/team-1\/19:c@thread\.tacv2\/files\/[0-9a-f]{64}$/);
    assert.equal(await teamsFileKey(WHERE, canonicalUrl(SHOT)), key, 'spaces or %20, one key');
    assert.equal(isTeamsFileKey(key), true);
    assert.equal(isTeamsFileKey(KEY), false);
    assert.deepEqual(hostedImages(`<p>x</p><img src="${HOSTED}" width="10"><img src="https://evil.example/a.png">`), [HOSTED]);
  });

  it('copies attached files and pasted images into pile 1, and marks the attachments', async () => {
    const RAW = fakeBucket();
    const { graph, calls } = fakeGraph();
    const payload = message({
      body: { contentType: 'html', content: `<p><img src="${HOSTED}"></p><attachment id="a-1"></attachment>` },
    });
    const out = await withDownloads(() => withTeamsFiles({ RAW }, KEY, payload, { graph }));
    assert.deepEqual(out.attachments[0].opspile, {
      type: 'image/png', size: PNG.length, width: 1280, height: 720,
    });
    assert.deepEqual(out.attachments[1].opspile, { type: 'text/plain', size: 5 });
    assert.equal(payload.attachments[0].opspile, undefined, 'the stored payload is not changed');
    const shot = RAW.objects.get(await teamsFileKey(WHERE, SHOT));
    assert.deepEqual([...shot.body], [...PNG]);
    assert.equal(shot.options.httpMetadata.contentType, 'image/png');
    assert.equal(shot.options.customMetadata.width, '1280');
    assert.equal(shot.options.customMetadata.via, 'shares');
    assert.equal(RAW.objects.get(await teamsFileKey(WHERE, HOSTED)).options.customMetadata.via, 'hostedContents');
    // Once kept, a file is not fetched again.
    const before = calls.length;
    const again = await withTeamsFiles({ RAW }, KEY, payload, { graph });
    assert.equal(calls.length, before);
    assert.equal(again.attachments[0].opspile.width, 1280);
  });

  it('leaves files Graph does not hand over as links, and other payloads alone', async () => {
    const RAW = fakeBucket();
    const { graph } = fakeGraph({ denied: true });
    const payload = message();
    assert.equal(await quiet(() => withTeamsFiles({ RAW }, KEY, payload, { graph })), payload);
    assert.equal(RAW.objects.size, 0);
    const deleted = message({ deletedDateTime: '2026-10-28T17:00:00Z' });
    assert.equal(await withTeamsFiles({ RAW }, KEY, deleted, { graph }), deleted);
    const slack = { event: {} };
    assert.equal(await withTeamsFiles({ RAW }, 'slack/E1/C1/x.json', slack, { graph }), slack);
    // Without an Entra app nothing is fetched.
    assert.equal(await withTeamsFiles({ RAW }, KEY, payload), payload);
  });

  it('serves the copies of images through the media proxy, and SharePoint only so', async () => {
    const RAW = fakeBucket();
    const { graph } = fakeGraph();
    await withDownloads(() => withTeamsFiles({ RAW }, KEY, message(), { graph }));
    const url = canonicalUrl(SHOT);
    const res = await media({ RAW }, url, THREAD);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);
    // Not an image, without its thread, or of another channel: never fetched from SharePoint.
    assert.equal((await media({ RAW }, canonicalUrl(LOG), THREAD)).status, 502);
    assert.equal((await media({ RAW }, url)).status, 404);
    assert.equal((await media({ RAW }, url, 'teams:tenant-1:team-1:19:other@thread.tacv2:1')).status, 404);
    assert.equal(await keptTeamsFile({ RAW }, 'slack:E1:C1:1.1', url), null);
  });

  it('serves a copy at /api/media only to those who may see its thread', async () => {
    const RAW = fakeBucket();
    const { graph } = fakeGraph();
    await withDownloads(() => withTeamsFiles({ RAW }, KEY, message(), { graph }));
    const DB = d1({ teams: [{ slug: 'private-ops', name: 'Private' }, { slug: 'other-ops', name: 'Other' }] });
    await indexMessage(DB, {
      source: 'teams',
      tenant: 'tenant-1',
      channelId: '19:c@thread.tacv2',
      org: 'acme',
      team: 'private-ops',
      kind: 'channel',
      counted: true,
      rootId: '1',
      id: '2',
      thread: THREAD,
      at: '2026-10-28T16:00:00Z',
      title: 'shot',
      path: 'p/',
    });
    const get = (teams, t = THREAD) => {
      const url = new URL(`https://opspile.test/api/media?u=${encodeURIComponent(canonicalUrl(SHOT))}${t ? `&t=${encodeURIComponent(t)}` : ''}`);
      return api(new Request(url), { DB, RAW }, url, { viewer: { id: 1, name: 'A', teams: teams.map((slug) => ({ slug, name: slug })) } });
    };
    assert.equal((await get(['private-ops'])).status, 200);
    assert.equal((await get(['other-ops'])).status, 404, 'another team');
    assert.equal((await get(['other-ops'], 'teams:tenant-1:team-1:19:c@thread.tacv2:9')).status, 404, 'an unknown thread');
    assert.equal((await get(['other-ops'], null)).status, 404, 'no thread');
  });

  it('lets agents read the copies', async () => {
    const RAW = fakeBucket();
    const { graph } = fakeGraph();
    await withDownloads(() => withTeamsFiles({ RAW }, KEY, message(), { graph }));
    const messages = [{
      id: '2', at: 'a', thread: THREAD, body: `![shot](${canonicalUrl(SHOT)} "1280x720")\n\nAttachments:\n\n- [build.log](${canonicalUrl(LOG)})`,
    }, {
      id: '3', at: 'b', thread: THREAD, body: '- [gone.pdf](https://contoso.sharepoint.com/sites/x/gone.pdf)',
    }];
    const read = (wanted) => readThreadFile({ RAW }, {
      messages, readable: () => true, screen: async () => ({ flagged: false }), wanted,
    });
    const log = await read(canonicalUrl(LOG));
    assert.equal(log.text, 'lines');
    assert.equal(log.file.name, 'build.log');
    const shot = await read(SHOT);
    assert.equal(shot.image.mimeType, 'image/png');
    assert.match((await read('https://contoso.sharepoint.com/sites/x/gone.pdf')).error, /no copy/);
  });
});
