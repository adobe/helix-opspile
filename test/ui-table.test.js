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

  describe('of a HAR', () => {
    const entry = (ms, status, url, time, more = {}) => ({
      startedDateTime: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms)).toISOString(),
      time,
      request: { method: 'GET', url },
      response: { status, content: { size: 2048, mimeType: 'application/json; charset=utf-8' } },
      ...more,
    });
    const text = (entries) => JSON.stringify({ log: { entries } });

    it('makes a row of each request, timed from the first', () => {
      const har = Table.har(text([
        entry(2000, 504, 'https://a.example/slow', 8214.6, { _resourceType: 'Fetch' }),
        entry(500, 200, 'https://a.example/x', 12),
      ]));
      assert.deepEqual(har.rows, [
        ['1.50', '504', 'GET', '8215', '2.0', 'fetch', 'a.example/slow'],
        ['0.00', '200', 'GET', '12', '2.0', 'json', 'a.example/x'],
      ]);
      assert.equal(har.summary, '1 failed · slowest 8.2 s');
      // Sort and filter take the columns as numbers.
      assert.ok([0, 1, 3, 4].every((c) => Table.numeric(har.rows, c)));
    });

    it('counts a request that got no answer as failed', () => {
      const har = Table.har(text([{ ...entry(0, 0, 'https://a.example/', 3), response: { status: 0 } }]));
      assert.equal(har.summary, '1 failed · slowest 0.0 s');
    });

    it('is no HAR when it is something else, or broken', () => {
      assert.equal(Table.har('{"log":{}}'), null);
      assert.equal(Table.har('{"log":{"ent'), null);
      assert.equal(Table.har('[]'), null);
    });

    it('keeps credentials out of what it shows', () => {
      const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
      assert.equal(
        Table.maskUrl('https://a.example/p?limit=5&access_token=made-up&state=x&code=made-up'),
        'a.example/p?limit=5&access_token=••••••&state=x&code=••••••',
      );
      assert.equal(Table.maskUrl(`https://a.example/p?t=${jwt}`), 'a.example/p?t=••••••');
      const url = 'https://a.example/?refresh_token=abc';
      assert.equal(Table.har(text([entry(0, 200, url, 1)])).rows[0][6], 'a.example/?refresh_token=••••••');
      for (const name of ['Authorization', 'cookie', 'Set-Cookie', 'x-api-key', 'X-Auth-Token', 'x-csrf-token']) {
        assert.ok(Table.secret(name, 'v'), name);
      }
      assert.ok(Table.secret('x-whatever', `Bearer ${jwt}`));
      assert.ok(!Table.secret('x-gw-ims-org-id', 'ABC@AdobeOrg'));
      assert.ok(!Table.secret('content-type', 'text/html'));
    });

    it('reads bodies: base64 text, indented JSON, not binaries', () => {
      assert.equal(Table.bodyText({ text: btoa('{"a":1}'), encoding: 'base64', mimeType: 'application/json' }), '{\n  "a": 1\n}');
      assert.equal(Table.bodyText({ text: 'AAAA', encoding: 'base64', mimeType: 'image/png' }), null);
      assert.equal(Table.bodyText({ mimeType: 'text/plain' }), null);
    });
  });
});
