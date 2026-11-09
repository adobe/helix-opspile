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
import { SOUNDS } from '../src/sound.js';

describe('sound', () => {
  it('serves the notifications\' sound as a small MP3', () => {
    const { type, base64 } = SOUNDS['/notify.mp3'];
    const mp3 = Buffer.from(base64, 'base64');
    assert.equal(type, 'audio/mpeg');
    // An MPEG audio frame's sync word, or an ID3 tag before it.
    assert.ok(mp3.subarray(0, 3).toString() === 'ID3' || (mp3[0] === 0xff && mp3[1] >= 0xe0));
    assert.ok(mp3.length < 32 * 1024, `${mp3.length} bytes`);
  });
});
