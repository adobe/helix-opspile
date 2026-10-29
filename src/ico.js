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

/*
 * .ico files as PNG, for Clef (which reads PNG, JPEG and WebP): an .ico keeps each of its sizes
 * either as a PNG or as a bitmap (a DIB without its file header, twice as high, the AND mask of
 * transparency after the colours). `icoToPng` takes its largest size; a bitmap is decoded
 * (1, 4, 8, 24 or 32 bits a pixel, uncompressed) and written as an RGBA PNG.
 */

/* eslint-disable no-bitwise -- a decoder of bits: pixels, masks and checksums */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Larger bitmaps than this (pixels a side) are not decoded. */
const MAX_SIDE = 256;

const isPng = (b) => b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x);

/** The entries of an .ico: `{ width, bytes }`, or none when it is not one. */
export function icoEntries(bytes) {
  if (bytes.length < 6 || bytes[0] || bytes[1] || bytes[2] !== 1 || bytes[3]) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i < view.getUint16(4, true) && 6 + 16 * (i + 1) <= bytes.length; i += 1) {
    const e = 6 + 16 * i;
    const size = view.getUint32(e + 8, true);
    const offset = view.getUint32(e + 12, true);
    if (offset + size <= bytes.length) {
      out.push({ width: bytes[e] || 256, bytes: bytes.subarray(offset, offset + size) });
    }
  }
  return out;
}

/**
 * A bitmap entry's pixels: `{ width, height, rgba }` (top row first), or null for what is not
 * an uncompressed 1/4/8/24/32-bit DIB.
 */
export function decodeDib(b) {
  if (b.length < 40) {
    return null;
  }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const header = v.getUint32(0, true);
  const width = v.getInt32(4, true);
  const height = Math.abs(v.getInt32(8, true)) / 2;
  const bpp = v.getUint16(14, true);
  const compression = v.getUint32(16, true);
  if (header < 40 || width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE
    || ![1, 4, 8, 24, 32].includes(bpp) || compression !== 0) {
    return null;
  }
  const colours = bpp <= 8 ? (v.getUint32(32, true) || 2 ** bpp) : 0;
  const palette = header;
  const xor = palette + colours * 4;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const and = xor + stride * height;
  const maskStride = Math.floor((width + 31) / 32) * 4;
  if (xor + stride * height > b.length) {
    return null;
  }
  const hasMask = and + maskStride * height <= b.length;
  const rgba = new Uint8Array(width * height * 4);
  let alphaSeen = false;
  for (let y = 0; y < height; y += 1) {
    // Rows are stored bottom-up.
    const row = xor + (height - 1 - y) * stride;
    const maskRow = and + (height - 1 - y) * maskStride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      let bgra;
      if (bpp === 32) {
        bgra = [b[row + x * 4], b[row + x * 4 + 1], b[row + x * 4 + 2], b[row + x * 4 + 3]];
        alphaSeen = alphaSeen || bgra[3] > 0;
      } else if (bpp === 24) {
        bgra = [b[row + x * 3], b[row + x * 3 + 1], b[row + x * 3 + 2], 255];
      } else {
        const bit = x * bpp;
        const index = (b[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & (2 ** bpp - 1);
        const p = palette + index * 4;
        bgra = [b[p], b[p + 1], b[p + 2], 255];
      }
      // A 32-bit bitmap has its own alpha; the others are transparent where the mask says.
      const masked = bpp !== 32 && hasMask && (b[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
      rgba.set(masked ? [0, 0, 0, 0] : [bgra[2], bgra[1], bgra[0], bgra[3]], o);
    }
  }
  // A 32-bit bitmap without alpha (all zero) takes its transparency from the mask.
  if (bpp === 32 && !alphaSeen) {
    for (let y = 0; y < height; y += 1) {
      const maskRow = and + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x += 1) {
        const masked = hasMask && (b[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        const o = (y * width + x) * 4;
        rgba.set(masked ? [0, 0, 0, 0] : [...rgba.subarray(o, o + 3), 255], o);
      }
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const x of bytes) {
    c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib (RFC 1950) of `bytes`, with the platform's CompressionStream. */
async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An RGBA image as a PNG. */
export async function encodePng({ width, height, rgba }) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    // Filter type 0 (none) for every row.
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => {
    out.set(p, at);
    return at + p.length;
  }, 0);
  return out;
}

/** The largest size of an .ico as a PNG, or null when there is none that can be read. */
export async function icoToPng(bytes) {
  const entries = icoEntries(bytes).sort((a, b) => b.width - a.width);
  for (const e of entries) {
    if (isPng(e.bytes)) {
      return e.bytes.slice();
    }
    const dib = decodeDib(e.bytes);
    if (dib) {
      // eslint-disable-next-line no-await-in-loop
      return encodePng(dib);
    }
  }
  return null;
}
