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

/**
 * Translation of threads in the inbox. Clef reads the language a thread is written in with its
 * label (`LANGUAGE_QUESTION`, `labels.language`); the page asks for a translation when that is
 * not the reader's own (the browser's language) and they did not turn it off for that language
 * (src/settings.js `translate`, `noTranslate`). A language model translates the messages, a few
 * at a time, and D1 keeps each translation (`translations`), by the hash of the body it
 * translated, so a thread is translated once per language, and an edit again.
 */

/**
 * The language model of the translations, on Workers AI. Of twelve tried on a Japanese thread
 * (docs/ARCHITECTURE.md, "Translation"), GLM-5.3 wrote the most natural English, the fastest:
 * Llama 3.3, the titles' model, translated set phrases word for word ("Please take care of
 * me"), and the reasoning models took ten seconds and more.
 */
export const TRANSLATOR = '@cf/zai-org/glm-5.3';

/**
 * The languages Clef tells apart, by ISO 639-1 code: those of the customers and colleagues the
 * inbox reads, and `other` for the rest.
 */
export const LANGUAGES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  pl: 'Polish',
  cs: 'Czech',
  tr: 'Turkish',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  other: 'Another language',
};

/** How sure Clef must be of a thread's language for the page to translate it. */
export const LANGUAGE_MIN = 0.8;

/**
 * Clef's question, asked in a call of its own (src/label.js), so that it moves none of the
 * other answers.
 */
export const LANGUAGE_QUESTION = {
  language: {
    type: 'choice',
    instructions: "Which language are this thread's messages written in, for the most part? Names,"
      + ' code, URLs and product names do not count.',
    criteria: LANGUAGES,
  },
};

/** The thread's language from Clef's answers: `{ language, p }`, or nulls. */
export function languageOf(answers) {
  const a = answers && answers.language;
  const language = a && Object.hasOwn(LANGUAGES, a.choice) ? a.choice : null;
  const p = language ? (a.probabilities?.[language] ?? a.confidence ?? null) : null;
  return { language, p: typeof p === 'number' ? p : null };
}

const NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * A language to translate into, as the page asks for it (a BCP 47 tag, `navigator.language`):
 * its primary subtag, `{ lang, name }`, or null when it is none.
 */
export function targetOf(tag) {
  const lang = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(lang)) {
    return null;
  }
  const name = LANGUAGES[lang] || NAMES.of(lang);
  return name && name !== lang ? { lang, name } : null;
}

// What one request translates at most: the rest is `more`, for the page to ask again.
export const MAX_TRANSLATE = 40;
// What one call to the model gets at most: messages and characters.
const CHUNK_MESSAGES = 12;
const CHUNK_CHARS = 6000;
// A longer message is not translated: the model's answer would not end in time.
export const MAX_SOURCE = 6000;
const TRANSLATIONS_DAYS = 90;

/** What there is to translate: words, not only links, code, mentions and emoji. */
export function translatable(body) {
  const words = String(body || '')
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
    .replace(/<[^>\s]+>|https?:\/\/\S+/g, ' ')
    .replace(/:[\w+-]+:/g, ' ')
    .replace(/@\S+/g, ' ');
  return /\p{L}{2}/u.test(words);
}

/** The hash of a body a translation is of. */
export async function sourceHash(body) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(body)));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The model's instructions, for translating into `name`. */
export function instructions(name) {
  return 'You translate the messages of a support conversation between Adobe staff and a customer'
    + ` into ${name}. You get a JSON object of messages by number, each with who wrote it (\`from\`)`
    + ' and its text in markdown. Answer with a JSON object of the same numbers only, and nothing'
    + ` before or after it: each text translated into ${name}, or null for one that is in ${name}`
    + ` already. Write it as a speaker of ${name} in business would: a set phrase of politeness`
    + ` becomes the one of ${name} it means, not a word-for-word one. Write a name in another script`
    + ` as the person writes it in ${name}: the authors are named in \`from\` (a name they sign with`
    + ' is theirs), and an honorific such as さん or 様 goes. Keep @mentions exactly as written, in'
    + ' their script, as they link to the person, and keep the markdown, the line breaks, URLs,'
    + ' code, file names, product names and :emoji: codes exactly as they are. Translate every'
    + ' sentence, also greetings, introductions, whom a message addresses and how it is signed:'
    + ' add, explain and leave out nothing.';
}

/**
 * The model's answer as `{ number: text or null }`, or null when it is no JSON object. A text
 * that is empty is no translation, and is left out.
 */
export function parseAnswer(text) {
  const s = String(text || '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to < from) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(s.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    // Some models answer in the shape they were asked in: `{ from, text }`.
    const said = v && typeof v === 'object' && !Array.isArray(v) ? v.text : v;
    if (said === null || (typeof said === 'string' && said.trim())) {
      out[k] = said;
    }
  }
  return out;
}

/** The messages in calls of at most CHUNK_MESSAGES and (but for a single one) CHUNK_CHARS. */
export function chunks(list) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const m of list) {
    if (cur.length && (cur.length >= CHUNK_MESSAGES || chars + m.body.length > CHUNK_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(m);
    chars += m.body.length;
  }
  if (cur.length) {
    out.push(cur);
  }
  return out;
}

/** One call: `{ key: text or null }` for the messages the model answered for. */
async function translateChunk(env, list, name) {
  const input = Object.fromEntries(list.map((m, i) => [String(i + 1), {
    from: m.from || 'unknown', text: m.body,
  }]));
  const chars = list.reduce((n, m) => n + m.body.length, 0);
  const res = await env.AI.run(TRANSLATOR, {
    messages: [
      { role: 'system', content: instructions(name) },
      { role: 'user', content: JSON.stringify(input) },
    ],
    // A character of Japanese can be a word of English: room for twice the characters, and for
    // what the model thinks first.
    max_tokens: Math.min(8000, 2 * chars + 1024),
    // It thinks little before it translates: a second or two a call, not ten.
    reasoning: { effort: 'low' },
    temperature: 0.2,
  });
  const text = typeof res?.response === 'string' ? res.response
    : (res?.choices?.[0]?.message?.content ?? (res?.response && JSON.stringify(res.response)));
  const answer = parseAnswer(text);
  if (!answer) {
    return {};
  }
  return Object.fromEntries(list.flatMap((m, i) => (Object.hasOwn(answer, String(i + 1))
    ? [[m.key, answer[String(i + 1)]]] : [])));
}

/**
 * The translations of `messages` (`[{ key, body, from }]`, `key` as `<thread>|<id>`, `from` the
 * author's name, which tells the model how they write it) into `to` (from
 * `targetOf`): `{ to, messages: { key: text or null } }`, null where it is in that language
 * already (or has nothing to translate), with `more` (how many are left for another request)
 * and `failed` (how many the model did not answer for; asked again next time). From D1 where it
 * has them for the same body, else from the model, and kept.
 */
export async function translateMessages(env, messages, to, now = new Date()) {
  const list = await Promise.all((messages || []).map(async (m) => ({
    key: m.key,
    body: String(m.body || ''),
    from: m.from || null,
    hash: await sourceHash(String(m.body || '')),
  })));
  const out = {};
  const ask = [];
  for (const m of list) {
    if (!translatable(m.body) || m.body.length > MAX_SOURCE) {
      out[m.key] = null;
    } else {
      ask.push(m);
    }
  }
  const { results } = ask.length ? await env.DB.prepare(`SELECT message, source, body
    FROM translations WHERE lang = ? AND message IN (SELECT value FROM json_each(?))`)
    .bind(to.lang, JSON.stringify(ask.map((m) => m.key))).all() : { results: [] };
  const kept = new Map((results || []).map((r) => [r.message, r]));
  const todo = [];
  for (const m of ask) {
    const k = kept.get(m.key);
    if (k && k.source === m.hash) {
      out[m.key] = k.body;
    } else {
      todo.push(m);
    }
  }
  const batch = todo.slice(0, MAX_TRANSLATE);
  const answers = await Promise.all(chunks(batch).map((c) => translateChunk(env, c, to.name)
    .catch((e) => {
      console.error(JSON.stringify({ route: 'translate', error: e.message, messages: c.length }));
      return {};
    })));
  const made = Object.assign({}, ...answers);
  const at = now.toISOString();
  const writes = batch.filter((m) => Object.hasOwn(made, m.key)).map((m) => {
    out[m.key] = made[m.key];
    return env.DB.prepare(`INSERT INTO translations (message, lang, source, body, model, at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (message, lang) DO UPDATE SET source = excluded.source, body = excluded.body,
        model = excluded.model, at = excluded.at`)
      .bind(m.key, to.lang, m.hash, made[m.key], TRANSLATOR, at);
  });
  if (writes.length) {
    await env.DB.batch(writes);
  }
  const failed = batch.length - writes.length;
  if (batch.length) {
    // Never the text: how many, and how it went.
    console.log(JSON.stringify({
      route: 'translate', to: to.lang, kept: ask.length - todo.length, made: writes.length, failed,
    }));
  }
  return {
    to: to.lang, messages: out, more: todo.length - batch.length, failed,
  };
}

/** Cron: translations are a cache, made again when asked for. */
export async function pruneTranslations(env, now = new Date()) {
  const before = new Date(now.getTime() - TRANSLATIONS_DAYS * 86400 * 1000).toISOString();
  const res = await env.DB.prepare('DELETE FROM translations WHERE at < ?').bind(before).run();
  return { deleted: res.meta.changes };
}
