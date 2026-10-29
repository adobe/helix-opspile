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
import { fold, mentionScore, rankMentions } from '../src/mention-match.js';

// Made-up people only.
const KIRA = { name: 'Kira Selby', aliases: ['kselby', 'kselby@staff.example'] };

describe('mention matching', () => {
  it('ignores case and accents', () => {
    assert.equal(fold('Zoë ÅSTRÖM'), 'zoe astrom');
    for (const q of ['K', 'k', 'KIRA', 'kIrA', 'Kira S', 'kira selby']) {
      assert.equal(mentionScore(q, KIRA), 0, q);
    }
    assert.equal(mentionScore('zoe', { name: 'Zoë Åström' }), 0);
    assert.equal(mentionScore('ASTR', { name: 'Zoë Åström' }), 2);
  });

  it('matches the start of any word of the name, the login or the mail', () => {
    assert.equal(mentionScore('sel', KIRA), 2); // the last name
    assert.equal(mentionScore('kse', KIRA), 1); // the login
    assert.equal(mentionScore('KSel', KIRA), 1);
    assert.equal(mentionScore('ira', KIRA), -1); // not the start of a word
    assert.equal(mentionScore('elby', KIRA), -1);
    // Words start after hyphens, apostrophes, dots and commas too.
    assert.equal(mentionScore('luc', { name: 'Jean-Luc Picard' }), 2);
    assert.equal(mentionScore('neil', { name: "Tess O'Neil" }), 2);
    assert.equal(mentionScore('last', { name: 'Someone', aliases: ['first.last@example.com'] }), 3);
    assert.equal(mentionScore('first', { name: 'Last, First' }), 2);
    // Only the mail's name counts, not its domain.
    assert.equal(mentionScore('staff', KIRA), -1);
  });

  it('matches several words in any order, over the name and the others', () => {
    assert.equal(mentionScore('selby k', KIRA), 4);
    assert.equal(mentionScore('kira kse', KIRA), 5);
    assert.equal(mentionScore('kira x', KIRA), -1);
  });

  it('matches everyone when nothing is typed yet', () => {
    assert.equal(mentionScore('', KIRA), 0);
    assert.equal(mentionScore('  ', KIRA), 0);
  });

  it('puts the thread, then the channel, then the best match, then staff, then the name first', () => {
    const people = [
      { name: 'Anna Klein', staff: true },
      { name: 'Bo Kim', staff: true, member: true },
      { name: 'Kai Lund' },
      { name: 'Kira Selby', aliases: ['kselby'], staff: true },
      { name: 'Karl Ek', staff: true },
      { name: 'Lu Kent', here: true },
      { name: 'Ove Berg', staff: true },
    ];
    const names = (q, max) => rankMentions(people, q, max).map((p) => p.name);
    // A capital K: names that start with K come before last names that do.
    assert.deepEqual(names('K'), ['Lu Kent', 'Bo Kim', 'Karl Ek', 'Kira Selby', 'Kai Lund', 'Anna Klein']);
    assert.deepEqual(names('kse'), ['Kira Selby']);
    assert.deepEqual(names('', 3), ['Lu Kent', 'Bo Kim', 'Anna Klein']);
  });

  it('puts the Adobe people who know the topic after the customers in the thread', () => {
    const people = [
      { name: 'Ann Cust', here: true },
      { name: 'Bea Here', staff: true, here: true },
      { name: 'Cy Member', member: true },
      { name: 'Di Expert', staff: true, affinity: 0.1 },
      {
        name: 'Ed Expert', staff: true, affinity: 0.3, member: true,
      },
      { name: 'Flo Staff', staff: true },
      // An affinity only counts for staff.
      { name: 'Gus Cust', affinity: 0.9 },
    ];
    const names = (q) => rankMentions(people, q).map((p) => p.name);
    assert.deepEqual(names(''), [
      'Ann Cust', 'Ed Expert', 'Di Expert', 'Bea Here', 'Cy Member', 'Flo Staff', 'Gus Cust',
    ]);
    // What is typed still has to match.
    assert.deepEqual(names('e'), ['Ed Expert', 'Di Expert']);
  });
});
