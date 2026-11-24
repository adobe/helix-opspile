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
import { api } from '../src/api.js';
import { render } from '../src/channels.js';
import {
  chunks, LANGUAGE_QUESTION, LANGUAGES, languageOf, MAX_TRANSLATE, parseAnswer, pruneTranslations,
  targetOf, translatable, translateMessages, TRANSLATOR,
} from '../src/translate.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, threads and messages only.
const AT = '2026-10-21T10:00:00Z';
const NOW = new Date('2026-10-22T10:00:00Z');
const EN = targetOf('en-US');

/** A model that "translates" by marking each message, and records what it was asked. */
function model(answer = (input) => Object.fromEntries(Object.entries(input)
  .map(([k, v]) => [k, /[ぁ-ん]/.test(v) ? `EN: ${v}` : null]))) {
  const calls = [];
  return {
    calls,
    AI: {
      async run(name, { messages }) {
        const input = JSON.parse(messages[1].content);
        calls.push({ name, system: messages[0].content, input });
        const out = answer(input);
        return { response: typeof out === 'string' ? out : JSON.stringify(out) };
      },
    },
  };
}

describe('translation', () => {
  it('asks Clef for the language, as a choice of codes, and reads its answer', () => {
    assert.deepEqual(Object.keys(LANGUAGE_QUESTION), ['language']);
    assert.equal(LANGUAGE_QUESTION.language.type, 'choice');
    assert.equal(LANGUAGE_QUESTION.language.criteria, LANGUAGES);
    assert.ok(Object.keys(LANGUAGES).every((l) => /^(?:[a-z]{2}|other)$/.test(l)));
    assert.deepEqual(languageOf({
      language: { choice: 'ja', probabilities: { ja: 0.97, en: 0.01 }, confidence: 0.93 },
    }), { language: 'ja', p: 0.97 });
    assert.deepEqual(languageOf({ language: { choice: 'ja', confidence: 0.9 } }), { language: 'ja', p: 0.9 });
    // Not asked, or not one of the choices: no language.
    assert.deepEqual(languageOf({}), { language: null, p: null });
    assert.deepEqual(languageOf({ language: { choice: 'klingon' } }), { language: null, p: null });
  });

  it('translates into the primary subtag of a browser language', () => {
    assert.deepEqual(targetOf('en-US'), { lang: 'en', name: 'English' });
    assert.deepEqual(targetOf('de_CH'), { lang: 'de', name: 'German' });
    assert.deepEqual(targetOf('HU'), { lang: 'hu', name: 'Hungarian' });
    for (const tag of [null, '', 'english', '1', 'en us', 'zz']) {
      assert.equal(targetOf(tag), null, String(tag));
    }
  });

  it('has nothing to translate in links, code, mentions and emoji', () => {
    assert.equal(translatable('https://example.com/a :+1: `code here` @Ada'), false);
    assert.equal(translatable('```\nconst a = 1;\n```'), false);
    assert.equal(translatable('ok'), true);
    assert.equal(translatable('確認します'), true);
  });

  it('reads the model\'s JSON object, around anything it put before or after', () => {
    assert.deepEqual(parseAnswer('Here you go:\n```json\n{"1": "Hello", "2": null, "3": " "}\n```'), {
      1: 'Hello', 2: null,
    });
    assert.equal(parseAnswer('no JSON'), null);
    assert.equal(parseAnswer('{"1": '), null);
    assert.equal(parseAnswer('[1, 2]'), null);
  });

  it('asks in calls of a few messages, a long one on its own', () => {
    const m = (n) => ({ key: String(n), body: 'x'.repeat(n) });
    assert.deepEqual(chunks([m(10), m(20), m(5990), m(30)]).map((c) => c.map((x) => x.key)), [
      ['10', '20'], ['5990'], ['30'],
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({ key: String(i), body: 'hi' }));
    assert.deepEqual(chunks(many).map((c) => c.length), [12, 12, 6]);
  });

  it('translates what is not in the language, keeps it, and asks again only for an edit', async () => {
    const DB = d1();
    const { AI, calls } = model();
    const e = { DB, AI };
    const messages = [
      { key: 't|1', body: 'こんにちは' },
      { key: 't|2', body: 'Hello there' },
      { key: 't|3', body: 'https://example.com' },
    ];
    const first = await quiet(() => translateMessages(e, messages, EN, NOW));
    assert.deepEqual(first, {
      to: 'en', messages: { 't|1': 'EN: こんにちは', 't|2': null, 't|3': null }, more: 0, failed: 0,
    });
    // One call, of the two with words; told the language by its name.
    assert.deepEqual(calls.map((c) => c.input), [{ 1: 'こんにちは', 2: 'Hello there' }]);
    assert.equal(calls[0].name, TRANSLATOR);
    assert.match(calls[0].system, /into English/);
    assert.deepEqual(DB.rows('SELECT message, lang, body FROM translations ORDER BY message'), [
      { message: 't|1', lang: 'en', body: 'EN: こんにちは' },
      { message: 't|2', lang: 'en', body: null },
    ]);
    // Again: from D1, the model not asked.
    assert.deepEqual((await translateMessages(e, messages, EN, NOW)).messages, first.messages);
    assert.equal(calls.length, 1);
    // An edit is translated again; the rest stays.
    const edited = [{ key: 't|1', body: 'さようなら' }, messages[1]];
    assert.deepEqual((await quiet(() => translateMessages(e, edited, EN, NOW))).messages, {
      't|1': 'EN: さようなら', 't|2': null,
    });
    assert.deepEqual(calls.map((c) => c.input).slice(1), [{ 1: 'さようなら' }]);
    // Another language is a translation of its own.
    await quiet(() => translateMessages(e, edited, targetOf('de'), NOW));
    assert.equal(calls.length, 3);
    assert.match(calls[2].system, /into German/);
  });

  it('keeps nothing the model did not answer for, to ask again', async () => {
    const DB = d1();
    const { AI } = model(() => 'Sorry, I cannot.');
    const r = await quiet(() => translateMessages({ DB, AI }, [{ key: 't|1', body: 'こんにちは' }], EN, NOW));
    assert.deepEqual(r, {
      to: 'en', messages: {}, more: 0, failed: 1,
    });
    assert.deepEqual(DB.rows('SELECT * FROM translations'), []);
    // One that fails outright is the same.
    const failing = {
      run: async () => {
        throw new Error('overloaded');
      },
    };
    assert.equal((await quiet(() => translateMessages({ DB, AI: failing }, [{ key: 't|1', body: 'こんにちは' }], EN, NOW))).failed, 1);
  });

  it('translates at most MAX_TRANSLATE at a time, and says how many are left', async () => {
    const DB = d1();
    const { AI } = model();
    const list = Array.from({ length: MAX_TRANSLATE + 5 }, (_, i) => ({ key: `t|${i}`, body: `こんにちは ${i}` }));
    const first = await quiet(() => translateMessages({ DB, AI }, list, EN, NOW));
    assert.deepEqual([Object.keys(first.messages).length, first.more], [MAX_TRANSLATE, 5]);
    const second = await quiet(() => translateMessages({ DB, AI }, list, EN, NOW));
    assert.deepEqual([Object.keys(second.messages).length, second.more], [MAX_TRANSLATE + 5, 0]);
  });

  it('lets the cron delete translations after 90 days', async () => {
    const DB = d1();
    const add = (message, at) => DB.sqlite.prepare(`INSERT INTO translations (message, lang, source,
      body, model, at) VALUES (?, 'en', 'h', 'x', 'm', ?)`).run(message, at);
    add('t|old', '2026-07-01T00:00:00Z');
    add('t|new', '2026-10-01T00:00:00Z');
    assert.deepEqual(await pruneTranslations({ DB }, NOW), { deleted: 1 });
    assert.deepEqual(DB.rows('SELECT message FROM translations'), [{ message: 't|new' }]);
  });

  it('GET /api/translate: the thread\'s messages, by version, for whoever may see it', async () => {
    const DB = d1({
      teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'other', name: 'Other' }],
      people: [
        {
          id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
        },
        {
          id: 3, email: 'eve@staff.example', name: 'Eve', staff: 1, teams: ['other'],
        },
      ],
    });
    const KEY = 'slack:E1:C1:1.1';
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'p/1.1/', ?, ?, ?, 3, ?)`)
      .run(KEY, AT, AT, AT, AT);
    const CHANNELS = fakeBucket();
    const put = (id, meta, body) => CHANNELS.put(`p/1.1/${id}.md`, render({
      source: 'slack', thread: KEY, id, at: AT, author: { name: 'Cy', kind: 'person' }, ...meta,
    }, body));
    await put('1.1', {}, 'こんにちは');
    await put('1.2', { editedAt: '2026-10-21T11:00:00Z' }, 'Thanks');
    await put('1.3', { author: { name: 'Slack', kind: 'system' } }, 'Cy joined');
    await put('1.4', { deletedAt: AT }, '');
    const { AI, calls } = model();
    const e = { DB, AI, CHANNELS };
    const get = (who, path) => quiet(() => api(
      new Request(`https://opspile.test${path}`),
      e,
      new URL(`https://opspile.test${path}`),
      { viewer: who },
    ));
    const ada = { id: 1, email: 'ada@staff.example', teams: [{ slug: 'helix' }] };
    const eve = { id: 3, email: 'eve@staff.example', teams: [{ slug: 'other' }] };
    const res = await get(ada, `/api/translate?thread=${encodeURIComponent(KEY)}&to=en-GB`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      to: 'en',
      messages: {
        [`${KEY}|1.1`]: { text: 'EN: こんにちは', for: AT },
        [`${KEY}|1.2`]: { text: null, for: '2026-10-21T11:00:00Z' },
      },
      more: 0,
      failed: 0,
    });
    // Not the platform's notices, nor what was deleted.
    assert.deepEqual(calls.map((c) => c.input), [{ 1: 'こんにちは', 2: 'Thanks' }]);
    assert.equal((await get(eve, `/api/translate?thread=${encodeURIComponent(KEY)}&to=en`)).status, 404);
    assert.equal((await get(ada, `/api/translate?thread=${encodeURIComponent(KEY)}&to=x y`)).status, 400);
  });
});
