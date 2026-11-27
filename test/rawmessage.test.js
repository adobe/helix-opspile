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
import { rawParts, rawText, readRawMessage } from '../src/agent/rawmessage.js';
import { formatMessage } from '../src/agent/deliver.js';
import { fakeBucket } from './fakes.js';

const TEAMS = 'teams/T/G/19:c@thread.tacv2/2026/11/16';

describe('raw_message', () => {
  it('shows a Teams body as HTML, without the envelope', () => {
    const text = rawText(rawParts(`${TEAMS}/1-1.json`, {
      '@odata.context': 'https://graph.example/$metadata',
      id: '1',
      from: { user: { id: 'u-1' } },
      body: { contentType: 'html', content: '<span style="color:#2B9B62">green</span>' },
      attachments: [],
    }));
    assert.equal(text, 'body (html):\n<span style="color:#2B9B62">green</span>');
  });

  it('shows the edited Slack message, and Discord\'s content and embeds', () => {
    const slack = rawParts('slack/E/C/2026/11/16/2-Ev.json', {
      event: {
        type: 'message',
        subtype: 'message_changed',
        message: { text: 'edited', files: [{ name: 'a.png', url_private: 'https://files.example/a', mimetype: 'image/png' }] },
      },
    });
    assert.deepEqual(slack, {
      text: 'edited',
      blocks: undefined,
      attachments: undefined,
      files: [{
        name: 'a.png', title: undefined, mimetype: 'image/png', permalink: undefined,
      }],
    });
    const discord = rawText(rawParts('discord/G/C/2026/11/16/3-h.json', {
      t: 'MESSAGE_CREATE', d: { content: 'hi', embeds: [{ title: 'card', color: 3066993 }] },
    }));
    assert.equal(discord, 'content:\nhi\n\nembeds (JSON):\n[\n {\n  "title": "card",\n  "color": 3066993\n }\n]');
  });

  it('reads the newest version a message has in pile 1', async () => {
    const put = (body, receivedAt) => ({ body: JSON.stringify(body), receivedAt });
    const versions = {
      [`${TEAMS}/1-1.json`]: put({ body: { content: 'old' } }, '2026-11-16T10:00:00Z'),
      [`${TEAMS}/2-1.json`]: put({ body: { content: 'new' } }, '2026-11-16T11:00:00Z'),
    };
    const RAW = fakeBucket();
    await Promise.all(Object.entries(versions).map(([key, v]) => RAW.put(key, v.body, {
      customMetadata: { receivedAt: v.receivedAt },
    })));
    const res = await readRawMessage({ RAW }, { raw: Object.keys(versions).reverse() });
    assert.deepEqual(res, { text: 'body (text):\nnew', versions: 2 });
    assert.match((await readRawMessage({ RAW }, { raw: [] })).error, /no copy/);
    assert.match((await readRawMessage({ RAW }, { raw: ['teams/gone.json'] })).error, /gone/);
  });

  it('is named under a message whose markdown dropped what Teams showed', () => {
    const m = {
      id: '17', at: 'at', author: { kind: 'person', name: 'Cy' }, body: '| W1 | site-one |', dropped: ['color', 'highlight'],
    };
    assert.match(formatMessage(m), /<\/message>\n\[It has text colors and highlights, which the markdown above cannot show: raw_message 17 shows it as sent\.\]$/);
    assert.match(formatMessage(m, null, { raw: false }), /<\/message>$/);
    assert.match(formatMessage({ ...m, dropped: undefined }), /<\/message>$/);
  });
});
