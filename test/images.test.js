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

/* eslint-disable no-bitwise -- image headers: sizes in bytes and bits */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base64ImageSize, fitImages, imageSize, tooLargeImage,
} from '../src/agent/images.js';
import { fittingApi } from '../src/agent/model.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

const png = (width, height) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
};

/** A JPEG whose frame header comes after `apps` segments of metadata (APP1, as EXIF would be). */
const jpeg = (width, height, apps = 1, pad = 10) => {
  const app = Array.from({ length: apps }, () => [
    0xff, 0xe1, ((pad + 2) >> 8) & 0xff, (pad + 2) & 0xff, ...new Array(pad).fill(0),
  ]).flat();
  const sof = [0xff, 0xc2, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
    ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app, ...sof, 0xff, 0xd9]);
};

const riff = (chunk, body) => new Uint8Array([
  ...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from(chunk), 0, 0, 0, 0, ...body,
]);

describe('image sizes', () => {
  it('reads them from PNG, JPEG, GIF and WebP headers', () => {
    assert.deepEqual(imageSize(png(1440, 9000)), { width: 1440, height: 9000 });
    assert.deepEqual(imageSize(jpeg(8192, 600)), { width: 8192, height: 600 });
    assert.deepEqual(imageSize(new Uint8Array([...Buffer.from('GIF89a'), 0x40, 0x1f, 0x10, 0])), { width: 8000, height: 16 });
    // VP8X: 24-bit sizes minus one.
    assert.deepEqual(imageSize(riff('VP8X', [0, 0, 0, 0, 0x3f, 0x1f, 0, 0x1f, 0, 0])), { width: 8000, height: 32 });
    // VP8L: 14 bits each, minus one, after the signature byte.
    const bits = 99 | (9 << 14);
    assert.deepEqual(imageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff])), { width: 100, height: 10 });
    assert.equal(imageSize(new Uint8Array([1, 2, 3, 4])), null);
    assert.equal(imageSize(new Uint8Array(0)), null);
  });

  it('finds a JPEG\'s frame header past large metadata, from base64', () => {
    assert.deepEqual(base64ImageSize(b64(jpeg(300, 9001))), { width: 300, height: 9001 });
    // 180 KB of metadata: past the first 64 KB it reads.
    assert.deepEqual(base64ImageSize(b64(jpeg(300, 200, 3, 60000))), { width: 300, height: 200 });
    assert.equal(base64ImageSize('not base64!'), null);
    assert.equal(tooLargeImage({ width: 8000, height: 8000 }), false);
    assert.equal(tooLargeImage({ width: 8001, height: 10 }), true);
    assert.equal(tooLargeImage(null), false);
  });
});

describe('fitting images into a request', () => {
  const tool = (data) => ({
    role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'File:' }, { type: 'image', data, mimeType: 'image/png' }],
  });

  it('leaves out the images the model would refuse, and nothing else', () => {
    const fine = [{ role: 'user', content: 'hi' }, tool(b64(png(1200, 7000)))];
    assert.equal(fitImages(fine), fine);
    const tall = [fine[0], tool(b64(png(1440, 9000))), fine[1]];
    const out = fitImages(tall);
    assert.equal(out[0], tall[0]);
    assert.equal(out[2], tall[2]);
    assert.deepEqual(out[1].content[1], {
      type: 'text', text: '[image left out: 1440×9000 pixels, larger than the 8000 pixels a side the model takes]',
    });
    assert.equal(tall[1].content[1].type, 'image');
  });

  it('holds images to 2000 pixels a side in a request with more than 20', () => {
    const many = Array.from({ length: 21 }, (_, i) => tool(b64(png(100, i ? 100 : 2400))));
    assert.match(fitImages(many)[0].content[1].text, /2400 pixels, larger than the 2000/);
    assert.equal(fitImages(many.slice(0, 20))[0].content[1].type, 'image');
  });

  it('fits the context of every request the agent\'s model gets', () => {
    const seen = [];
    const api = fittingApi({
      stream: (model, context) => seen.push(context),
      streamSimple: (model, context) => seen.push(context),
    });
    const context = { systemPrompt: 's', messages: [tool(b64(png(9000, 10)))] };
    api.streamSimple({}, context);
    api.stream({}, { messages: [] });
    assert.equal(seen[0].systemPrompt, 's');
    assert.equal(seen[0].messages[0].content[1].type, 'text');
    assert.deepEqual(seen[1].messages, []);
  });
});
