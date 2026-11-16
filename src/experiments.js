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
 * (`us.anthropic.claude-sonnet-5-5#model=sonnet`, `armTags`), so the dashboard can set the arms
 * side by side (src/cogs/report.js) and the prices still find the model (`untagged`). What an
 * experiment is judged by is its `measure`: `prompt`, the cost per million prompt tokens (which
 * the arms do not change), or `drafts`, the model's cost per accepted draft (src/draftevents.js),
 * the drafts counted by the arm of their thread.
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
  measure: 'prompt',
  arms: [
    { id: 'long', label: '1-hour cache' },
    { id: 'short', label: '5-minute cache' },
  ],
  default: 'long',
};

/**
 * The agents' model: the deployed Opus (AGENT_MODEL) against Sonnet 5.5 at the same geography's
 * inference profile, from midnight UTC for two weeks, judged by the cost per accepted draft.
 * Only where AGENT_MODEL is an Opus model; outside it, every agent runs AGENT_MODEL.
 */
export const MODEL = {
  id: 'model',
  title: 'The agents\' model: Opus or Sonnet',
  from: '2026-11-17T00:00:00Z',
  until: '2026-12-01T00:00:00Z',
  measure: 'drafts',
  arms: [
    { id: 'opus', label: 'Opus 5.5' },
    { id: 'sonnet', label: 'Sonnet 5.5', model: 'claude-sonnet-5-5' },
  ],
  default: 'opus',
  applies: (env) => /(?:^|\.)anthropic\.claude-opus-/.test(String(env?.AGENT_MODEL || '')),
};

export const EXPERIMENTS = [CACHE, MODEL];

const TAG = /#([a-z0-9_-]+)=([a-z0-9_-]+)/g;

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
 * The arm the agent `name` is assigned to (`{ id, label }`), whenever it is asked, or null for
 * an agent that is not a thread's: what its drafts are counted by.
 */
export function assignedArm(experiment, name) {
  if (!name || String(name).startsWith('kb:')) {
    return null;
  }
  const { arms } = experiment;
  return arms[fnv(`${experiment.id}:${name}`) % arms.length];
}

/**
 * The arm the agent `name` is in now (`{ id, label }`), or null: outside the window, for an
 * agent that is not a thread's, and where the experiment does not apply to `env`.
 */
export function armOf(experiment, name, now = Date.now(), env = undefined) {
  if (!running(experiment, now) || (experiment.applies && !experiment.applies(env))) {
    return null;
  }
  return assignedArm(experiment, name);
}

/** The prompt cache retention the agent `name` asks for now: its arm's, or the default. */
export function cacheRetention(name, now = Date.now()) {
  const arm = armOf(CACHE, name, now);
  return arm ? arm.id : CACHE.default;
}

/**
 * The Bedrock model the agent `name` runs now instead of AGENT_MODEL, or null: its arm's, at
 * AGENT_MODEL's inference profile (`us.anthropic.claude-sonnet-5-5`).
 */
export function armModel(env, name, now = Date.now()) {
  const arm = armOf(MODEL, name, now, env);
  const geo = /^((?:[a-z]{2,6}\.)?anthropic\.)/.exec(String(env?.AGENT_MODEL || ''));
  return arm && arm.model && geo ? `${geo[1]}${arm.model}` : null;
}

/**
 * What the agent `name`'s model use is tagged with for COGS now: the arms it is in
 * (`#model=sonnet`), or ''.
 */
export function armTags(name, now = Date.now(), env = undefined) {
  return EXPERIMENTS.map((x) => [x, armOf(x, name, now, env)]).filter(([, arm]) => arm)
    .map(([x, arm]) => `#${x.id}=${arm.id}`).join('');
}

/** A metric's detail without its arms: the model, as priced. */
export const untagged = (detail) => String(detail || '').replace(TAG, '');

/** The experiments and arms in a metric's detail: `[{ experiment, arm, detail }]`. */
export function tagsOf(detail) {
  const plain = untagged(detail);
  return [...String(detail || '').matchAll(TAG)]
    .map((m) => ({ experiment: m[1], arm: m[2], detail: plain }));
}

/** The first experiment and arm in a metric's detail (`tagsOf`), or null. */
export const tagOf = (detail) => tagsOf(detail)[0] || null;
