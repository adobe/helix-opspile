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
 * The cards of the commands a thread agent asks a person to run (ui/inbox.js, `bashCard`), and
 * the values a person lets the page remember: encrypted in localStorage, with a key that
 * cannot be exported.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// The page's highlighter, as a stub: it marks the first word, once it has loaded.
const lit = { loaded: false };
const highlightCode = (code, lang) => (lit.loaded
  ? esc(code).replace(/^\w+/, (word) => `<span class="hl-function" data-lang="${lang}">${word}</span>`) : null);
const { bashCard, bashCards, timeLeft } = piece('const BASH_ICON', '/** The requests of the open thread', 'bashCard, bashCards, timeLeft', {
  esc, ago: (at) => (at ? '9m' : ''), clock: () => '14:00', viewerId: () => 1, highlightCode,
});

const request = {
  id: 'r1',
  command: 'curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/<x>',
  reason: 'Lists the tickets & needs <your> token.',
  env: [{ name: 'API_TOKEN', description: 'Your "API" token' }, { name: 'API_USER', description: '' }],
  timeout: 60,
  deadline: new Date(Date.now() + 23 * 60 * 60 * 1000 + 5000).toISOString(),
  status: 'pending',
  created_at: '2026-11-05T10:00:00Z',
  by: null,
};

describe('a command request\'s card', () => {
  it('is a form: the command, the agent\'s reason, a secret field per variable, Deny and Run', () => {
    const html = bashCard(request, { decide: true });
    assert.match(html, /^<form class="br pending" data-id="r1" autocomplete="off">/);
    assert.match(html, /the agent asks · 9m · <span title="Until [^"]+: after that, nobody can run it">open for 23h<\/span>/);
    // Its id, as the agent names it in its notes.
    assert.match(html, /Command<\/span><code class="id" title="[^"]+">r1<\/code><span class="by">/);
    // What the agent wrote is text, never markup.
    assert.ok(html.includes('<p class="why">Lists the tickets &amp; needs &lt;your&gt; token.</p>'));
    assert.ok(html.includes('<pre class="cmd"><code>curl -H &quot;Authorization: Bearer $API_TOKEN&quot; https://api.example.com/&lt;x&gt;</code></pre>'));
    const fields = [...html.matchAll(/<input type="(\w+)" name="(\w+)"([^>]*)>/g)];
    assert.deepEqual(fields.map((m) => `${m[1]} ${m[2]}`), [
      'password API_TOKEN', 'password API_USER', 'checkbox remember',
    ]);
    // Every variable has to be filled in, and no password manager is asked to keep one.
    assert.match(fields[0][3], /^ required autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"/);
    // No value is ever part of the markup: the fields are filled in afterwards.
    assert.doesNotMatch(html, / value="/);
    assert.ok(html.includes('<code>$API_TOKEN</code>'));
    assert.ok(html.includes('<span class="ds">Your &quot;API&quot; token</span>'));
    assert.equal(html.match(/class="ds"/g).length, 1);
    assert.match(html, /<label class="keep" title="Encrypted in this browser's storage[^"]+"><input type="checkbox" name="remember">Remember on this device, encrypted<\/label>/);
    assert.match(html, /<span class="note" title="[^"]*read it before you run it\.">Runs on the agent's computer, for up to 60 s\. The agent gets what it prints, never what you fill in\.<\/span>/);
    assert.match(html, /<button type="button" class="deny" data-bash="deny">Deny<\/button><button type="submit" class="run" data-bash="run">Run<\/button>/);
  });

  it('has no fields without variables, and none at all for who cannot decide', () => {
    const plain = bashCard({ ...request, env: [] }, { decide: true });
    assert.doesNotMatch(plain, /<input|class="vars"|class="keep"/);
    assert.match(plain, /for up to 60 s\. The agent gets what it prints\.<\/span>/);
    assert.match(plain, /data-bash="run"/);
    const seen = bashCard(request, {});
    assert.match(seen, /^<div class="br pending" data-id="r1">/);
    assert.doesNotMatch(seen, /<form|<input|<button/);
    assert.ok(seen.includes('<p class="why">'));
  });

  it('says which fields a remembered value fills, with a way to forget it', () => {
    const html = bashCard(request, { decide: true, kept: ['API_TOKEN'] });
    assert.equal(html.match(/<span class="kept">remembered<\/span>/g).length, 1);
    assert.match(html, /<code>\$API_TOKEN<\/code><span class="kept">remembered<\/span><button type="button" class="forget" data-bash="forget" data-name="API_TOKEN" title="[^"]+">Forget<\/button>/);
    assert.doesNotMatch(html, /data-name="API_USER"/);
  });

  it('cannot be used while it is being sent', () => {
    const html = bashCard(request, { decide: true, busy: true, kept: ['API_TOKEN'] });
    assert.equal(html.match(/<(input|button)\b[^>]*>/g).length, 6);
    assert.equal(html.match(/<(input|button)\b[^>]* disabled>/g).length, 6);
  });

  it('says how a decided request stands, on one line with its command', () => {
    const at = '2026-11-05T10:05:00Z';
    const ada = { id: 2, name: 'Ada' };
    // `[!]`: what did not go as it was meant to, which the card marks.
    const line = (r) => {
      const html = bashCard({ ...request, finished_at: at, ...r }, { decide: true });
      assert.doesNotMatch(html, /<form|<input|<button|class="why"/);
      assert.ok(html.includes('<pre class="cmd"><code>curl -H'));
      assert.ok(html.includes('<code class="id" title="This request\'s id: the agent names it in its notes">r1</code>'));
      return html.match(/<span class="by">(.*?)<\/span><\/div>/)[1]
        .replace(/<span class="st bad" title="[^"]*">/, '[!]').replace(/<span class="st" title="[^"]*">|<\/span>/g, '');
    };
    assert.equal(line({ status: 'running', by: { id: 1, name: 'Dana' } }), '<i class="spin"></i>Running, started by you');
    assert.equal(line({ status: 'done', exit_code: 0, by: ada }), 'Ran, exit code 0 · by Ada · 9m');
    assert.equal(line({ status: 'done', exit_code: 3, by: ada }), '[!]Ran, exit code 3 · by Ada · 9m');
    assert.equal(line({ status: 'timeout', by: ada }), '[!]Stopped after 60 s, its timeout · by Ada · 9m');
    assert.equal(line({ status: 'failed', error: 'the computer <failed>', by: ada }), '[!]Did not run to its end: the computer &lt;failed&gt; · by Ada · 9m');
    assert.equal(line({ status: 'denied', by: ada }), 'Denied by Ada · 9m');
    assert.equal(line({ status: 'expired' }), 'Expired at 14:00: nobody ran it');
    const done = {
      ...request, status: 'done', exit_code: 0, by: ada,
    };
    assert.match(bashCard(done), /^<div class="br done" data-id="r1">/);
  });

  it('shows only the latest request that ended, with the earlier ones a click away', () => {
    const ended = (id, minute, more = {}) => ({
      ...request, id, status: 'done', exit_code: 0, by: { id: 1, name: 'Dana' }, finished_at: `2026-11-05T10:0${minute}:00Z`, ...more,
    });
    const ids = (html) => [...html.matchAll(/data-id="(\w+)"/g)].map((m) => m[1]);
    // As the thread has them: by when they were asked for, not by when they ended.
    const running = {
      ...request, id: 'x', status: 'running', by: { id: 1, name: 'Dana' },
    };
    const list = [ended('a', 4, { exit_code: 22 }), ended('b', 2), { ...request, id: 'p' },
      ended('c', 6), running];
    const closed = bashCards(list, { options: () => ({ decide: true }) });
    // One line for the three that ended, the latest; then those that wait or run, as they came.
    assert.deepEqual(ids(closed), ['c', 'p', 'x']);
    assert.match(closed, /^<div class="hist"><div class="br done" data-id="c">.*<\/pre><button type="button" class="more" data-bash="earlier" aria-expanded="false" title="[^"]+">2 earlier<\/button><\/div><\/div><form class="br pending" data-id="p"/s);
    assert.match(closed, /<div class="br running" data-id="x">/);
    // Shown: all of them, oldest first, in the one box, and the button takes them away again.
    const open = bashCards(list, { all: true, options: () => ({ decide: true }) });
    assert.deepEqual(ids(open), ['b', 'a', 'c', 'p', 'x']);
    assert.equal(open.match(/data-bash="earlier"/g).length, 1);
    assert.match(open, /data-id="c">.*aria-expanded="true" title="[^"]+">Hide earlier<\/button><\/div><\/div><form/s);
    assert.equal(open.match(/class="hist"/g).length, 1);
    // A single one that ended has no button; none, no box.
    assert.doesNotMatch(bashCards([ended('a', 1), { ...request, id: 'p' }]), /data-bash="earlier"/);
    assert.doesNotMatch(bashCards([{ ...request, id: 'p' }]), /class="hist"/);
    assert.equal(bashCards([]), '');
    // The page keeps which threads show theirs, and the button switches it.
    assert.match(js, /if \(b\.dataset\.bash === 'earlier'\) \{\n\s+if \(bashEarlier\.has\(el\.__key\)\) bashEarlier\.delete\(el\.__key\); else bashEarlier\.add\(el\.__key\);/);
  });

  it('highlights a waiting command as shell, once the highlighter has loaded', () => {
    assert.ok(bashCard(request, { decide: true }).includes('<pre class="cmd"><code>curl -H &quot;'));
    lit.loaded = true;
    try {
      const html = bashCard(request, { decide: true });
      assert.ok(html.includes('<pre class="cmd hl"><code><span class="hl-function" data-lang="bash">curl</span> -H &quot;Authorization'));
      // One that was decided is a line of plain text.
      assert.ok(bashCard({ ...request, status: 'denied' }).includes('<pre class="cmd"><code>curl -H'));
    } finally {
      lit.loaded = false;
    }
    // In the colors of a message's code block.
    assert.match(SCRIPTS['spectrum-inbox.css'], /\.spectrum :is\(\.bubble, \.bashbar\) pre\.hl \.hl-function,/);
  });

  it('says that it runs on the card, not in a note on top of it', () => {
    const run = js.slice(js.indexOf('async function runBash('), js.indexOf('async function denyBash('));
    const deny = js.slice(js.indexOf('async function denyBash('), js.indexOf('// Sending, as in iMessage'));
    // Only what went wrong is a toast.
    assert.equal(run.match(/toast\(/g).length, 3);
    assert.doesNotMatch(run, /toast\([^)]*Running on/);
    assert.match(run, /if \(!res\.ok\) toast\(`Nothing ran: /);
    assert.match(deny, /if \(!res\.ok\) toast\(/);
    assert.equal(deny.match(/toast\(/g).length, 1);
    // The open thread's cards stay until it is fetched again, so the click shows at once.
    assert.match(js, /if \(ev\.type === 'bash'\) \{ if \(ev\.thread !== state\.open\) state\.cache\.delete\(ev\.thread\); reloadSoon\(ev\.thread\); \}/);
  });

  it('says how long a request stays open', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const left = (ms) => timeLeft(new Date(now + ms).toISOString(), now);
    assert.equal(left(30 * 1000), 'under a minute');
    assert.equal(left(25 * 60 * 1000), '25m');
    assert.equal(left(23 * 60 * 60 * 1000), '23h');
    assert.equal(left(47 * 60 * 60 * 1000), '47h');
    assert.equal(left(3 * 24 * 60 * 60 * 1000), '3d');
  });

  it('sits between the reply box and the draft\'s line, in every reply box', () => {
    assert.match(js, /const LINES = `\$\{BASH_LINE\}\$\{DRAFT_LINE\}`;/);
    assert.equal(js.match(/\$\{LINES\}<\/div>`/g).length, 5);
    assert.doesNotMatch(js, /\$\{DRAFT_LINE\}<\/div>/);
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.bashbar \{ flex-basis: 100%;/);
    assert.match(css, /\.bashbar\[hidden\] \{ display: none; \}/);
  });

  it('never scrolls sideways: on a phone a decided card is as wide as the bar, and cuts its command', () => {
    // A long command on one line made the bar scroll sideways on an iPhone: stacked, the card's
    // lines were as wide as their text (align-items: baseline), not as the card.
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.bashbar \{[^}]*overflow: hidden auto;/);
    assert.match(css, /\.bashbar \.br:not\(\.pending\) \.cmd \{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
    const narrow = css.slice(css.indexOf('@container bash (max-width: 560px)'));
    // A grid whose first column can shrink: the command, on its own row, is cut at the card's
    // width.
    assert.match(narrow, /\.bashbar \.br:not\(\.pending\) \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(narrow, /\.bashbar \.br:not\(\.pending\) \.cmd \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
    // A field is never wider than a narrow card, and no wider than a line of text reads well.
    assert.match(css, /\.bashbar \.vars \{[^}]*repeat\(auto-fit, minmax\(min\(100%, calc\(var\(--spectrum-spacing-100\) \* 30\)\), calc\(var\(--spectrum-spacing-100\) \* 70\)\)\)/);
    // A waiting card's command wraps, also inside a word.
    assert.match(css, /\.bashbar \.cmd \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere;/);
  });

  it('stands a card\'s first line, and a decided card\'s command, on one baseline', () => {
    // The command, in another font, and the earlier ones' button sat 4px lower than how the
    // request stands: the line's baseline was its icon's bottom edge, not its text's.
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.bashbar \.head \{ display: flex; align-items: baseline;/);
    assert.match(css, /\.bashbar \.what \{ flex: none; display: inline-flex; align-items: baseline;/);
    assert.match(css, /\.bashbar \.what svg \{ flex: none; align-self: center; \}/);
    assert.match(css, /\.bashbar \.br:not\(\.pending\) \{ flex-direction: row; align-items: baseline;/);
  });

  it('keeps Deny and Run in sight while a tall card scrolls', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.bashbar \.foot \{ position: sticky; bottom: 0;/);
    // With the card's own fill, or what scrolls under them shows through.
    assert.match(css, /\.spectrum \.bashbar \.foot \{ background: inherit;/);
    // On a phone only the buttons stay: the note runs with the card.
    const narrow = css.slice(css.indexOf('@container bash (max-width: 560px)'));
    assert.match(narrow, /\.bashbar \.foot \{ display: contents; \}\n\s+\.bashbar \.acts \{ position: sticky; bottom: 0;/);
    assert.match(css, /\.spectrum \.bashbar \.acts \{ background: inherit; \}/);
  });
});

describe('values remembered on this device', () => {
  /** IndexedDB as far as the vault goes: one database with object stores of keys. */
  function fakeIndexedDb() {
    const stores = new Map();
    const settle = (run) => {
      const req = {};
      queueMicrotask(() => {
        try {
          req.result = run();
          req.onsuccess?.();
        } catch (e) {
          req.error = e;
          req.onerror?.();
        }
      });
      return req;
    };
    const db = {
      createObjectStore: (name) => stores.set(name, new Map()),
      close: () => {},
      transaction: (name) => ({
        objectStore: () => ({
          get: (key) => settle(() => stores.get(name).get(key)),
          add: (value, key) => settle(() => {
            if (stores.get(name).has(key)) {
              throw new Error('exists');
            }
            stores.get(name).set(key, value);
          }),
        }),
      }),
    };
    return {
      stores,
      open: () => {
        const req = settle(() => {
          if (!stores.size) {
            req.result = db;
            req.onupgradeneeded?.();
          }
          return db;
        });
        return req;
      },
    };
  }
  function page(indexedDB = fakeIndexedDb(), items = new Map(), crypto = globalThis.crypto) {
    const localStorage = {
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => items.set(k, String(v)),
    };
    const fns = piece('const VAULT =', '// What is typed into a request', 'vault, vaultLoad, vaultKeep, vaultForget', {
      indexedDB, localStorage, crypto,
    });
    return { ...fns, items, indexedDB };
  }

  it('are encrypted in localStorage, with a key that cannot be exported', async () => {
    const first = page();
    await first.vaultLoad();
    assert.equal(first.vault.values.size, 0);
    // Nothing remembered: no key is made, or looked for, just to find that out.
    assert.equal(first.indexedDB.stores.size, 0);

    await first.vaultKeep({ API_TOKEN: 'made-up-token-123', API_USER: 'dana' });
    assert.equal(first.vault.values.get('API_TOKEN'), 'made-up-token-123');
    const stored = first.items.get('opspile.bash.env');
    assert.deepEqual(Object.keys(JSON.parse(stored)), ['API_TOKEN', 'API_USER']);
    assert.ok(!stored.includes('made-up-token-123') && !stored.includes('dana'));
    assert.ok(!stored.includes(Buffer.from('made-up-token-123').toString('base64')));
    const key = first.indexedDB.stores.get('keys').get('env');
    assert.equal(key.extractable, false);
    assert.deepEqual([key.algorithm.name, key.algorithm.length], ['AES-GCM', 256]);
    await assert.rejects(crypto.subtle.exportKey('raw', key));

    // The next page reads them back with the same key.
    const next = page(first.indexedDB, first.items);
    await next.vaultLoad();
    assert.deepEqual([...next.vault.values], [['API_TOKEN', 'made-up-token-123'], ['API_USER', 'dana']]);

    next.vaultForget('API_TOKEN');
    assert.deepEqual([...next.vault.values.keys()], ['API_USER']);
    assert.deepEqual(Object.keys(JSON.parse(next.items.get('opspile.bash.env'))), ['API_USER']);
  });

  it('are read in the order they are stored, whichever is decrypted first', async () => {
    const first = page();
    await first.vaultKeep({ API_TOKEN: 'made-up-token-123', API_USER: 'dana' });
    // A busy machine: the first value's decryption finishes last.
    let waits = 2;
    const slow = {
      getRandomValues: (a) => crypto.getRandomValues(a),
      subtle: {
        decrypt: async (...args) => {
          waits -= 1;
          await new Promise((resolve) => {
            setTimeout(resolve, waits * 20);
          });
          return crypto.subtle.decrypt(...args);
        },
      },
    };
    const next = page(first.indexedDB, first.items, slow);
    await next.vaultLoad();
    assert.deepEqual([...next.vault.values.keys()], ['API_TOKEN', 'API_USER']);
  });

  it('forget a value whose key is gone, and one put in another variable\'s place', async () => {
    const first = page();
    await first.vaultKeep({ API_TOKEN: 'made-up-token-123', API_USER: 'dana' });
    // Another browser profile's storage, without its key: nothing decrypts.
    const other = page(fakeIndexedDb(), new Map(first.items));
    await other.vaultLoad();
    assert.equal(other.vault.values.size, 0);
    // A value is sealed with its variable's name.
    const swapped = JSON.parse(first.items.get('opspile.bash.env'));
    const items = new Map([['opspile.bash.env', JSON.stringify({ API_USER: swapped.API_TOKEN })]]);
    const moved = page(first.indexedDB, items);
    await moved.vaultLoad();
    assert.equal(moved.vault.values.size, 0);
  });
});
