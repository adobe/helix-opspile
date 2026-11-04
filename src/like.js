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

/** D1 refuses a LIKE pattern over 50 bytes ("LIKE or GLOB pattern too complex"). */
export const MAX_LIKE_BYTES = 50;

const bytes = (s) => new TextEncoder().encode(s).length;

/**
 * A `LIKE ? ESCAPE '\'` pattern for text that has `s` in it. Text longer than D1 allows is
 * cut to its longest start that fits: every text with all of `s` has that start too, so the
 * query finds the same rows and maybe a few more, instead of failing.
 */
export function likePattern(s) {
  const chars = [...String(s)];
  const escaped = chars.map((c) => (/[\\%_]/.test(c) ? `\\${c}` : c));
  let room = MAX_LIKE_BYTES - 2;
  let out = '';
  for (const e of escaped) {
    room -= bytes(e);
    if (room < 0) {
      break;
    }
    out += e;
  }
  return `%${out}%`;
}
