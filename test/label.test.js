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
import { stateOf } from '../src/label.js';

// Made-up thread and people only.
describe('what the models read', () => {
  it('shows the reactions a message got, and whether a customer or Adobe left them', () => {
    const thread = {
      source: 'slack', channel_name: 'acme-support', org: 'acme', root_at: '2026-10-21T10:00:00Z',
    };
    const messages = [
      {
        id: '1.1', at: '2026-10-21T10:00:00Z', body: 'The page is broken', author: { kind: 'person', name: 'Cy' },
      },
      {
        id: '1.2', at: '2026-10-21T10:05:00Z', body: 'Fixed it', author: { kind: 'person', name: 'Ada', staff: true },
      },
    ];
    const reactions = new Map([['1.2', [
      { emoji: 'white_check_mark', name: 'Cy', staff: false },
      { emoji: 'eyes', name: 'Bo', staff: true },
    ]]]);
    const state = stateOf(thread, messages, reactions);
    assert.match(state, /Fixed it\nReactions: ✅ by Cy \(customer\), 👀 by Bo \(Adobe staff\)/);
    assert.doesNotMatch(state, /broken\nReactions/);
  });
});
