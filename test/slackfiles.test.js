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
import { slackFileKey, withSlackFiles } from '../src/slackfiles.js';
import { fakeBucket } from './fakes.js';

// Made-up ids only.
const FILE = {
  id: 'F1', name: 'flow.pdf', permalink: 'https://example.slack.com/files/U2/F1/flow.pdf',
};
const stub = { id: 'F1', file_access: 'check_file_info', filetype: 'pdf' };
const env = () => ({
  RAW: fakeBucket({
    [slackFileKey('E1', 'C1', 'F1')]: JSON.stringify({ type: 'file_info', file: FILE }),
  }),
});

describe('Slack Connect files', () => {
  it('fills stubs in edits and backfilled messages from pile 1, without asking Slack', async () => {
    const edit = {
      type: 'event_callback',
      event: { type: 'message', subtype: 'message_changed', message: { ts: '1.1', files: [stub] } },
    };
    const out = await withSlackFiles(env(), 'slack/E1/C1/2026/10/21/1.2-Ev.json', edit);
    assert.deepEqual(out.event.message.files, [FILE]);
    assert.deepEqual(edit.event.message.files, [stub], 'the delivered payload is not changed');
    const backfill = { type: 'backfill', message: { ts: '1.1', files: [stub] } };
    const filled = await withSlackFiles(env(), 'slack/E1/C1/2026/10/21/1.1-backfill.json', backfill);
    assert.deepEqual(filled.message.files, [FILE]);
  });

  it('leaves other payloads and other sources alone', async () => {
    const plain = { type: 'event_callback', event: { type: 'message', files: [FILE] } };
    assert.equal(await withSlackFiles(env(), 'slack/E1/C1/2026/10/21/1.1-Ev.json', plain), plain);
    const teams = { files: [stub] };
    assert.equal(await withSlackFiles(env(), 'teams/T/x.json', teams), teams);
  });
});
