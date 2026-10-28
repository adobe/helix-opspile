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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inboxPage } from '../src/page.js';
import * as Markdown from '../src/ui-markdown.js';
import { PAGES, SCRIPTS } from './ui.js';

const html = PAGES['inbox.html'];

/** A piece of the page's script, from `from` up to `to`, run outside a browser. */
function piece(page, from, to, expose, globals = {}) {
  const a = page.indexOf(from);
  const b = page.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  const g = { Markdown, ...globals };
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(g), `${page.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(g),
  );
}

/** The page's emoji helpers, as served. */
function helpers(page) {
  return piece(page, 'const SLACK_EMOJI =', '// Reactions by Slack name', 'emoji, emojiByName, EMOJI_CODE');
}

describe('emoji names', () => {
  const { emoji, emojiByName, EMOJI_CODE } = helpers(inboxPage(html, SCRIPTS));
  const text = (s) => s.replace(EMOJI_CODE, (m, n) => emojiByName(n) || m);

  it('knows Slack\'s standard names and aliases', () => {
    assert.equal(emoji('laughing'), '😆');
    assert.equal(emoji('satisfied'), '😆');
    assert.equal(emoji('shrug'), '🤷');
    assert.equal(emoji('+1'), '👍');
    assert.equal(emoji('thumbsup'), '👍');
    assert.equal(emoji('100'), '💯');
    assert.equal(emoji('flag-de'), '🇩🇪');
  });

  it('keeps Teams reaction types', () => {
    assert.equal(emoji('like'), '👍');
    assert.equal(emoji('laugh'), '😆');
    assert.equal(emoji('surprised'), '😮');
  });

  it('applies skin tones', () => {
    assert.equal(emoji('+1::skin-tone-3'), '👍🏼');
    assert.equal(emoji('point_up::skin-tone-2'), '☝🏻');
    assert.equal(emoji('woman-raising-hand::skin-tone-6'), '🙋🏿‍♀️');
    assert.equal(emoji('laughing::skin-tone-4'), '😆');
  });

  it('shows unknown names by name, and characters as they are', () => {
    assert.equal(emoji('some-custom-emoji'), ':some-custom-emoji:');
    assert.equal(emoji('constructor'), ':constructor:');
    assert.equal(emoji('👀'), '👀');
  });

  it('replaces codes in text', () => {
    assert.equal(text('ha :laughing: :wave::skin-tone-5: :nope:'), 'ha 😆 👋🏾 :nope:');
  });

  it('knows every platform\'s name and spelling', () => {
    assert.equal(emoji('face_palm'), '🤦');
    assert.equal(emoji('face-palm'), '🤦');
    assert.equal(emoji('person_facepalming'), '🤦');
    assert.equal(emoji('thumbs-up'), '👍');
    assert.equal(emoji('thumbs_up::skin-tone-2'), '👍🏻');
    assert.equal(emoji('thumbsup_tone5'), '👍🏿');
    assert.equal(emoji('radioactive'), '☢️');
    assert.equal(emoji('completed'), ':completed:');
  });

  it('shows emoji in sent messages and those being sent', () => {
    const md = (src) => Markdown.render(src, { emoji: emojiByName });
    assert.equal(md('never mind :facepalm: `:tada:`'), '<p>never mind 🤦 <code>:tada:</code></p>');
    const page = inboxPage(html, SCRIPTS);
    const { message } = piece(page, 'const continues', '// ---------------------------------------------------------------- the thread agent', 'message', {
      dayLabel: () => 'Today',
      profileKey: () => 'k',
      avatar: () => '',
      esc: (x) => String(x ?? ''),
      clock: () => '10:00',
      md,
      canReact: () => false,
      canEdit: () => false,
      state: {},
      QUICK: [],
      emoji,
      SIGNAL_HINT: {},
      favicon: (x) => x,
      sendState: () => '',
    });
    const author = { name: 'Ada', kind: 'person', staff: true };
    const at = '2026-10-21T10:00:00Z';
    for (const m of [{ mine: true }, { pending: true }]) {
      const out = message({
        thread: 't', id: '1', at, author, body: 'ok :thumbs-up: :white_check_mark:', ...m,
      }, null, false);
      assert.match(out, /ok 👍 ✅/);
    }
  });

  it('is filled in where the page is served', () => {
    assert.equal(helpers(SCRIPTS['inbox.js']).emoji('laughing'), ':laughing:');
    assert.throws(() => inboxPage('<html></html>', SCRIPTS), /placeholder/);
  });
});
