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

import { htmlToMarkdown } from '../html.js';

/**
 * What the portal's text box sends (ui/richtext.js) as the markdown a message is kept in. The
 * box is rich text: what is bold there is `<strong>`, a list is a list. It goes through the
 * syntax tree that Teams' HTML goes through (src/html.js), which writes markdown that shows
 * what the box showed: a `*` or a `1.` someone typed is escaped, since the box showed it as
 * typed. Nothing of the HTML is kept: scripts, styles and whatever else markdown has no word
 * for are gone with it.
 */

/** The HTML of a message is refused past this many characters. */
export const MAX_HTML = 200000;

/** The markdown of rich text `html`, or null when it is too long to read. */
export function richMarkdown(html) {
  const src = String(html ?? '');
  if (src.length > MAX_HTML) {
    return null;
  }
  // A browser writes the spaces of its text box as no-break spaces wherever HTML would fold
  // them, and a zero-width space holds the caret of an empty element: neither was typed.
  return htmlToMarkdown(src.replace(/\u200b/g, ''), { typed: true }).replace(/\u00a0/g, ' ').trim();
}
