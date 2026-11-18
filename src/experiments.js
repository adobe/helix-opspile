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
 * experiment splits the threads afresh; in one by customer (`unit: 'org'`), by its customer's
 * slug instead, the threads and the knowledge-base agents of a customer together. Outside the
 * window no thread is in an arm. Knowledge-base agents (`kb:…`) are not threads and take no part
 * but in one by customer.
 *
 * What an agent in an arm uses is counted for COGS with the arm in the metric's detail
 * (`us.anthropic.claude-sonnet-5-5#model=sonnet`, `armTags`), so the dashboard can set the arms
 * side by side (src/cogs/report.js) and the prices still find the model (`untagged`). What an
 * experiment is judged by is its `measure`: `prompt`, the cost per million prompt tokens (which
 * the arms do not change), or `drafts`, the model's cost per accepted draft (src/draftevents.js),
 * the drafts counted by the arm their thread is pinned to. A `pinned` experiment keeps each
 * thread in its arm for good, from when its agent first starts in the window (src/agent/arms.js);
 * the others put every thread in its arm for the window only.
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
 * The agents' model: the deployed Opus (AGENT_MODEL) against Sonnet 5.5 at the same inference
 * profile (global or geo), judged by the cost per accepted draft. Only threads whose agent first
 * starts in the window take part, each pinned to its arm for good (src/agent/arms.js): no thread
 * changes model, at the window's edges or after. Only where AGENT_MODEL is an Opus model.
 */
export const MODEL = {
  id: 'model',
  title: 'The agents\' model: Opus or Sonnet',
  from: '2026-11-17T00:00:00Z',
  until: '2026-12-01T00:00:00Z',
  measure: 'drafts',
  pinned: true,
  arms: [
    { id: 'opus', label: 'Opus 5.5' },
    { id: 'sonnet', label: 'Sonnet 5.5', model: 'claude-sonnet-5-5' },
  ],
  default: 'opus',
  applies: (env) => /(?:^|\.)anthropic\.claude-opus-/.test(String(env?.AGENT_MODEL || '')),
};

/**
 * Dreaming: once a customer's channels have been quiet for 8 hours, with no dream since their
 * latest message, the customer's knowledge-base agent reviews kb-org, merges what is duplicated,
 * moves what is misfiled and resolves what contradicts itself (src/dreams.js,
 * src/agent/dream.js); against customers whose knowledge base only grows. By customer, not by
 * thread (`unit: 'org'`): a dream changes what every thread of the customer reads. Judged by the
 * cost per accepted draft, the dreams' cost included (their knowledge-base agent's model use is
 * tagged with its customer's arm, as its threads' is).
 */
export const DREAM = {
  id: 'dream',
  title: 'Dreaming: consolidating a customer\'s knowledge base when it is quiet',
  from: '2026-11-18T15:00:00Z',
  until: '2026-12-02T15:00:00Z',
  measure: 'drafts',
  unit: 'org',
  arms: [
    { id: 'off', label: 'Knowledge base as written' },
    { id: 'dream', label: 'Dreams after 8 quiet hours' },
  ],
  default: 'off',
};

export const EXPERIMENTS = [CACHE, MODEL, DREAM];

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
 * an agent that is not a thread's: what its drafts are counted by. For an experiment by customer
 * (`unit: 'org'`), `name` is the customer's slug.
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
 * The Bedrock model a thread pinned to the model experiment's `arm` (src/agent/arms.js) runs
 * instead of AGENT_MODEL, or null: the arm's, at AGENT_MODEL's inference profile, global or geo
 * (`global.anthropic.claude-opus-5-5` runs `global.anthropic.claude-sonnet-5-5`, `us.…` runs
 * `us.…`). None where AGENT_MODEL is not an Opus model.
 */
export function armModel(env, arm) {
  const def = MODEL.arms.find((a) => a.id === arm);
  const geo = /^((?:[a-z]{2,6}\.)?anthropic\.)/.exec(String(env?.AGENT_MODEL || ''));
  return def && def.model && geo && MODEL.applies(env) ? `${geo[1]}${def.model}` : null;
}

/** Who is in an experiment's arms: the agent `name`, or for one by customer its `org`. */
export const unitOf = (experiment, { name, org } = {}) => (experiment.unit === 'org' ? org || null : name);

/**
 * What the agent `name`'s model use is tagged with for COGS now: the arms it is in
 * (`#model=sonnet`), or ''. A pinned experiment's arm is the agent's pin (`pins`, by
 * experiment), whenever it is; the others' by the window, an experiment by customer's by the
 * agent's customer (`org`; a knowledge-base agent's too).
 */
export function armTags(name, now = Date.now(), env = undefined, pins = {}, org = null) {
  return EXPERIMENTS.map((x) => {
    if (!x.pinned) {
      const unit = unitOf(x, { name, org });
      return [x, unit ? armOf(x, unit, now, env)?.id : null];
    }
    return [x, pins[x.id] && (!x.applies || x.applies(env)) ? pins[x.id] : null];
  }).filter(([, arm]) => arm).map(([x, arm]) => `#${x.id}=${arm}`).join('');
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
