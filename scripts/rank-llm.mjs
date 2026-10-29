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
 * `npm run rank -- llm`: Claude models as more judges of Clef's games. Each is shown what Clef
 * is shown (the policy and the two threads), asked both ways round, and says which comes first,
 * how sure it is and why in a sentence. The pairs you judged come first, then a sample of the
 * rest. Bedrock, with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK) in AWS_REGION.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  POLICY, PROMPT_VERSION, pairState, random, shuffle,
} from './rank-lib.mjs';

/** The judges by name, and the models they are. `--judges name=model,…` names others. */
export const JUDGES = {
  haiku: 'global.anthropic.claude-haiku-5-5',
  sonnet: 'global.anthropic.claude-sonnet-5-5',
};

const SYSTEM = `${POLICY}\n\nAnswer with JSON only, no other text:`
  + ' {"reason": "<one sentence: what decides it>", "first": "A" or "B",'
  + ' "confidence": <0.5 to 1, how sure you are>}';

/** The probability that A comes first, and the reason, from a judge's answer. */
export function parseAnswer(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) {
    return null;
  }
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const first = String(j.first || '').trim().toUpperCase();
  if (first !== 'A' && first !== 'B') {
    return null;
  }
  const c = Math.min(1, Math.max(0.5, Number(j.confidence) || 0.5));
  return { p: first === 'A' ? c : 1 - c, reason: String(j.reason || '').slice(0, 300) };
}

function bedrock(region, token) {
  return async function ask(model, state, tries = 5) {
    const r = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        system: [{ text: SYSTEM }],
        messages: [{ role: 'user', content: [{ text: state }] }],
        // Room to think first: these models do, and only then write the answer.
        inferenceConfig: { maxTokens: 2000 },
      }),
    });
    if ((r.status === 429 || r.status >= 500) && tries > 1) {
      await new Promise((ok) => {
        setTimeout(ok, 3000 * (6 - tries));
      });
      return ask(model, state, tries - 1);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`${model}: ${r.status} ${j.message || JSON.stringify(j).slice(0, 200)}`);
    }
    const text = (j.output?.message?.content || []).map((c) => c.text || '').join('');
    const answer = parseAnswer(text);
    if (!answer) {
      throw new Error(`${model}: no answer (${j.stopReason}): ${text.slice(0, 120)}`);
    }
    return { ...answer, tokens: j.usage?.inputTokens || 0 };
  };
}

export async function readJudged(file, snap) {
  if (!existsSync(file)) {
    return [];
  }
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((x) => x.snap === snap && x.v === PROMPT_VERSION);
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await fn(items[i], i);
    }
  }));
}

export async function llm(opts, {
  threadsFile, humanFile, llmFile, readGames, readHuman,
}) {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) {
    throw new Error('set AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) and AWS_REGION');
  }
  const ask = bedrock(opts.region || process.env.AWS_REGION || 'us-east-2', token);
  const judges = opts.judges
    ? Object.fromEntries(String(opts.judges).split(',').map((x) => {
      const [name, model] = x.split('=');
      return [name, model || JUDGES[name]];
    }))
    : JUDGES;
  for (const [name, model] of Object.entries(judges)) {
    if (!model) {
      throw new Error(`no model for judge ${name}: name it, as ${name}=<model id>`);
    }
  }
  const data = JSON.parse(await readFile(threadsFile, 'utf8'));
  const snap = data.pulledAt;
  const byKey = new Map(data.threads.map((t) => [t.key, t]));
  const staff = new Map(Object.entries(data.staff || {}));
  const games = (await readGames()).filter((g) => byKey.has(g.a) && byKey.has(g.b));
  const yours = new Set((await readHuman(humanFile, snap)).map((h) => `${h.a}|${h.b}`));
  const n = opts.pairs === undefined ? 200 : Number(opts.pairs);
  // Your pairs first, so the judges can be compared with you; then others, by chance.
  const rest = shuffle(games.filter((g) => !yours.has(`${g.a}|${g.b}`)), random(5)).slice(0, n);
  const pairs = [...games.filter((g) => yours.has(`${g.a}|${g.b}`)), ...rest];
  const done = new Set((await readJudged(llmFile, snap)).map((x) => `${x.judge}|${x.a}|${x.b}`));
  const todo = Object.keys(judges).flatMap((judge) => pairs
    .filter((g) => !done.has(`${judge}|${g.a}|${g.b}`)).map((g) => ({ judge, g })));
  let tokens = 0;
  let finished = 0;
  let failed = 0;
  await pool(todo, Number(opts.concurrency) || 6, async ({ judge, g }) => {
    const model = judges[judge];
    try {
      const [ab, ba] = await Promise.all([
        ask(model, pairState(byKey.get(g.a), byKey.get(g.b), snap, staff)),
        ask(model, pairState(byKey.get(g.b), byKey.get(g.a), snap, staff)),
      ]);
      tokens += ab.tokens + ba.tokens;
      await appendFile(llmFile, `${JSON.stringify({
        v: PROMPT_VERSION,
        snap,
        judge,
        model,
        a: g.a,
        b: g.b,
        ab: ab.p,
        ba: ba.p,
        p: (ab.p + (1 - ba.p)) / 2,
        why: [ab.reason, ba.reason],
      })}\n`, { mode: 0o600 });
    } catch (e) {
      failed += 1;
      if (failed <= 3) {
        console.error(`\n${e.message}`);
      }
    }
    finished += 1;
    process.stdout.write(`\r${finished}/${todo.length} answers (${Math.round(tokens / 1000)}k tokens in)`);
  });
  process.stdout.write('\n');
  console.log(`${todo.length - failed} pairs judged by ${Object.keys(judges).join(', ')}`
    + `${failed ? `, ${failed} without an answer` : ''} → ${llmFile}`);
}
