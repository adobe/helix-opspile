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

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { fitImages } from './images.js';

/**
 * The agents' model: Claude on Amazon Bedrock, through Cloudflare AI Gateway. Bedrock's
 * `bedrock-runtime` endpoint speaks the Anthropic Messages API at `/anthropic` and accepts a
 * Bedrock API key as `Authorization: Bearer`; AI Gateway passes it through, with a Cloudflare
 * token in `cf-aig-authorization` when the gateway is authenticated. (`bedrock-mantle` speaks
 * the same API, but does not serve the newest Claude models in every region.) Newer Claude
 * models run only through an inference profile, so AGENT_MODEL is a profile id such as
 * `us.anthropic.claude-opus-5-5`.
 *
 * https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html
 * https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/
 */

export const PROVIDER = 'opspile-bedrock';
const DEFAULT_REGION = 'us-east-2';

/** Why agents cannot run with this environment, or null. */
export function modelProblem(env) {
  const needed = env.AGENT_BASE_URL ? ['AGENT_MODEL', 'BEDROCK_API_KEY']
    : ['AI_GATEWAY_ACCOUNT', 'AGENT_GATEWAY', 'AGENT_MODEL', 'BEDROCK_API_KEY'];
  const missing = needed.filter((name) => !env[name]);
  return missing.length ? `missing ${missing.join(', ')}` : null;
}

/**
 * AI Gateway's base URL for Anthropic-native requests to Bedrock. AGENT_BASE_URL replaces it,
 * for a local stand-in during development.
 */
export function gatewayBaseUrl(env) {
  if (env.AGENT_BASE_URL) {
    return env.AGENT_BASE_URL;
  }
  const region = env.AGENT_REGION || DEFAULT_REGION;
  return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT}/${env.AGENT_GATEWAY}`
    + `/aws-bedrock/bedrock-runtime/${region}/anthropic`;
}

/** pi-ai's catalog entry for the Claude model behind a Bedrock id, if it knows it. */
export function catalogEntry(bedrockId) {
  const id = String(bedrockId || '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '');
  return ANTHROPIC_MODELS[id] || null;
}

/**
 * The model as pi-ai describes it: what pi-ai knows about the Claude model (adaptive
 * thinking, limits, prices, prompt caching), at Bedrock's address.
 */
export function agentModel(env, id = env.AGENT_MODEL) {
  const known = catalogEntry(id);
  return {
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    },
    ...(known || {}),
    id,
    name: known ? `${known.name} (Bedrock)` : id,
    api: 'anthropic-messages',
    provider: PROVIDER,
    baseUrl: gatewayBaseUrl(env),
    ...(Number(env.AGENT_CONTEXT_WINDOW)
      ? { contextWindow: Number(env.AGENT_CONTEXT_WINDOW) } : {}),
    ...(Number(env.AGENT_MAX_TOKENS) ? { maxTokens: Number(env.AGENT_MAX_TOKENS) } : {}),
    // AGENT_ANTHROPIC_BETA overrides the beta features pi asks for (`none`: none at all), in
    // case an endpoint refuses one.
    ...(env.AGENT_ANTHROPIC_BETA ? {
      headers: { 'anthropic-beta': env.AGENT_ANTHROPIC_BETA === 'none' ? null : env.AGENT_ANTHROPIC_BETA },
    } : {}),
  };
}

/** Request headers: the Bedrock key, and the gateway token when there is one. */
export function authHeaders(env) {
  return {
    authorization: `Bearer ${env.BEDROCK_API_KEY}`,
    ...(env.AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}` } : {}),
  };
}

/**
 * The Anthropic Messages API without the images it would refuse (src/agent/images.js): one
 * in the history would fail every turn after it.
 */
export function fittingApi(api) {
  const fit = (context) => {
    let messages;
    try {
      messages = fitImages(context.messages);
    } catch {
      return context;
    }
    return messages === context.messages ? context : { ...context, messages };
  };
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, fit(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, fit(context), options),
  };
}

/**
 * Whether a failed request says the model cannot be used at all (not enabled for the account,
 * no such inference profile), rather than that this request failed: a 403, a 404, or a 400 about
 * the model identifier, before any of the answer came.
 */
export const unusableModel = (message) => /\b(?:403|404)\b|access ?denied|not (?:authorized|entitled|subscribed)|don'?t have access|(?:invalid|unknown|unsupported) model|model identifier|model (?:id )?(?:is )?not (?:found|supported|available)|marketplace/i
  .test(String(message?.errorMessage || ''));

/** How long an arm's model that could not be used is not asked again, in this isolate. */
const UNUSABLE_MS = 10 * 60 * 1000;
const unusable = new Map();

/**
 * `first()`'s stream, or `fallback()`'s when the first fails with `unusableModel` before any of
 * its answer: `onFallback(error)` is told. The other events pass as they come.
 */
export function fallbackStream(first, fallback, onFallback = () => {}) {
  const out = new AssistantMessageEventStream();
  const pipe = async (stream, { switchable }) => {
    for await (const event of stream) {
      if (switchable && event.type === 'error' && unusableModel(event.error)) {
        onFallback(event.error);
        return pipe(fallback(), { switchable: false });
      }
      // eslint-disable-next-line no-param-reassign
      switchable = false;
      out.push(event);
    }
    return out.end();
  };
  pipe(first(), { switchable: true }).catch((e) => {
    out.push({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: e.message,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
          },
        },
        timestamp: Date.now(),
      },
    });
    out.end();
  });
  return out;
}

/**
 * The API as the agent's experiment arms (src/experiments.js) have it at each request, since they
 * change while the agent runs: `retention()`, the prompt cache retention instead of the one the
 * request asks for (one that asks for none, a compaction's, keeps asking for none); `model()`, a
 * Bedrock model id to ask instead of the session's, or null. That model is asked as itself (its
 * prices and limits, and pi-ai drops the other model's thinking from the history), and a model
 * that cannot be used falls back to the session's (`fallbackStream`), for UNUSABLE_MS, logged.
 */
export function armApi(api, { env = {}, retention, model } = {}) {
  if (!retention && !model) {
    return api;
  }
  const keep = (options) => (!retention || (options && options.cacheRetention === 'none') ? options
    : { ...options, cacheRetention: retention() });
  const swap = (method) => (base, context, options) => {
    const opts = keep(options);
    const id = model ? model() : null;
    if (!id || id === base.id || (unusable.get(id) || 0) > Date.now()) {
      return api[method](base, context, opts);
    }
    return fallbackStream(
      () => api[method]({ ...agentModel(env, id), baseUrl: base.baseUrl }, context, opts),
      () => api[method](base, context, opts),
      (error) => {
        unusable.set(id, Date.now() + UNUSABLE_MS);
        console.log(JSON.stringify({
          route: 'agent', experiment: 'model unusable', model: id, fallback: base.id, error: error.errorMessage,
        }));
      },
    );
  };
  return { ...api, stream: swap('stream'), streamSimple: swap('streamSimple') };
}

/** Forgets the arms' models that could not be used (`armApi`), for tests. */
export const resetUnusable = () => unusable.clear();

/**
 * A pi-ai provider with one model, authenticated from the Worker's secrets. `cacheRetention` and
 * `model`, functions, pick each request's prompt cache retention and model (`armApi`).
 */
export function agentProvider(env, { cacheRetention, model } = {}) {
  return createProvider({
    id: PROVIDER,
    name: 'Amazon Bedrock via AI Gateway',
    auth: {
      apiKey: {
        name: 'Bedrock API key',
        resolve: async () => (env.BEDROCK_API_KEY
          ? { auth: { headers: authHeaders(env) }, source: 'BEDROCK_API_KEY' }
          : undefined),
      },
    },
    models: env.AGENT_MODEL ? [agentModel(env)] : [],
    api: armApi(fittingApi(anthropicMessagesApi()), { env, retention: cacheRetention, model }),
  });
}

/** The model reference new sessions start with. */
export const modelRef = (env) => ({ provider: PROVIDER, id: env.AGENT_MODEL });
