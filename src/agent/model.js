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
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';

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
export function agentModel(env) {
  const known = catalogEntry(env.AGENT_MODEL);
  return {
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    },
    ...(known || {}),
    id: env.AGENT_MODEL,
    name: known ? `${known.name} (Bedrock)` : env.AGENT_MODEL,
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

/** A pi-ai provider with one model, authenticated from the Worker's secrets. */
export function agentProvider(env) {
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
    api: anthropicMessagesApi(),
  });
}

/** The model reference new sessions start with. */
export const modelRef = (env) => ({ provider: PROVIDER, id: env.AGENT_MODEL });
