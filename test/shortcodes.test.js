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
import { beforeEach, describe, it } from 'node:test';
import { EMOJI_ALIASES, SKIN_TONES, SLACK_EMOJI } from '../src/emoji.js';
import { emojiLookup, matchEmoji, squash } from '../src/emojinames.js';
import { CLEF } from '../src/label.js';
import {
  candidates, COMMON, emojiChar, forget, MAX_ASK, rankEmoji, resolveShortcodes,
} from '../src/shortcodes.js';
import { d1 } from './d1.js';

const lookup = emojiLookup(SLACK_EMOJI, EMOJI_ALIASES, SKIN_TONES);

describe('emoji aliases', () => {
  it('finds Slack\'s name for other separators and spellings', () => {
    assert.equal(squash('Face-Palm'), 'facepalm');
    assert.equal(lookup('face_palm'), 'face_palm');
    assert.equal(lookup('facepalm'), 'face_palm');
    assert.equal(lookup('face-palm'), 'face_palm');
    assert.equal(lookup('thumbs-up'), 'thumbsup');
    assert.equal(lookup('thumbs_up'), 'thumbsup');
    assert.equal(lookup('white-check-mark'), 'white_check_mark');
    assert.equal(lookup('man_facepalming'), 'man-facepalming');
    assert.equal(lookup('flag_de'), 'flag-de');
  });

  it('knows GitHub\'s, Discord\'s and Teams\' names', () => {
    // Discord and GitHub: 🤦 is person_facepalming; Teams stores reactions by type.
    assert.equal(lookup('person_facepalming'), 'face_palm');
    assert.equal(lookup('like'), '+1');
    assert.equal(lookup('laugh'), 'laughing');
    assert.equal(lookup('radioactive'), 'radioactive_sign');
    assert.equal(lookup('balance_scale'), 'scales');
  });

  it('keeps skin tones, in Slack\'s and Discord\'s way', () => {
    assert.equal(lookup('wave::skin-tone-3'), 'wave::skin-tone-3');
    assert.equal(lookup('thumbsup_tone3'), 'thumbsup::skin-tone-4');
    assert.equal(lookup('person_facepalming_tone1'), 'face_palm::skin-tone-2');
    // An emoji without tones keeps none.
    assert.equal(lookup('rocket::skin-tone-3'), 'rocket');
    assert.equal(emojiChar('thumbsup::skin-tone-4'), '👍🏽');
  });

  it('knows nothing it should not', () => {
    assert.equal(lookup('completed'), undefined);
    // `-1` is thumbs down, `1` nothing.
    assert.equal(lookup('-1'), '-1');
    assert.equal(lookup('1'), undefined);
    assert.equal(lookup('constructor'), undefined);
    // Two emoji that squash to one name: neither, for the squashed one.
    assert.equal(lookup('ice_cream'), 'ice_cream');
    assert.equal(lookup('icecream'), 'icecream');
    assert.equal(lookup('ice-cream'), undefined);
  });
});

describe('emoji candidates', () => {
  it('puts the emoji whose name or keywords look alike first, then common ones', () => {
    const list = candidates('completed');
    assert.equal(list[0], 'white_check_mark');
    assert.ok(list.length <= 16);
    assert.ok(list.includes('+1'));
    assert.deepEqual(candidates('qjvq'), COMMON);
  });
});

/** Workers AI with Clef answering `answer(code, criteria)`; the calls are in `calls`. */
function ai(answer) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      assert.equal(model, CLEF);
      calls.push(input);
      const { criteria } = input.questions.emoji;
      return answer(/:([^:]+):/.exec(input.state)[1], criteria);
    },
  };
}

/** Clef's answer: the candidate named `name`, with probability `p`. */
const choose = (name, p) => (criteria) => {
  const choice = Object.keys(criteria).find((k) => criteria[k].includes(`:${name}:`)) || 'none';
  return { answers: { emoji: { choice, probabilities: { [choice]: p } } } };
};

describe('shortcodes in a reply', () => {
  beforeEach(() => forget());

  it('writes Slack names on Slack, characters on Teams and Discord', async () => {
    const text = 'oops :facepalm: :thumbs-up::skin-tone-2: :eyes:';
    assert.deepEqual(await resolveShortcodes({}, text, { source: 'slack' }), {
      text: 'oops :face_palm: :thumbsup::skin-tone-2: :eyes:',
      changed: [{ from: 'facepalm', to: 'face_palm' }, { from: 'thumbs-up::skin-tone-2', to: 'thumbsup::skin-tone-2' }],
    });
    assert.equal((await resolveShortcodes({}, text, { source: 'teams' })).text, 'oops 🤦 👍🏻 👀');
    assert.equal((await resolveShortcodes({}, ':tada::tada:', { source: 'discord' })).text, '🎉🎉');
  });

  it('leaves code, times and addresses alone', async () => {
    const text = '`:facepalm:` at 10:30:45, see https://x.example/a:facepalm:b\n```\n:tada:\n```';
    assert.equal((await resolveShortcodes({}, text, { source: 'teams' })).text, text);
  });

  it('asks Clef for a name nobody has, once', async () => {
    const AI = ai((code, criteria) => choose('white_check_mark', 0.55)(criteria));
    const env = { AI };
    const res = await resolveShortcodes(env, 'all :completed: :completed:', { source: 'slack' });
    assert.equal(res.text, 'all :white_check_mark: :white_check_mark:');
    assert.equal(AI.calls.length, 1);
    const { criteria } = AI.calls[0].questions.emoji;
    assert.ok(Object.keys(criteria).length <= 17);
    assert.ok(criteria.none);
    assert.match(criteria.e0, /^✅ :white_check_mark: \(check mark button/);
    // The answer is remembered; Teams gets the character.
    assert.equal((await resolveShortcodes(env, ':completed:', { source: 'teams' })).text, '✅');
    assert.equal(AI.calls.length, 1);
  });

  it('leaves the name when Clef is not sure, says none, fails or is slow', async () => {
    const unsure = { AI: ai((code, criteria) => choose('white_check_mark', 0.45)(criteria)) };
    assert.equal((await resolveShortcodes(unsure, ':completed:', { source: 'slack' })).text, ':completed:');
    const none = { AI: ai(() => ({ answers: { emoji: { choice: 'none', probabilities: { none: 0.9 } } } })) };
    assert.equal((await resolveShortcodes(none, ':foo:', { source: 'slack' })).text, ':foo:');
    const failing = {
      AI: {
        run: async () => {
          throw new Error('overloaded');
        },
      },
    };
    assert.equal((await resolveShortcodes(failing, ':shipped:', { source: 'slack' })).text, ':shipped:');
    const slow = { AI: { run: () => new Promise(() => {}) } };
    const res = await resolveShortcodes(slow, ':done-done:', { source: 'slack', timeoutMs: 10 });
    assert.equal(res.text, ':done-done:');
  });

  it('asks about a few names per reply, and only about names', async () => {
    const AI = ai(() => ({ answers: {} }));
    await resolveShortcodes({ AI }, ':aa: :bb: :cc: :dd: :ee: :7: :x1:', { source: 'slack' });
    assert.equal(AI.calls.length, MAX_ASK);
    AI.calls.length = 0;
    await resolveShortcodes({ AI }, ':42:', { source: 'slack', clef: true });
    await resolveShortcodes({ AI }, ':zz:', { source: 'slack', clef: false });
    assert.equal(AI.calls.length, 0);
  });

  it('keeps the workspace\'s own emoji, without asking Clef', async () => {
    const DB = d1();
    DB.sqlite.prepare(`INSERT INTO reactions (message, thread, emoji, user_key)
      VALUES ('slack:E1:C1:1.2', 'slack:E1:C1:1.1', 'party-blob', 'slack:E1:U1'),
        ('discord:G1:C2:5', 'discord:G1:C2:4', ':ship_it_squirrel:', 'discord:G1:U2')`).run();
    const AI = ai((code, criteria) => choose('tada', 0.95)(criteria));
    const env = { DB, AI };
    const res = await resolveShortcodes(env, ':party-blob: :party-hat:', { source: 'slack', tenant: 'E1' });
    assert.equal(res.text, ':party-blob: :tada:');
    assert.deepEqual(AI.calls.map((c) => c.state.match(/:([^:]+):/)[1]), ['party-hat']);
    const discord = await resolveShortcodes(env, ':ship_it_squirrel:', { source: 'discord', tenant: 'G1' });
    assert.equal(discord.text, ':ship_it_squirrel:');
    // Another workspace's emoji are not this one's.
    const other = await resolveShortcodes(env, ':party-blob:', { source: 'slack', tenant: 'E2' });
    assert.equal(other.text, ':tada:');
  });
});

describe('emoji suggestions in the composer', () => {
  beforeEach(() => forget());
  const match = (q, limit) => matchEmoji(SLACK_EMOJI, EMOJI_ALIASES, q, limit);

  it('finds the names that have what was typed: whole, start, part, anywhere', () => {
    assert.deepEqual(match('check'), [
      'checkered_flag', 'heavy_check_mark', 'white_check_mark', 'ballot_box_with_check',
    ]);
    assert.deepEqual(match('fire', 3), ['fire', 'fireworks', 'fire_engine']);
    assert.deepEqual(match('+1'), ['+1']);
    // Separators may be left out, from the start of a part only.
    assert.deepEqual(match('checkm'), ['heavy_check_mark', 'white_check_mark']);
    assert.deepEqual(match('tad'), ['tada', 'stadium']);
    assert.deepEqual(match('SMI', 2), ['smile', 'smirk']);
    assert.deepEqual(match(''), []);
  });

  it('finds other platforms\' names, one name per emoji, Slack\'s first', () => {
    assert.equal(match('facepalm')[0], 'face_palm');
    assert.equal(match('facep')[0], 'face_palm');
    assert.deepEqual(match('thu', 2), ['thumbsup', 'thumbsdown']);
    const chars = match('smile', 20).map((n) => SLACK_EMOJI[n]);
    assert.equal(new Set(chars).size, chars.length);
  });

  it('ranks all of the candidates by Clef, without a threshold', async () => {
    const list = candidates('celebr');
    assert.ok(list.includes('partying_face') && list.includes('tada'));
    const calls = [];
    const AI = {
      async run(model, input) {
        calls.push(input);
        const { criteria } = input.questions.emoji;
        assert.equal(criteria.none, undefined);
        const k = Object.keys(criteria).find((c) => criteria[c].includes(':tada:'));
        return { answers: { emoji: { choice: k, probabilities: { [k]: 0.2, e0: 0.1 } } } };
      },
    };
    const ranked = await rankEmoji({ AI }, 'Celebr');
    assert.match(calls[0].state, /has typed :celebr so far/);
    assert.equal(ranked[0], 'tada');
    assert.equal(ranked[1], list[0]);
    assert.deepEqual([...ranked].sort(), [...list].sort());
    // Remembered.
    assert.deepEqual(await rankEmoji({ AI }, 'celebr'), ranked);
    assert.equal(calls.length, 1);
  });

  it('suggests nothing without Clef, for too little, or when Clef fails or is slow', async () => {
    assert.deepEqual(await rankEmoji({}, 'party'), []);
    const AI = { run: () => assert.fail('not asked') };
    assert.deepEqual(await rankEmoji({ AI }, 'p'), []);
    assert.deepEqual(await rankEmoji({ AI }, '+1'), []);
    const failing = {
      AI: {
        run: async () => {
          throw new Error('overloaded');
        },
      },
    };
    assert.deepEqual(await rankEmoji(failing, 'party'), []);
    const slow = { AI: { run: () => new Promise(() => {}) } };
    assert.deepEqual(await rankEmoji(slow, 'party', 10), []);
  });
});
