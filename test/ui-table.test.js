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
import { SCRIPTS } from './ui.js';

// ui/table.js as the page runs it: its global `Table`.
// eslint-disable-next-line no-new-func
const Table = new Function('globalThis', `${SCRIPTS['table.js']}\nreturn globalThis.Table;`)({});

describe('the file preview', () => {
  it('reads CSV as RFC 4180 has it: quotes, quoted commas and line breaks, CRLF', () => {
    const rows = Table.parse('\uFEFFname,note,n\r\n"a, b","say ""hi""",1\r\nc,"two\nlines",2\r\n\r\nd\r\n');
    assert.deepEqual(rows, [
      ['name', 'note', 'n'], ['a, b', 'say "hi"', '1'], ['c', 'two\nlines', '2'], ['d', '', ''],
    ]);
    assert.deepEqual(Table.parse('x,y'), [['x', 'y']]);
    assert.deepEqual(Table.parse(''), []);
  });

  it('finds the delimiter', () => {
    assert.equal(Table.sniff('a;b;c\n1;2;3'), ';');
    assert.equal(Table.sniff('a\tb\n1\t2'), '\t');
    assert.equal(Table.sniff('"a;b",c,d'), ',');
    assert.equal(Table.sniff('a,b', 'x.tsv'), '\t');
    assert.deepEqual(Table.parse('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  });

  it('tells columns of numbers from the others', () => {
    const rows = [['7,202', 'x', '34.6%', ''], ['90', 'y', '-0.4%', ''], ['', '3', '1e3', '']];
    assert.deepEqual([0, 1, 2, 3].map((c) => Table.numeric(rows, c)), [true, false, true, false]);
  });
});
