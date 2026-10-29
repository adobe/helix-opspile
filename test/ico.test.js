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
import { inflateSync } from 'node:zlib';
import {
  decodeDib, encodePng, icoEntries, icoToPng,
} from '../src/ico.js';

const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

/**
 * A 2×2 bitmap entry: `bpp` 32 (BGRA, with `alpha`) or 1 (a palette of black and red), the
 * top-left pixel masked out in the AND mask.
 */
function dib(bpp, { alpha = true } = {}) {
  const stride = Math.floor((bpp * 2 + 31) / 32) * 4;
  const palette = bpp === 1 ? 8 : 0;
  const b = new Uint8Array(40 + palette + stride * 2 + 4 * 2);
  const v = new DataView(b.buffer);
  v.setUint32(0, 40, true);
  v.setInt32(4, 2, true);
  v.setInt32(8, 4, true);
  v.setUint16(12, 1, true);
  v.setUint16(14, bpp, true);
  if (bpp === 1) {
    b.set([0, 0, 0, 0, 0, 0, 255, 0], 40); // black, red (BGR0)
  }
  const xor = 40 + palette;
  for (let row = 0; row < 2; row += 1) {
    for (let x = 0; x < 2; x += 1) {
      if (bpp === 32) {
        b.set([0, 0, 255, alpha ? 255 : 0], xor + row * stride + x * 4);
      }
    }
    if (bpp === 1) {
      b[xor + row * stride] = 0b11000000; // both pixels red
    }
  }
  // AND mask, bottom-up: the top row (stored second) has its left pixel masked.
  b[xor + stride * 2 + 4] = 0b10000000;
  return b;
}

/** An .ico of the given entries (`[width, bytes]`). */
function ico(entries) {
  const head = 6 + 16 * entries.length;
  const out = new Uint8Array(head + entries.reduce((n, [, e]) => n + e.length, 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, entries.length, true);
  let at = head;
  entries.forEach(([width, e], i) => {
    out[6 + 16 * i] = width;
    v.setUint32(6 + 16 * i + 8, e.length, true);
    v.setUint32(6 + 16 * i + 12, at, true);
    out.set(e, at);
    at += e.length;
  });
  return out;
}

/** A PNG's size and RGBA pixels, read back with Node's zlib. */
function readPng(png) {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  const idat = png.subarray(41, 41 + v.getUint32(33));
  const raw = inflateSync(idat);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0);
    rows.push([...raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))]);
  }
  return { width, height, rows };
}

describe('ico', () => {
  it('lists the entries of an .ico, and nothing for other bytes', () => {
    const file = ico([[16, dib(32)], [2, dib(1)]]);
    assert.deepEqual(icoEntries(file).map((e) => [e.width, e.bytes.length]), [
      [16, dib(32).length], [2, dib(1).length]]);
    assert.deepEqual(icoEntries(new TextEncoder().encode('<html>')), []);
  });

  it('decodes 32-bit and 1-bit bitmaps, with the AND mask', () => {
    const pixels = (d) => [...d.rgba].reduce((rows, x, i) => {
      if (i % 4 === 0) {
        rows.push([]);
      }
      rows.at(-1).push(x);
      return rows;
    }, []);
    // 32-bit with alpha: its own alpha, the mask is ignored.
    assert.deepEqual(pixels(decodeDib(dib(32))), [RED, RED, RED, RED]);
    // 32-bit without alpha: transparency from the mask.
    assert.deepEqual(pixels(decodeDib(dib(32, { alpha: false }))), [CLEAR, RED, RED, RED]);
    assert.deepEqual(pixels(decodeDib(dib(1))), [CLEAR, RED, RED, RED]);
    const d = decodeDib(dib(1));
    assert.deepEqual([d.width, d.height], [2, 2]);
    assert.equal(decodeDib(new Uint8Array(10)), null);
  });

  it('writes a PNG that reads back the same', async () => {
    const png = await encodePng({ width: 2, height: 1, rgba: new Uint8Array([...RED, ...CLEAR]) });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual(readPng(png), { width: 2, height: 1, rows: [[...RED, ...CLEAR]] });
  });

  it('turns the largest size of an .ico into a PNG', async () => {
    const png = await icoToPng(ico([[1, dib(1)], [2, dib(32)]]));
    assert.deepEqual(readPng(png).rows, [[...RED, ...RED], [...RED, ...RED]]);
    // A PNG entry is taken as it is.
    const inner = await encodePng({ width: 1, height: 1, rgba: new Uint8Array(RED) });
    assert.deepEqual([...await icoToPng(ico([[4, inner]]))], [...inner]);
    assert.equal(await icoToPng(new Uint8Array(4)), null);
  });
});
