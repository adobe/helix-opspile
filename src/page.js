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

import { SKIN_TONES, SLACK_EMOJI } from './emoji.js';
import MARKDOWN from './ui-markdown.bundle.js';

const PLACEHOLDER = '/* SLACK_EMOJI */ { names: {}, skin: [] }';
const MARKDOWN_PLACEHOLDER = '<script>/* MARKDOWN */</script>';

/**
 * ui/inbox.html as served: with Slack's emoji names filled in, and the markdown renderer
 * (src/ui-markdown.js) as the global `Markdown`.
 */
export function inboxPage(html) {
  if (!html.includes(PLACEHOLDER)) {
    throw new Error('ui/inbox.html has no SLACK_EMOJI placeholder');
  }
  if (!html.includes(MARKDOWN_PLACEHOLDER)) {
    throw new Error('ui/inbox.html has no MARKDOWN placeholder');
  }
  return html
    .replace(PLACEHOLDER, () => JSON.stringify({ names: SLACK_EMOJI, skin: SKIN_TONES }))
    .replace(MARKDOWN_PLACEHOLDER, () => `<script>${MARKDOWN}</script>`);
}
