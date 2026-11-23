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

import { agentEnabled } from './enabled.js';
import { modelProblem } from './model.js';

/**
 * The wake-ups a thread agent sets itself (`wakeup_after`, `wakeup_after_idle`): a message to
 * itself, given back to it as an input of its own once due. `after` is due at a time, whatever
 * happens in the thread; `idle` once nothing has been posted for a while, counted from when it
 * was set and again from every message after it, the agent's own posts too (`rearmIdle`, at
 * the same points as the wrap-up). Each wakes it once.
 *
 * `agent` is the ThreadAgent (its `env`, `ctx.storage`, `schedule`, `cancelSchedule`, `target`,
 * `syncTools`, `syncMcp` and `harness`); these functions are its `setWakeup`, `wakeupDue` and
 * what delivery calls, kept here so they run in Node tests. The ones waiting are `wakeups` in
 * its storage: `[{ id, kind, message, set, due, seconds?, mark?, schedule }]`.
 */

export const MAX_WAKEUPS = 5;
export const MAX_WAKEUP_MESSAGE = 1000;
const MINUTE = 60;
export const MIN_WAKEUP_SECONDS = MINUTE;
export const MAX_WAKEUP_SECONDS = 7 * 24 * 60 * MINUTE;
const UNITS = {
  m: MINUTE, min: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE,
};
const KEY = 'wakeups';

/** `seconds` in the largest unit that has no remainder: 90m, 4h, 2d. */
export function spanText(seconds) {
  const [unit, size] = [['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m]]
    .find(([, s]) => seconds % s === 0) || ['m', UNITS.m];
  return `${Math.round(seconds / size)}${unit}`;
}

/**
 * How long from `now` a wake-up is: `{ seconds }` for `input`, a duration (`30m`, `4h`, `2d`),
 * or with `time` an ISO 8601 time too; or `{ error }`. At least a minute, at most 7 days.
 */
export function parseAfter(input, now = new Date(), { time = false } = {}) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  const span = /^(\d{1,5})\s*(m|min|h|d)$/i.exec(text);
  let seconds = span ? Number(span[1]) * UNITS[span[2].toLowerCase()] : NaN;
  if (!span && time && /^\d{4}-\d\d-\d\dT/.test(text)) {
    seconds = Math.ceil((Date.parse(text) - now.getTime()) / 1000);
  }
  if (!Number.isFinite(seconds)) {
    return {
      error: time
        ? 'give `after` as a duration from now (30m, 4h, 2d) or an ISO 8601 time'
        : 'give `after` as a duration (30m, 4h, 2d)',
    };
  }
  if (seconds < MIN_WAKEUP_SECONDS) {
    return { error: `a wake-up has to be at least a minute from now (it is ${now.toISOString()})` };
  }
  if (seconds > MAX_WAKEUP_SECONDS) {
    return { error: 'a wake-up can be at most 7 days from now' };
  }
  return { seconds };
}

const listOf = async (agent) => (await agent.ctx.storage.get(KEY)) || [];

const save = (agent, list) => (list.length
  ? agent.ctx.storage.put(KEY, list) : agent.ctx.storage.delete(KEY));

/** A wake-up in one line, for the agent. */
export function wakeupLine(w) {
  const when = w.kind === 'idle'
    ? `after ${spanText(w.seconds)} without a message (due ${w.due} unless one comes)`
    : `at ${w.due}`;
  return `- ${w.id}, ${when}: ${w.message.replace(/\s+/g, ' ').slice(0, 120)}`;
}

/**
 * `wakeup_after` (`kind` 'after') and `wakeup_after_idle` ('idle'): stores the wake-up and arms
 * its schedule. Resolves to `{ wakeup, others }` (the ones that were waiting already) or
 * `{ error }`.
 */
export async function setWakeup(agent, kind, args, now = new Date()) {
  const t = await agent.target();
  if (!t.key) {
    return { error: 'You have no thread to wake up in.' };
  }
  const message = String((args && args.message) || '').trim();
  if (!message) {
    return { error: 'Give the message you want to be woken with. Nothing was set.' };
  }
  if (message.length > MAX_WAKEUP_MESSAGE) {
    return { error: `The message is ${message.length} characters; at most ${MAX_WAKEUP_MESSAGE}. Nothing was set.` };
  }
  const after = parseAfter(args && args.after, now, { time: kind === 'after' });
  if (after.error) {
    return { error: `${after.error}. Nothing was set.` };
  }
  const others = await listOf(agent);
  if (others.length >= MAX_WAKEUPS) {
    return {
      error: `${MAX_WAKEUPS} of your wake-ups are waiting already, so nothing was set:\n${others.map(wakeupLine).join('\n')}`,
    };
  }
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const due = new Date(now.getTime() + after.seconds * 1000).toISOString();
  const wakeup = {
    id, kind, message, set: now.toISOString(), due,
  };
  if (kind === 'idle') {
    wakeup.seconds = after.seconds;
    wakeup.mark = (await agent.ctx.storage.get('mark')) || null;
    wakeup.schedule = (await agent.schedule(after.seconds, 'wakeupDue', { id, mark: wakeup.mark })).id;
  } else {
    wakeup.schedule = (await agent.schedule(new Date(due), 'wakeupDue', { id })).id;
  }
  await save(agent, [...others, wakeup]);
  console.log(JSON.stringify({
    route: 'agent', wakeup: 'set', kind, seconds: after.seconds, team: t.team,
  }));
  return { wakeup, others };
}

/**
 * A message after `mark`, the agent's own too: the idle wake-ups count from it again. Armed
 * before the mark moves, as the wrap-up is (src/agent/delivery.js).
 */
export async function rearmIdle(agent, mark, now = new Date()) {
  const list = await listOf(agent);
  if (!list.some((w) => w.kind === 'idle' && w.mark !== mark)) {
    return;
  }
  const next = [];
  for (const w of list) {
    if (w.kind !== 'idle' || w.mark === mark) {
      next.push(w);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await agent.cancelSchedule(w.schedule).catch(() => false);
      // eslint-disable-next-line no-await-in-loop
      const s = await agent.schedule(w.seconds, 'wakeupDue', { id: w.id, mark });
      next.push({
        ...w, mark, schedule: s.id, due: new Date(now.getTime() + w.seconds * 1000).toISOString(),
      });
    }
  }
  await save(agent, next);
}

/** What the agent is told when wake-up `w` is due. */
export function wakeupText(w) {
  const how = w.kind === 'idle'
    ? `with wakeup_after_idle at ${w.set}: nothing has been posted in the thread for ${spanText(w.seconds)}`
    : `with wakeup_after at ${w.set}, for ${w.due}`;
  return `A wake-up you set yourself is due (wake-up ${w.id}, set ${how}). Your message to yourself:`
    + `\n<wakeup>\n${w.message}\n</wakeup>\n\nLook at the thread as it is now. If what the message`
    + ' asks still needs doing, do it; if it was done or overtaken meanwhile, change nothing and'
    + ' say so in your note.';
}

/**
 * ThreadAgent.wakeupDue, the schedule callback: tells the agent its message, once, unless the
 * wake-up is gone, an idle one was counted again from a later message, or the agent was turned
 * off since (then it is dropped).
 */
export async function wakeupDue(agent, payload) {
  const list = await listOf(agent);
  const w = payload && list.find((x) => x.id === payload.id);
  if (!w || (w.kind === 'idle' && payload.mark !== w.mark)) {
    return { result: 'skip', reason: 'not this one' };
  }
  await save(agent, list.filter((x) => x.id !== w.id));
  const { env } = agent;
  const t = await agent.target();
  if (!t.key || modelProblem(env) || !await agentEnabled(env, t.channelId, t.team)) {
    return { result: 'skip', reason: 'no agent' };
  }
  await agent.syncTools();
  await agent.syncMcp();
  await agent.harness.submit(wakeupText(w), { operationId: `wakeup:${w.id}`, whenBusy: 'followUp' });
  console.log(JSON.stringify({
    route: 'agent', wakeup: 'due', kind: w.kind, team: t.team,
  }));
  return { result: 'told' };
}
