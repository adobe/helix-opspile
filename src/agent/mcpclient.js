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

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import { unseal } from '../post.js';
import { globalConnection, globalServersFor } from './globals.js';

/**
 * The MCP servers configured for a team or an org (`mcp_servers`, migration 0023), and the
 * global ones turned on for the team or the channel (src/agent/globals.js), and talking to
 * them: Streamable HTTP with the official client, request headers (credentials) from D1,
 * sealed with TOKEN_KEY. Used by the thread agents (src/agent/mcp.js) and by the knowledge-base
 * editor's check (src/mcpadmin.js).
 *
 * No standing connection: the client's GET stream for server-sent notifications is answered
 * with 405 (no stream) right here, so a Durable Object with a client is not kept awake by it.
 */

export const CLIENT_INFO = { name: 'opspile-agent', version: '1.0.0' };
export const MAX_TOOLS = 200;
const CONNECT_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 120_000;

/**
 * The enabled servers of a team and an org, team first, then the global servers on for the
 * team or the channel; without their headers.
 */
export async function serversFor(env, { team, org, channelId }) {
  const { results } = await env.DB.prepare(`SELECT id, scope, slug, name, url, description, allow,
      updated_at FROM mcp_servers
    WHERE enabled = 1 AND ((scope = 'team' AND slug = ?) OR (scope = 'org' AND slug = ?))
    ORDER BY CASE scope WHEN 'team' THEN 0 ELSE 1 END, name`).bind(team || '', org || '').all();
  return [...(results || []), ...await globalServersFor(env, { team, channelId })];
}

/**
 * One server with its request headers, unsealed; null when it is gone or disabled. A global
 * server (`global:<key>`) is connected as `agent`, whose browser box it uses.
 */
export async function serverWithHeaders(env, id, { agent } = {}) {
  if (String(id).startsWith('global:')) {
    return globalConnection(env, id, { agent });
  }
  const row = await env.DB.prepare(`SELECT id, scope, slug, name, url, headers, updated_at
    FROM mcp_servers WHERE id = ? AND enabled = 1`).bind(id).first();
  if (!row) {
    return null;
  }
  return { ...row, headers: row.headers ? JSON.parse(await unseal(env, row.headers)) : {} };
}

/** The tool names a server's `allow` lets agents call; null for all of them. */
export function allowList(allow) {
  const names = String(allow || '').split(/[\s,]+/).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** fetch for the transport: no standing GET stream, everything else as is. */
function noStream(fetchFn) {
  return (url, init = {}) => {
    if (String(init.method || 'GET').toUpperCase() === 'GET') {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    return fetchFn(url, init);
  };
}

/** A connected client for `{ url, headers, fetch? }`: a server's own fetch wins. */
export async function connect(server, { fetch: fetchFn = globalThis.fetch } = {}) {
  const client = new Client(CLIENT_INFO, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: noStream(server.fetch || fetchFn),
    requestInit: { headers: server.headers || {} },
  });
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to ${server.name || server.url}`);
  return client;
}

/** Every tool of a connected server, up to MAX_TOOLS. */
export async function listTools(client) {
  const tools = [];
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await withTimeout(client.listTools(cursor ? { cursor } : {}), CONNECT_TIMEOUT_MS, 'listing tools');
    tools.push(...(page.tools || []));
    cursor = page.nextCursor;
  } while (cursor && tools.length < MAX_TOOLS);
  return tools.slice(0, MAX_TOOLS);
}

/**
 * Connects, lists the tools and disconnects: `{ tools, instructions, server }` (the server's
 * name and version as it reports them), or `{ error }`.
 */
export async function probe(server, options = {}) {
  let client;
  try {
    client = await connect(server, options);
    const tools = await listTools(client);
    const version = client.getServerVersion() || {};
    return {
      tools,
      instructions: client.getInstructions() || null,
      server: { name: version.name || null, version: version.version || null },
    };
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    await client?.close().catch(() => {});
  }
}

/** Calls one tool on a connected client. */
export function callTool(client, name, args, signal) {
  return client.callTool({ name, arguments: args || {} }, { signal, timeout: CALL_TIMEOUT_MS });
}
