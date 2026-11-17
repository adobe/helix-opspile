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

import { EMOJI_ALIASES, SKIN_TONES, SLACK_EMOJI } from '../emoji.js';
import { assemble } from '../pagecore.js';
import MARKDOWN from '../ui-markdown.bundle.js';

/** Where ui/portal.js has its emoji names filled in, as the inbox's page has (src/page.js). */
const PLACEHOLDER = '/* PORTAL_EMOJI */ { names: {}, skin: [], aliases: {} }';

/** The scripts and stylesheets ui/portal.html names, besides the markdown renderer. */
export const PORTAL_FILES = [
  'portal.js', 'app.js', 'writing.js', 'spectrum-fonts.css', 'spectrum.css', 'spectrum-portal.css',
];

/**
 * ui/portal.html as served: its scripts and stylesheets inlined (src/pagecore.js), the markdown
 * renderer as the global `Markdown`, and the emoji names its composer suggests and its
 * messages show (`:tada:`), as Slack, GitHub, Discord and Teams call them.
 *
 * @param {string} html ui/portal.html
 * @param {Record<string, string>} files `PORTAL_FILES`, by file name
 */
export function portalPage(html, files) {
  const served = assemble(html, { ...files, 'markdown.js': MARKDOWN });
  if (!served.includes(PLACEHOLDER)) {
    throw new Error('ui/portal.js has no PORTAL_EMOJI placeholder');
  }
  const emoji = JSON.stringify({ names: SLACK_EMOJI, skin: SKIN_TONES, aliases: EMOJI_ALIASES });
  return served.replace(PLACEHOLDER, () => emoji);
}
