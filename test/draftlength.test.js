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
  draftLength, lengthNote, LIMITS, postLengthNote, TYPICAL,
} from '../src/agent/draftlength.js';

const of = (n) => 'x'.repeat(n);

describe('draft length', () => {
  it('has the bounds of one and two standard deviations of staff replies', () => {
    assert.deepEqual(TYPICAL, [42, 480]);
    assert.deepEqual(LIMITS, [12, 1625]);
  });

  it('passes a typical reply without a note', () => {
    const l = draftLength(of(140));
    assert.equal(l.verdict, 'ok');
    assert.equal(l.chars, 140);
    assert.equal(lengthNote(l), '');
  });

  it('warns beyond one standard deviation, either way', () => {
    const long = draftLength(of(900));
    assert.equal(long.verdict, 'warn');
    assert.match(lengthNote(long), /^The draft is 900 characters, longer than the replies Adobe staff write \(most are 42 to 480\)\. Shorten it/);
    const short = draftLength(of(20));
    assert.equal(short.verdict, 'warn');
    assert.match(lengthNote(short), /shorter than the replies Adobe staff write \(most are 42 to 480\)\. Check that it says enough/);
  });

  it('fails beyond two standard deviations, either way', () => {
    const long = draftLength(of(2000));
    assert.equal(long.verdict, 'fail');
    assert.match(lengthNote(long), /over the 1625 a draft may have\. Nothing was saved\./);
    const short = draftLength('Thanks!');
    assert.equal(short.verdict, 'fail');
    assert.match(lengthNote(short), /under the 12 a draft needs\. Nothing was saved\./);
    assert.equal(draftLength('').verdict, 'fail');
  });

  it('counts the text without the spaces around it, up to the limits', () => {
    assert.equal(draftLength(`  ${of(480)}\n`).chars, 480);
    assert.equal(draftLength(of(480)).verdict, 'ok');
    assert.equal(draftLength(of(1625)).verdict, 'warn');
    assert.equal(draftLength(of(1626)).verdict, 'fail');
  });

  it('lets the agent post a reply up to a typical staff reply, however short', () => {
    assert.equal(postLengthNote('Done.'), '');
    assert.equal(postLengthNote(of(480)), '');
    assert.match(postLengthNote(of(481)), /^The reply is 481 characters, longer than you may post yourself: 480, as most replies Adobe staff write are 42 to 480\. Nothing was posted\./);
  });
});
