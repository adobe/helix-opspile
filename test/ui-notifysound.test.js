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
 * The notifications' sound (ui/inbox.js, soundOn and playChime; the menu's "Play a sound"): off
 * on a device that never chose, on only where it was turned on. The page's own code, in pieces,
 * run in Node with a browser's storage and audio stubbed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAGES, SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const slice = (from, to) => {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  return js.slice(a, b);
};
const tick = () => new Promise((r) => {
  setTimeout(r, 0);
});

/**
 * The sound's pieces of the page, on a device whose storage holds `stored` for the sound
 * (`undefined`: nothing, a device that never chose). `played` counts the chimes that started.
 */
function page(stored) {
  const store = new Map(stored === undefined ? [] : [['opspile.notify.sound', stored]]);
  const world = { store, played: 0, rendered: 0 };
  const sound = { onclick: null };
  class AudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }

    // eslint-disable-next-line class-methods-use-this
    async decodeAudioData() {
      return {};
    }

    // eslint-disable-next-line class-methods-use-this
    createBufferSource() {
      return {
        connect: () => {},
        start: () => {
          world.played += 1;
        },
      };
    }
  }
  const globals = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    window: { AudioContext },
    AudioContext,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    navigator: {},
    $: () => sound,
    renderNotify: () => {
      world.rendered += 1;
    },
  };
  const src = [
    slice('const SOUND_KEY = ', 'function playChime('),
    // playChime, to its closing brace: what follows it is not the sound's.
    `${slice('function playChime(', '\n}\n')}\n}`,
    slice("$('notifySound').onclick = ", 'for (const ev of [\'pointerdown\''),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const fns = new Function(...Object.keys(globals), `${src}\nreturn { soundOn, unlockAudio, playChime };`)(
    ...Object.values(globals),
  );
  return { ...fns, world, toggle: () => sound.onclick() };
}

describe('the notifications\' sound', () => {
  it('is off on a device that never chose', () => {
    assert.equal(page().soundOn(), false);
  });

  it('is on only where it was turned on', () => {
    assert.equal(page('on').soundOn(), true);
    assert.equal(page('off').soundOn(), false);
    assert.equal(page('').soundOn(), false);
  });

  it('plays no chime with a notification unless it is on', async () => {
    for (const [stored, played] of [[undefined, 0], ['off', 0], ['on', 1]]) {
      const p = page(stored);
      p.unlockAudio();
      p.playChime();
      // eslint-disable-next-line no-await-in-loop
      await tick();
      assert.equal(p.world.played, played, `stored: ${stored}`);
    }
  });

  it('is turned on by the menu\'s switch, which plays it once, and off again', async () => {
    const p = page();
    p.toggle();
    await tick();
    assert.equal(p.world.store.get('opspile.notify.sound'), 'on');
    assert.equal(p.soundOn(), true);
    assert.equal(p.world.played, 1, 'the chime, to hear what was turned on');
    assert.equal(p.world.rendered, 1);
    p.toggle();
    await tick();
    assert.equal(p.world.store.get('opspile.notify.sound'), 'off');
    assert.equal(p.soundOn(), false);
    assert.equal(p.world.played, 1, 'none when turned off');
  });

  it('ships its switch off, as the menu shows it before the page has drawn it', () => {
    const [button] = PAGES['inbox.html'].match(/<button[^>]*id="notifySound"[^>]*>/);
    assert.match(button, /role="switch"/);
    assert.match(button, /aria-checked="false"/);
  });
});
