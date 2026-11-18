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

// The Agents SDK's search source and renderer only: `agents/websearch` imports nothing of
// `cloudflare:workers`, so this stays testable in Node (the rest of the SDK is agent.js's).
import { createAIWebSearch, renderWebSearchResults } from 'agents/websearch';

/**
 * The thread agents' `web_search` tool (src/agent/agenttools.js): Cloudflare's Web Search API,
 * through the Workers AI binding (`env.AI.websearch()`) and AI Gateway, which bills the search
 * to the account's gateway credits, or to a key of the provider's stored on the gateway.
 *
 * - WEB_SEARCH_PROVIDER: `ceramic` (the default: $0.25 per 1,000 searches, zero data
 *   retention), `linkup` (zero data retention too) or `exa`.
 * - WEB_SEARCH_GATEWAY: the gateway, in the Worker's account; default AGENT_GATEWAY, which
 *   keeps no logs (queries come from customers' threads), else the account's `default`.
 *
 * It finds pages, not their text: the agent reads them with the global browser MCP server or
 * its computer. A query leaves Adobe for the provider, so the prompt keeps the customer out of
 * it (`WEB_SEARCH` in src/agent/tools.js).
 * https://developers.cloudflare.com/web-search/
 */

export const PROVIDERS = ['ceramic', 'linkup', 'exa'];
export const DEFAULT_RESULTS = 5;
export const MAX_RESULTS = 10;
export const MAX_QUERY = 1024;
const TIMEOUT_MS = 30_000;
const DESCRIPTION_CHARS = 600;

export const providerOf = (env) => String(env.WEB_SEARCH_PROVIDER || 'ceramic').trim().toLowerCase();
export const gatewayOf = (env) => env.WEB_SEARCH_GATEWAY || env.AGENT_GATEWAY || 'default';

/** Why the agents cannot search in this deployment, or null. */
export function searchProblem(env) {
  if (!env.AI) {
    return 'The Workers AI binding (AI) is missing in this deployment.';
  }
  const provider = providerOf(env);
  if (!PROVIDERS.includes(provider)) {
    return `WEB_SEARCH_PROVIDER is ${provider}: it is one of ${PROVIDERS.join(', ')}.`;
  }
  return null;
}

/** What the agent is told when a search failed: fix the query, retry once, or go without. */
function failure(error) {
  if (error.code === 'invalid_web_search_input') {
    return `The search was refused (${String(error.message).replace(/\.$/, '')}): fix the query and search again.`;
  }
  if (error.retryable) {
    return `The search failed for now (${error.code}): you may try once more.`;
  }
  return `Web search does not work here at the moment (${error.code}): do not search again in this turn; go on without it, and say so in your note if it mattered.`;
}

/**
 * Searches the web: `{ ok: true, text, results, requestId }`, the results as the agent reads
 * them (numbered: title, address, a description cut to 600 characters), or `{ ok: false, text,
 * error: { code, status, message, requestId } }`. `signal` cancels it; it gives up after 30 s.
 */
export async function webSearch(env, { query, limit }, { signal } = {}) {
  const source = createAIWebSearch({
    binding: env.AI, gateway: gatewayOf(env), provider: providerOf(env),
  });
  const n = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(Number(limit) || DEFAULT_RESULTS)));
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await source.search(
      { query: String(query || ''), limit: n },
      { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    );
    return {
      ok: true,
      text: renderWebSearchResults(res, { maxDescriptionChars: DESCRIPTION_CHARS }),
      results: res.items.length,
      requestId: res.metadata.requestId,
    };
  } catch (e) {
    if (signal && signal.aborted) {
      throw signal.reason;
    }
    const error = timeout.aborted
      ? { code: 'web_search_timeout', status: 504, retryable: true }
      : {
        code: e.code || 'web_search_unavailable',
        status: e.status || 500,
        retryable: e.retryable ?? true,
        requestId: e.requestId,
      };
    error.message = timeout.aborted ? `no answer in ${TIMEOUT_MS / 1000} s` : String(e.message || e);
    return { ok: false, text: failure(error), error };
  }
}
