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

import { EMOJI_ALIASES, SKIN_TONES, SLACK_EMOJI } from './emoji.js';
import MARKDOWN from './ui-markdown.bundle.js';

const PLACEHOLDER = '/* SLACK_EMOJI */ { names: {}, skin: [] }';

/** `<script src="name.js"></script>`, with or without `type="module"`, in a page of ui/. */
const SCRIPT = /<script( type="module")? src="([a-z-]+\.js)"><\/script>/g;

/**
 * A page of ui/ as served: its scripts, ui/*.js and `markdown.js` (the markdown renderer,
 * src/ui-markdown.js, as the global `Markdown`), inlined where the page names them. The
 * scripts live in their own files, which lint checks, but the page stays one request.
 *
 * @param {string} html the page, ui/<name>.html
 * @param {Record<string, string>} scripts ui/*.js by file name
 */
export function page(html, scripts) {
  const files = { ...scripts, 'markdown.js': MARKDOWN };
  return html.replace(SCRIPT, (tag, module, name) => {
    if (typeof files[name] !== 'string') {
      throw new Error(`no script ${name} for the page`);
    }
    // In an inline <script>, `</script` would end it.
    const code = files[name].replace(/<\/(script)/gi, '<\\/$1');
    return `<script${module || ''}>\n${code}</script>`;
  });
}

/**
 * ui/inbox.html as served (see `page`), with Slack's emoji names filled in, and the names
 * GitHub, Discord and Teams give them.
 */
export function inboxPage(html, scripts) {
  const served = page(html, scripts);
  if (!served.includes(PLACEHOLDER)) {
    throw new Error('ui/inbox.js has no SLACK_EMOJI placeholder');
  }
  const emoji = JSON.stringify({ names: SLACK_EMOJI, skin: SKIN_TONES, aliases: EMOJI_ALIASES });
  return served.replace(PLACEHOLDER, () => emoji);
}
