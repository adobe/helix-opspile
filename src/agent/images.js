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

/**
 * Images the model can take. The Anthropic Messages API refuses a whole request when one of its
 * images is wider or taller than 8000 pixels (2000 when the request has more than 20 images), so
 * an image past that, once in the agent's history, would fail every later turn of its thread.
 * `imageSize` reads the size from the file's header without decoding it; `fitImages` leaves out
 * of a request the images the model would refuse.
 *
 * https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
 */

export const MAX_IMAGE_SIDE = 8000;
export const MANY_IMAGES = 20;
export const MANY_IMAGES_SIDE = 2000;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** The JPEG's size from its first frame header (SOF), or null. */
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      return null;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
    } else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
    } else {
      // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      }
      i += 2 + u16be(b, i + 2);
    }
  }
  return null;
}

/** The WebP's canvas size, or null. */
function webpSize(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (chunk === 'VP8 ' && b.length >= 30) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * An image's size in pixels from the start of its bytes, `{ width, height }`, or null when they
 * are not a PNG, JPEG, GIF or WebP it can read.
 */
export function imageSize(bytes) {
  const b = bytes;
  if (!b || b.length < 10) {
    return null;
  }
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b.length >= 24) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    return jpegSize(b);
  }
  if (ascii(b, 0, 3) === 'GIF') {
    return { width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' && b.length >= 16) {
    return webpSize(b);
  }
  return null;
}

/** The first bytes of base64 `data`, up to about `n`. */
function head(data, n) {
  const chars = Math.min(data.length, Math.ceil(n / 3) * 4);
  try {
    const s = atob(data.slice(0, chars - (chars % 4)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) {
      out[i] = s.charCodeAt(i);
    }
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * The size of a base64 image. A JPEG's frame header can come after its metadata (an EXIF
 * thumbnail, a color profile), so it reads further until it finds one.
 */
export function base64ImageSize(data) {
  const s = String(data || '');
  for (let n = 64 * 1024; ; n *= 4) {
    const size = imageSize(head(s, n));
    if (size || Math.ceil(n / 3) * 4 >= s.length) {
      return size;
    }
  }
}

/** Whether the model refuses an image this size, with `max` pixels a side. */
export const tooLargeImage = (size, max = MAX_IMAGE_SIDE) => Boolean(size)
  && (size.width > max || size.height > max);

const note = (size, max) => ({
  type: 'text',
  text: `[image left out: ${size.width}×${size.height} pixels, larger than the ${max} pixels a side the model takes]`,
});

/**
 * `messages` with every image the model would refuse replaced by a note saying so; the same
 * array when there is none.
 */
export function fitImages(messages) {
  const images = [];
  for (const m of messages || []) {
    for (const c of (Array.isArray(m.content) ? m.content : [])) {
      if (c && c.type === 'image') {
        images.push(c);
      }
    }
  }
  if (!images.length) {
    return messages;
  }
  const max = images.length > MANY_IMAGES ? MANY_IMAGES_SIDE : MAX_IMAGE_SIDE;
  const refused = new Map();
  for (const c of images) {
    const size = base64ImageSize(c.data);
    if (tooLargeImage(size, max)) {
      refused.set(c, note(size, max));
    }
  }
  if (!refused.size) {
    return messages;
  }
  return messages.map((m) => (Array.isArray(m.content) && m.content.some((c) => refused.has(c))
    ? { ...m, content: m.content.map((c) => refused.get(c) || c) } : m));
}
