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

/**
 * A browser's recording (HAR) as one line of JSON per request, for a thread agent's shell. A
 * recording is mostly response bodies, often tens of megabytes, which neither a Worker nor the
 * shell can parse whole; these lines are a small fraction of it and `jq` takes them one by one.
 *
 * The bytes are scanned as they arrive and the `text` and `data` strings (the bodies) are never
 * held, so memory follows the largest request without its bodies, not the file. The lines say
 * what a request was, without bodies or cookies and with credentials hidden: a HAR holds the
 * session of whoever recorded it. ui/table.js decides the same way for the inbox's preview.
 */

/* eslint-disable no-underscore-dangle -- HAR's own names for what browsers add. */

const HIDDEN = '[hidden]';
const SECRET_NAME = /^(proxy-)?authorization$|^(set-)?cookie$|token|secret|passw|api[-_]?key|session|signature|^sig$|^code$/i;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;
// What goes into the lines at most: a recording of tens of thousands of requests stays usable.
export const MAX_REQUESTS_BYTES = 20 * 1024 * 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const OPEN = new Set([0x7b, 0x5b]); // { [
const CLOSE = new Set([0x7d, 0x5d]); // } ]
const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NULL = new TextEncoder().encode('null');
const KEEP_KEY = 16; // Bytes of a string kept to recognize it as a key.
const WANTED = new Map([[1, 'log'], [2, 'entries']]);
const DROPPED = new Set(['text', 'data']);

/** Whether a header or parameter is a credential: by its name, or a JWT by its look. */
const secret = (name, value) => SECRET_NAME.test(String(name))
  || String(value).search(JWT) >= 0;

/** Text with the credentials in its query or fragment and any JWT hidden. */
export function hideSecrets(text) {
  return String(text ?? '')
    .replace(/([?&#;])([^=&#;]+)=([^&#;]*)/g, (all, at, name, value) => (secret(name, value) ? `${at}${name}=${HIDDEN}` : all))
    .replace(JWT, HIDDEN);
}

const pairs = (list) => (Array.isArray(list) ? list : []).map(({ name, value }) => ({
  name,
  value: secret(name, value) ? HIDDEN : hideSecrets(value),
}));

/** What a line says about a HAR entry (bodies already gone). */
export function requestLine(e) {
  const { request = {}, response = {} } = e;
  const { content = {} } = response;
  return {
    start: e.startedDateTime,
    ms: Math.round(Number(e.time) || 0),
    method: request.method,
    url: hideSecrets(request.url),
    status: response.status ?? 0,
    statusText: response.statusText || undefined,
    error: response._error || e._error || undefined,
    type: e._resourceType || undefined,
    mime: content.mimeType || undefined,
    size: content.size,
    ip: e.serverIPAddress || undefined,
    timings: e.timings,
    request: { query: pairs(request.queryString), headers: pairs(request.headers) },
    response: { headers: pairs(response.headers) },
  };
}

/** A byte scanner: `push` chunks of a HAR, and `onEntry` gets each of its entries, parsed. */
function scanner(onEntry) {
  const decoder = new TextDecoder();
  const keys = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let token = [];
  let last = '';
  let skipNext = false;
  let skipping = false;
  let inEntries = false;
  let out = null; // The entry so far, without its bodies.
  let used = 0;
  const keep = (bytes) => {
    if (used + bytes.length > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, used + bytes.length));
      grown.set(out.subarray(0, used));
      out = grown;
    }
    out.set(bytes, used);
    used += bytes.length;
  };
  const one = new Uint8Array(1);
  const write = (byte) => {
    if (out) {
      one[0] = byte;
      keep(one);
    }
  };
  const string = (c) => {
    if (escaped) {
      escaped = false;
    } else if (c === BACKSLASH) {
      escaped = true;
    } else if (c === QUOTE) {
      inString = false;
      if (skipping) {
        skipping = false;
        keep(NULL);
        return;
      }
      last = token.length <= KEEP_KEY ? String.fromCharCode(...token) : '';
    }
    if (!skipping) {
      write(c);
      if (inString && token.length <= KEEP_KEY) {
        token.push(c);
      }
    }
  };
  const structure = (c) => {
    if (SPACE.has(c)) {
      return;
    }
    if (c === QUOTE) {
      inString = true;
      token = [];
      skipping = skipNext && Boolean(out);
      skipNext = false;
      if (!skipping) {
        write(c);
      }
      return;
    }
    skipNext = false;
    if (c === COLON) {
      keys[depth] = last;
      skipNext = Boolean(out) && DROPPED.has(last);
    } else if (OPEN.has(c)) {
      if (inEntries && depth === 3 && !out) {
        out = new Uint8Array(4096);
        used = 0;
      } else if (depth === 2 && keys[1] === WANTED.get(1) && keys[2] === WANTED.get(2)) {
        inEntries = true;
      }
      depth += 1;
    } else if (CLOSE.has(c)) {
      depth -= 1;
      if (inEntries && depth === 2) {
        inEntries = false;
      }
      if (inEntries && depth === 3 && out) {
        write(c);
        const text = decoder.decode(out.subarray(0, used));
        out = null;
        try {
          onEntry(JSON.parse(text));
        } catch { /* A broken entry: left out. */ }
        return;
      }
    }
    write(c);
  };
  return (chunk) => {
    for (const c of chunk) {
      if (inString) {
        string(c);
      } else {
        structure(c);
      }
    }
  };
}

/**
 * The requests of the HAR in `stream`, a line of JSON each, or null when it has none. Stops
 * adding lines at MAX_REQUESTS_BYTES, and the last line then says so.
 */
export async function harRequests(stream) {
  const lines = [];
  let bytes = 0;
  let total = 0;
  const push = scanner((entry) => {
    total += 1;
    if (bytes < MAX_REQUESTS_BYTES) {
      const line = JSON.stringify(requestLine(entry));
      bytes += line.length + 1;
      lines.push(line);
    }
  });
  const reader = stream.getReader();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    push(value);
  }
  if (!lines.length) {
    return null;
  }
  if (lines.length < total) {
    lines.push(JSON.stringify({ truncated: true, requests: total, shown: lines.length }));
  }
  return `${lines.join('\n')}\n`;
}
