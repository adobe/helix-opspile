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

import { download, pickFile, threadFiles } from './agent/files.js';
import { threadMessages } from './label.js';
import { json } from './http.js';

/**
 * `GET /api/file?t=<thread>&u=<link>`: a text file attached to a message of the thread (a CSV,
 * a log, JSON), for the inbox's preview of it (ui/table.js). The route checks that the viewer
 * may see the thread; this checks that a message of it links to the file, and fetches it as an
 * agent's `read_file` does (src/agent/files.js), with the opspile app's credentials.
 *
 * Only text is passed on, and always as `text/plain` (never HTML the browser would run): what
 * the file is comes in `x-file-type`, its name in `x-file-name` (URI-encoded).
 */

// What a preview can show: text by its type, or by its name where the platform says less
// (Slack calls a .har `application/octet-stream`, Teams copies keep what SharePoint said).
const TEXT_TYPE = /^(text\/(?!html)|application\/(json|x-ndjson|ld\+json|yaml|x-yaml|xml|csv|x-csv|x-sh|sql)$)/;
export const TEXT_NAME = /\.(csv|tsv|txt|log|json|ndjson|jsonl|har|md|markdown|ya?ml|xml|ini|conf|cfg|toml|env|properties|sql|sh|diff|patch)$/i;

export const isText = (type, name) => TEXT_TYPE.test(String(type || '').split(';')[0].trim().toLowerCase())
  || TEXT_NAME.test(String(name || ''));

/**
 * The response to `GET /api/file` for file `wanted` (its link) of thread `key`. `load`: how
 * the thread's messages are read (tests give their own).
 */
export async function threadFile(env, key, wanted, { load = threadMessages } = {}) {
  const row = await env.DB.prepare('SELECT thread, path FROM threads WHERE thread = ?').bind(key).first();
  if (!row || !row.path) {
    return json({ error: 'not found' }, 404);
  }
  const files = threadFiles(await load(env, row));
  const f = pickFile(files, wanted);
  if (!f) {
    return json({ error: 'not a file of this thread' }, 404);
  }
  const got = await download(env, f);
  if (got.error) {
    return json({ error: got.error }, 502);
  }
  if (!isText(got.type, got.name)) {
    return json({ error: `cannot preview this kind of file (${got.type})` }, 415);
  }
  // Text the browser is told nothing else about: no sniffing, nothing it may load or run.
  return new Response(got.bytes, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'private, max-age=300',
      'x-file-name': encodeURIComponent(got.name || ''),
      'x-file-type': got.type,
    },
  });
}
