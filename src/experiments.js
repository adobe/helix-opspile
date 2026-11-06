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
 * Experiments on the thread agents: for a fixed window, each thread is in one arm, by a hash of
 * its agent's name salted with the experiment's id, so a thread stays in its arm and a new
 * experiment splits the threads afresh. Outside the window no thread is in an arm. Knowledge-base
 * agents (`kb:…`) are not threads and take no part.
 *
 * What an agent in an arm uses is counted for COGS with the arm in the metric's detail
 * (`us.anthropic.claude-opus-5-5#cache=short`, `armTag`), so the dashboard can set the arms side
 * by side (src/cogs/report.js) and the prices still find the model (`untagged`).
 */

/**
 * The prompt cache's retention: pi's `long` (one hour) against `short` (five minutes), from
 * midnight UTC for a week. Outside it, every agent asks for `long`.
 */
export const CACHE = {
  id: 'cache',
  title: 'Prompt cache: one hour or five minutes',
  from: '2026-11-07T00:00:00Z',
  until: '2026-11-14T00:00:00Z',
  arms: [
    { id: 'long', label: '1-hour cache' },
    { id: 'short', label: '5-minute cache' },
  ],
  default: 'long',
};

export const EXPERIMENTS = [CACHE];

const TAG = /#([a-z0-9_-]+)=([a-z0-9_-]+)$/;

/** FNV-1a, 32 bits: the same number for the same text everywhere. */
/* eslint-disable no-bitwise */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
/* eslint-enable no-bitwise */

/** Whether `now` is inside the experiment's window. */
export const running = (experiment, now = Date.now()) => now >= Date.parse(experiment.from)
  && now < Date.parse(experiment.until);

/**
 * The arm the agent `name` is in (`{ id, label }`), or null: outside the window, and for an
 * agent that is not a thread's.
 */
export function armOf(experiment, name, now = Date.now()) {
  if (!name || String(name).startsWith('kb:') || !running(experiment, now)) {
    return null;
  }
  const { arms } = experiment;
  return arms[fnv(`${experiment.id}:${name}`) % arms.length];
}

/** The prompt cache retention the agent `name` asks for now: its arm's, or the default. */
export function cacheRetention(name, now = Date.now()) {
  const arm = armOf(CACHE, name, now);
  return arm ? arm.id : CACHE.default;
}

/** What the agent `name`'s model use is tagged with for COGS now: `#cache=short`, or ''. */
export function armTag(name, now = Date.now()) {
  const arm = armOf(CACHE, name, now);
  return arm ? `#${CACHE.id}=${arm.id}` : '';
}

/** A metric's detail without its arm: the model, as priced. */
export const untagged = (detail) => String(detail || '').replace(TAG, '');

/** The experiment and arm in a metric's detail (`{ experiment, arm, detail }`), or null. */
export function tagOf(detail) {
  const m = TAG.exec(String(detail || ''));
  return m ? { experiment: m[1], arm: m[2], detail: untagged(detail) } : null;
}
