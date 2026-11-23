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
import { createAIWebSearch, renderWebSearchResults, WebSearchError } from 'agents/websearch';

/**
 * The thread agents' `web_search` tool (src/agent/agenttools.js), through one of two services:
 *
 * - Microsoft Web IQ (`webiq`), its Web Search REST API, with the Worker secret WEBIQ_API_KEY,
 *   billed to the Azure subscription of its Web IQ resource ($7 per 1,000 searches). Each
 *   result comes with the passages of its page that answer the query.
 * - Cloudflare's Web Search API, through the Workers AI binding (`env.AI.websearch()`) and AI
 *   Gateway, which bills the search to the account's gateway credits, or to a key of the
 *   provider's stored on the gateway: `ceramic` ($0.25 per 1,000 searches, zero data
 *   retention), `linkup` (zero data retention too) or `exa`. WEB_SEARCH_GATEWAY is the gateway,
 *   in the Worker's account; default AGENT_GATEWAY, which keeps no logs (queries come from
 *   customers' threads), else the account's `default`.
 *
 * WEB_SEARCH_PROVIDER chooses; without it, `webiq` where WEBIQ_API_KEY is set, else `ceramic`.
 *
 * It finds pages, not all their text: the agent reads them with the global browser MCP server or
 * its computer. A query leaves Adobe for the provider, so the prompt keeps the customer out of
 * it (`WEB_SEARCH` in src/agent/tools.js).
 * https://learn.microsoft.com/web-iq/reference/web-search
 * https://developers.cloudflare.com/web-search/
 */

export const PROVIDERS = ['webiq', 'ceramic', 'linkup', 'exa'];
export const DEFAULT_RESULTS = 5;
export const MAX_RESULTS = 10;
// Web IQ's limit; Cloudflare's is 1,024.
export const MAX_QUERY = 1000;
const TIMEOUT_MS = 30_000;
// What the agent reads of a result: Web IQ's passages are worth more than a description.
const DESCRIPTION_CHARS = { webiq: 1500 };
const DEFAULT_DESCRIPTION_CHARS = 600;
const WEBIQ_URL = 'https://api.microsoft.ai/v3/search/web';

export const providerOf = (env) => String(env.WEB_SEARCH_PROVIDER
  || (env.WEBIQ_API_KEY ? 'webiq' : 'ceramic')).trim().toLowerCase();
export const gatewayOf = (env) => env.WEB_SEARCH_GATEWAY || env.AGENT_GATEWAY || 'default';

/** Why the agents cannot search in this deployment, or null. */
export function searchProblem(env) {
  const provider = providerOf(env);
  if (!PROVIDERS.includes(provider)) {
    return `WEB_SEARCH_PROVIDER is ${provider}: it is one of ${PROVIDERS.join(', ')}.`;
  }
  if (provider === 'webiq') {
    return env.WEBIQ_API_KEY ? null : 'The Web IQ API key (secret WEBIQ_API_KEY) is missing in this deployment.';
  }
  if (!env.AI) {
    return 'The Workers AI binding (AI) is missing in this deployment.';
  }
  return null;
}

/** Web IQ's error code (its `errorCode`) as one of the SDK's, by HTTP status. */
function webIQCode(status) {
  if (status === 400) {
    return 'invalid_web_search_input';
  }
  if (status === 401 || status === 403) {
    return 'web_search_unauthorized';
  }
  return status === 429 ? 'web_search_rate_limited' : 'web_search_unavailable';
}

/**
 * A search source (as the SDK's `createAIWebSearch`) on Microsoft Web IQ's Web Search API:
 * `search({ query, limit }, { signal })` resolves to `{ items, metadata }`, throws a
 * WebSearchError. Each search that answered is counted for COGS (`env.meter`).
 */
export function createWebIQSearch(env, { fetch: fetchFn } = {}) {
  const search = async ({ query: asked, limit }, { signal } = {}) => {
    const query = String(asked || '').trim();
    if (!query || query.length > MAX_QUERY) {
      throw new WebSearchError(query ? `Query must be at most ${MAX_QUERY} characters.` : 'Query must not be empty.', {
        status: 400, code: 'invalid_web_search_input',
      });
    }
    const res = await (fetchFn || fetch)(WEBIQ_URL, {
      method: 'POST',
      signal,
      headers: { 'x-apikey': env.WEBIQ_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        query, maxResults: limit, contentFormat: 'passage', maxLength: DESCRIPTION_CHARS.webiq,
      }),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // An answer that is not JSON: its status says what went wrong.
    }
    if (!res.ok || !body) {
      const e = body || {};
      const said = [e.errorCode, e.technicalDetails || e.userMessage].filter(Boolean).join(': ');
      throw new WebSearchError(said || `Web IQ answered HTTP ${res.status}.`, {
        status: res.status,
        code: res.ok ? 'web_search_unavailable' : webIQCode(res.status),
        // Its `UserError`s (a key, the day's quota, the query) do not go away by asking again,
        // but for a throttle; an answer that is not one (a 200 that is not JSON) may.
        retryable: e.errorCode === 'AuthUserDailyUsageExceeded' ? false
          : res.ok || res.status === 429 || (e.errorCategory
            ? e.errorCategory === 'SystemError' : res.status >= 500),
        requestId: e.requestId || e.traceId,
      });
    }
    env.meter?.add('web_search', 'webiq', '', 1);
    const items = (Array.isArray(body.webResults) ? body.webResults : [])
      .filter((r) => r && typeof r.url === 'string' && r.url)
      .map((r) => ({
        url: r.url,
        title: String(r.title || ''),
        description: r.content || undefined,
        lastModifiedDate: r.lastUpdatedAt || undefined,
      }));
    return { items, metadata: { query, requestId: body.traceId } };
  };
  return { search, provider: 'webiq' };
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
 * them (numbered: title, address, a description cut to 600 characters, Web IQ's passages to
 * 1,500), or `{ ok: false, text,
 * error: { code, status, message, requestId } }`. `signal` cancels it; it gives up after 30 s.
 * `fetch` is Web IQ's (tests).
 */
export async function webSearch(env, { query, limit }, { signal, fetch: fetchFn } = {}) {
  const provider = providerOf(env);
  const source = provider === 'webiq' ? createWebIQSearch(env, { fetch: fetchFn }) : createAIWebSearch({
    binding: env.AI, gateway: gatewayOf(env), provider,
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
      text: renderWebSearchResults(res, {
        maxDescriptionChars: DESCRIPTION_CHARS[provider] || DEFAULT_DESCRIPTION_CHARS,
      }),
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
