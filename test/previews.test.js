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
import { render } from '../src/channels.js';
import { sweepPreviews } from '../src/previews.js';
import { indexMessage } from '../src/threads.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up ids and names only.
const PATH = 'channels/acme/helix/slack-C1/1.1/';
const msg = (thread, id, at, extra = {}) => ({
  source: 'slack',
  tenant: 'E1',
  channelId: 'C1',
  rootId: '1.1',
  id,
  thread,
  at,
  author: 'Cy',
  counted: true,
  title: `title ${id}`,
  org: 'acme',
  team: 'helix',
  kind: 'channel',
  path: PATH,
  ...extra,
});
const file = (id, body, extra = {}) => render({
  source: 'slack', id, at: '2026-10-21T10:00:00Z', ...extra,
}, body);

describe('sweepPreviews', () => {
  it('fills in the latest message\'s text of threads indexed before it was kept', async () => {
    const DB = d1();
    // Indexed without a preview, as before migration 0035.
    await indexMessage(DB, msg('slack:E1:C1:1.1', '1.1', '2026-10-21T10:00:00Z'));
    await indexMessage(DB, msg('slack:E1:C1:1.1', '1.2', '2026-10-21T10:05:00Z'));
    await indexMessage(DB, msg('slack:E1:C1:2.1', '2.1', '2026-10-21T11:00:00Z', {
      rootId: '2.1', path: 'channels/acme/helix/slack-C1/2.1/',
    }));
    await indexMessage(DB, msg('slack:E1:C1:3.1', '3.1', '2026-10-21T12:00:00Z', {
      rootId: '3.1', path: 'channels/acme/helix/slack-C1/3.1/', preview: 'kept',
    }));
    const CHANNELS = fakeBucket({
      [`${PATH}1.1.md`]: file('1.1', 'help'),
      [`${PATH}1.2.md`]: file('1.2', '**On it**, see\n[the log](https://x.example/l)'),
      // 2.1's file is gone: done, with no text.
    });
    assert.deepEqual(await sweepPreviews({ DB, CHANNELS }), { filled: 2, failed: 0 });
    const rows = DB.rows('SELECT thread, last_text FROM threads ORDER BY thread');
    assert.deepEqual(rows, [
      { thread: 'slack:E1:C1:1.1', last_text: 'On it, see the log' },
      { thread: 'slack:E1:C1:2.1', last_text: '' },
      { thread: 'slack:E1:C1:3.1', last_text: 'kept' },
    ]);
    const [{ preview }] = DB.rows('SELECT preview FROM messages WHERE id = ?', '1.2');
    assert.equal(preview, 'On it, see the log');
    // A later message of the thread keeps it: the thread row is derived from the messages.
    await indexMessage(DB, msg('slack:E1:C1:1.1', '1.3', '2026-10-21T10:06:00Z', {
      author: 'bot', counted: false, preview: 'beep',
    }));
    const [{ last_text: kept }] = DB.rows('SELECT last_text FROM threads WHERE thread = ?', 'slack:E1:C1:1.1');
    assert.equal(kept, 'On it, see the log');
    assert.deepEqual(await sweepPreviews({ DB, CHANNELS }), { filled: 0, failed: 0 });
  });

  it('leaves a thread whose file it could not read for the next run', async () => {
    const DB = d1();
    await indexMessage(DB, msg('slack:E1:C1:1.1', '1.1', '2026-10-21T10:00:00Z'));
    const CHANNELS = {
      get: async () => {
        throw new Error('R2 is down');
      },
    };
    const { warn } = console;
    console.warn = () => {};
    try {
      assert.deepEqual(await sweepPreviews({ DB, CHANNELS }), { filled: 0, failed: 1 });
    } finally {
      console.warn = warn;
    }
    assert.equal(DB.rows('SELECT last_text FROM threads')[0].last_text, null);
  });
});
